/**
 * Zero-framework adapter: speaks the Chrome DevTools Protocol over a websocket.
 * Either launches the CloakBrowser binary with --remote-debugging-port, or attaches to any
 * existing endpoint (CloakBrowser Manager profiles, `chrome --remote-debugging-port`, browserless…).
 * The protocol logic lives in ./cdp-core.ts (no Node imports, shared with the in-browser actor bundle).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { LaunchSpec } from "./types.js";
import { CdpAdapterCore, CdpConnection, type CdpSocket } from "./cdp-core.js";

export { CdpAdapterCore, CdpConnection, type CdpSocket } from "./cdp-core.js";

/** Open a `ws` WebSocket as a CdpSocket. */
export async function openWsSocket(url: string): Promise<CdpSocket> {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  return {
    send: (d) => ws.send(d),
    onMessage: (fn) => ws.on("message", (raw) => fn(String(raw))),
    onClose: (fn) => ws.on("close", (code, reason) => fn(`${code} ${String(reason)}`.trim())),
    close: () => ws.close(),
  };
}

async function resolveWsEndpoint(endpoint: string): Promise<string> {
  if (endpoint.startsWith("ws")) return endpoint;
  const r = await fetch(new URL("/json/version", endpoint));
  return ((await r.json()) as any).webSocketDebuggerUrl;
}

export interface LaunchedBrowser {
  /** Browser-level DevTools websocket URL. */
  wsUrl: string;
  proc: ChildProcess;
  /** Graceful-then-forced shutdown + profile removal. `conn` (if given) is used for Browser.close first. */
  kill(conn?: CdpConnection): Promise<void>;
}

/** Spawn the CloakBrowser binary with a throwaway profile and wait for its DevTools endpoint. */
export async function launchCloakBrowser(spec: Pick<LaunchSpec, "headless" | "viewport" | "proxy" | "locale" | "timezone"> & { extraArgs?: string[] }): Promise<LaunchedBrowser> {
  const { ensureBinary, getDefaultStealthArgs } = await import("cloakbrowser");
  const bin = await ensureBinary();
  const profile = mkdtempSync(join(tmpdir(), "a2flow-cdp-"));
  const vp = spec.viewport ?? { width: 1280, height: 900 };
  const args = [
    ...getDefaultStealthArgs(),
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    `--window-size=${vp.width},${vp.height}`,
    ...(spec.headless ?? true ? ["--headless=new"] : []),
    ...(spec.proxy ? [`--proxy-server=${spec.proxy}`] : []),
    ...(spec.locale ? [`--lang=${spec.locale}`] : []),
    ...(spec.timezone ? [`--fingerprint-timezone=${spec.timezone}`] : []),
    ...(spec.extraArgs ?? []),
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  const cleanupProfile = () => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  let wsUrl: string;
  try {
    wsUrl = await new Promise<string>((res, rej) => {
      let buf = "";
      const t = setTimeout(() => rej(new Error("timed out waiting for DevTools endpoint")), 30_000);
      proc.stderr!.on("data", (d) => {
        buf += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) { clearTimeout(t); res(m[1]); }
      });
      proc.once("exit", (c) => rej(new Error(`browser exited (${c}) before DevTools came up`)));
    });
  } catch (e) { proc.kill("SIGKILL"); cleanupProfile(); throw e; }
  proc.stderr!.resume(); // keep draining so the child never blocks on a full pipe
  let killed: Promise<void> | undefined;
  return {
    wsUrl, proc,
    kill: (conn) => (killed ??= (async () => {
      const exited = new Promise((r) => (proc.exitCode != null || proc.signalCode != null ? r(null) : proc.once("exit", r)));
      if (conn) await Promise.race([conn.send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (proc.exitCode == null && proc.signalCode == null) { proc.kill("SIGKILL"); await exited; }
      cleanupProfile();
    })()),
  };
}

export class CdpAdapter extends CdpAdapterCore {
  static async launch(spec: LaunchSpec): Promise<CdpAdapter> {
    let launched: LaunchedBrowser | undefined;
    let wsUrl: string;
    if (spec.endpoint) wsUrl = await resolveWsEndpoint(spec.endpoint);
    else { launched = await launchCloakBrowser(spec); wsUrl = launched.wsUrl; }
    const conn = new CdpConnection(await openWsSocket(wsUrl));
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    for (const d of ["Page", "Runtime", "DOM", "Network"]) await conn.send(`${d}.enable`, {}, sessionId);
    if (spec.viewport) {
      await conn.send("Emulation.setDeviceMetricsOverride",
        { width: spec.viewport.width, height: spec.viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    }
    return new CdpAdapter(conn, sessionId, async () => {
      if (launched) await launched.kill(conn);
      else await conn.send("Target.closeTarget", { targetId }).catch(() => {});
      conn.close();
    });
  }
}
