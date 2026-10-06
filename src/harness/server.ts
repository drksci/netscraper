/**
 * Live viewer server: serves viewer/ and fans out an event stream over WebSocket.
 *   {type:"hello", lanes, flow}            {type:"a2ui", lane, msg}       {type:"frame", lane, data}
 *   {type:"step", ...}  {type:"check", ...}  {type:"item", route, item}  {type:"done", report}
 * Clients may send {type:"action", action:<v0.9 client action>} to drive the surface (A2UI → page).
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserAdapter } from "../adapters/types.js";
import { startScreencast } from "../adapters/index.js";
import type { AnyRunner } from "../runtime/index.js";
import { MachineRunner } from "../machine/runner.js";
import type { ClientAction } from "../a2ui/types.js";

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), "../../viewer");

export interface ViewerServer {
  url: string;
  broadcast(ev: Record<string, unknown>): void;
  onAction(fn: (a: ClientAction) => void): void;
  close(): Promise<void>;
}

export function createViewerServer(port: number, hello: Record<string, unknown>): ViewerServer {
  const backlog: string[] = [];
  const lastFrame = new Map<string, string>();
  const actionHandlers: ((a: ClientAction) => void)[] = [];
  const http = createServer((req, res) => {
    const file = req.url === "/" || req.url?.startsWith("/?") ? "index.html" : (req.url ?? "").slice(1).split("?")[0];
    if (!/^[\w.-]+$/.test(file)) { res.writeHead(404).end(); return; }
    try {
      const body = readFileSync(join(VIEWER, file));
      res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "hello", ...hello }));
    for (const m of backlog) ws.send(m);
    for (const [lane, data] of lastFrame) ws.send(JSON.stringify({ type: "frame", lane, data }));
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === "action" && m.action?.action) actionHandlers.forEach((f) => f(m.action));
      } catch { /* ignore */ }
    });
  });
  http.listen(port, "127.0.0.1");
  return {
    url: `http://127.0.0.1:${port}`,
    broadcast(ev) {
      const s = JSON.stringify(ev);
      if (ev.type === "frame") lastFrame.set(String(ev.lane), String(ev.data));
      else backlog.push(s);
      for (const c of wss.clients) if (c.readyState === 1) c.send(s);
    },
    onAction(fn) { actionHandlers.push(fn); },
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
  };
}

/** Single-lane live view for `a2flow run --serve`: page screencast + A2UI render, clickable. */
export function serveRun(runner: AnyRunner, adapter: BrowserAdapter, port: number): () => Promise<void> {
  const v = createViewerServer(port, { lanes: ["A"], flow: runner.manifest.id, title: runner.manifest.title });
  runner.on("message", (msg) => v.broadcast({ type: "a2ui", lane: "A", msg }));
  runner.on("action", (a) => v.broadcast({ type: "client", lane: "A", msg: a }));
  runner.on("item", (it) => v.broadcast({ type: "item", ...it }));
  runner.on("step", (e) => v.broadcast({ type: "step", lane: "A", path: e.path, kind: e.kind, view: e.view }));
  runner.on("state", (s: any) => v.broadcast({ type: "state", value: s.value }));
  v.onAction((a) => {
    const p = runner instanceof MachineRunner ? runner.handleClientAction(a) : (runner.emit("action", a), runner.bridge.handle(a));
    p.catch((e) => v.broadcast({ type: "log", text: String(e) }));
  });
  let stop: (() => Promise<void>) | undefined;
  startScreencast(adapter, (data) => v.broadcast({ type: "frame", lane: "A", data })).then((s) => (stop = s));
  process.stderr.write(`viewer: ${v.url}\n`);
  return async () => { await stop?.(); await v.close(); };
}
