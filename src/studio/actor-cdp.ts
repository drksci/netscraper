/**
 * WebSocket CDP proxy for the in-browser ("WASM") actor:  ws://127.0.0.1:7801/actor/cdp
 * (through the Studio's Next rewrite: /session/actor/cdp — Next proxies upgrades for external rewrites).
 *
 *   Studio tab (QuickJS-wasm runtime in a Worker) ──raw CDP frames──▶ this proxy ──▶ dedicated headless CloakBrowser page
 *
 * Every connection gets its own freshly launched, throwaway-profile headless browser; the client is wired to
 * that browser's single *page* target (page-scoped socket: Target.* / Browser.* are unreachable). All traffic to
 * the target site therefore originates here, from a normal browser page; the runtime only observes it (network
 * sources stay passive — nothing is replayed or forged).
 *
 * Guards: one actor browser at a time · hard runtime cap (default 15 min) · domain allow-list · file/download/
 * local-resource methods blocked · navigation limited to http(s)/about:blank · browser killed when the socket closes.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { CdpConnection, launchCloakBrowser, openWsSocket, type LaunchedBrowser } from "../adapters/cdp.js";

const ALLOWED_DOMAINS = new Set(["Page", "Runtime", "DOM", "Network", "Input", "Emulation", "Log", "Accessibility"]);
const BLOCKED_METHODS = new Set([
  "Page.setDownloadBehavior", "Page.printToPDF", "Page.setInterceptFileChooserDialog", "Page.startScreencast",
  "DOM.setFileInputFiles", "DOM.getFileInfo",
  "Network.loadNetworkResource", "Network.setRequestInterception", "Network.replayXHR", "Network.takeResponseBodyForInterceptionAsStream",
  "Runtime.compileScript", "Runtime.runScript",
]);

export interface ActorCdpOptions {
  path?: string;
  maxRuntimeMs?: number;
  headless?: boolean;
  log?: (line: string) => void;
}

/** Why a client frame is refused, or undefined if it may pass. */
export function vetCdpFrame(m: { method?: string; params?: any; sessionId?: string }): string | undefined {
  if (typeof m.method !== "string") return "malformed frame";
  if (m.sessionId) return "sessions are not available (page-scoped socket)";
  const domain = m.method.split(".")[0];
  if (!ALLOWED_DOMAINS.has(domain)) return `domain ${domain} is not available to the actor`;
  if (BLOCKED_METHODS.has(m.method)) return `${m.method} is blocked by the actor proxy`;
  if (m.method === "Page.navigate") {
    const u = String(m.params?.url ?? "");
    if (!/^https?:\/\//i.test(u) && u !== "about:blank") return `navigation to ${u.slice(0, 60)} is not allowed (http/https only)`;
  }
  return undefined;
}

interface Active { client: WebSocket; browser?: LaunchedBrowser; closing?: Promise<void>; startedAt: number }

export function attachActorCdpProxy(server: Server, opts: ActorCdpOptions = {}) {
  const path = opts.path ?? "/actor/cdp";
  const cap = opts.maxRuntimeMs ?? 15 * 60_000;
  const log = opts.log ?? ((l: string) => console.log(`[actor/cdp] ${l}`));
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let active: Active | undefined;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== path) return; // other upgrade handlers (if any) keep their paths
    wss.handleUpgrade(req, socket, head, (client) => void accept(client, url));
  });

  async function accept(client: WebSocket, url: URL) {
    if (active?.closing) await active.closing; // previous actor still shutting down: wait for it
    if (active && active.client.readyState === WebSocket.OPEN) {
      client.close(4409, "an actor browser is already running");
      return;
    }
    const me: Active = { client, startedAt: Date.now() };
    active = me;
    const early: string[] = []; // frames that arrive before the page socket is up
    let page: Awaited<ReturnType<typeof openWsSocket>> | undefined;
    let browserConn: CdpConnection | undefined;
    const reply = (id: unknown, message: string) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify({ id, error: { code: -32000, message } }));
    const forward = (raw: string) => {
      let m: any;
      try { m = JSON.parse(raw); } catch { return reply(null, "malformed frame"); }
      const why = vetCdpFrame(m);
      if (why) { log(`refused ${m.method}: ${why}`); return reply(m.id, why); }
      page!.send(raw);
    };
    const timer = setTimeout(() => { log(`runtime cap ${cap / 1000}s reached — closing`); client.close(4408, "actor runtime cap reached"); }, cap);
    const shutdown = (why: string) => (me.closing ??= (async () => {
      clearTimeout(timer);
      log(`closing (${why}) after ${((Date.now() - me.startedAt) / 1000).toFixed(1)}s`);
      try { page?.close(); } catch { /* gone */ }
      if (client.readyState === WebSocket.OPEN) client.close(1000, why.slice(0, 120));
      await me.browser?.kill(browserConn).catch(() => {});
      try { browserConn?.close(); } catch { /* gone */ }
      if (active === me) active = undefined;
    })());
    client.on("message", (d) => { const s = String(d); if (page) forward(s); else early.push(s); });
    client.on("close", () => void shutdown("client closed"));
    client.on("error", () => void shutdown("client error"));

    try {
      const w = Number(url.searchParams.get("w")) || 1280, h = Number(url.searchParams.get("h")) || 900;
      me.browser = await launchCloakBrowser({ headless: opts.headless ?? true, viewport: { width: Math.min(w, 2560), height: Math.min(h, 2560) } });
      if (me.closing) return void (await shutdown("client left during launch"));
      browserConn = new CdpConnection(await openWsSocket(me.browser.wsUrl));
      await browserConn.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
      const { targetInfos } = await browserConn.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
      if (!targetId) targetId = (await browserConn.send("Target.createTarget", { url: "about:blank" })).targetId;
      const { host } = new URL(me.browser.wsUrl);
      page = await openWsSocket(`ws://${host}/devtools/page/${targetId}`);
      page.onMessage((d) => { if (client.readyState === WebSocket.OPEN) client.send(d); });
      page.onClose?.(() => void shutdown("page target closed"));
      me.browser.proc.once("exit", () => void shutdown("browser exited"));
      log(`actor browser up (pid ${me.browser.proc.pid}, target ${targetId!.slice(0, 8)})`);
      for (const s of early.splice(0)) forward(s);
    } catch (e) {
      log(`launch failed: ${(e as Error).message}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011, `launch failed: ${(e as Error).message}`.slice(0, 120));
      await shutdown("launch failed");
    }
  }

  return {
    get busy() { return !!active; },
    async closeAll() { if (active) { active.client.close(1001, "server shutting down"); await active.closing; } wss.close(); },
  };
}
