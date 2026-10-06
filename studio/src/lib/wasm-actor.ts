/**
 * In-browser ("WASM") actor: run a saved a2flow manifest's runtime inside this tab.
 *
 *   this tab ── Web Worker (/actor/actor-worker.js)
 *                 └─ QuickJS compiled to WebAssembly (/actor/quickjs-asyncify.wasm) runs /actor/a2flow-actor.js
 *                    (fallback "worker-js": the same bundle evaluated by the Worker's own JS engine — NOT wasm)
 *              ── WebSocket raw CDP ──▶ /session/actor/cdp (session server) ──▶ dedicated sandboxed headless browser
 *
 * The runtime (XState machine, policies, projector, JSONata routes) executes here; the page it drives lives
 * server-side, so every request to the target site still originates from that server browser.
 * Built by `node scripts/build-actor.mjs` (repo root).
 *
 * Events have the same shape as the server-spawned actor's SSE `actor` events, so a view can switch sources.
 */

export type ActorEventKind = "start" | "log" | "item" | "unit" | "fault" | "done" | "exit";
export interface ActorEvent { kind: ActorEventKind; line: string; route?: string; item?: unknown; at: number; code?: number }
export type WasmActorMode = "quickjs-wasm" | "worker-js";

export interface StartWasmActorOptions {
  /** e.g. `/session/artifacts/<name>`; or pass `manifest` directly. */
  manifestUrl?: string;
  manifest?: unknown;
  inputs: Record<string, unknown>;
  onEvent: (e: ActorEvent) => void;
  /** Called once the engine is actually up (may differ from the initial `mode` if QuickJS failed to load). */
  onMode?: (mode: WasmActorMode, detail: string) => void;
  /** "auto" (default): QuickJS·wasm, falling back to worker·js if QuickJS can't start. */
  engine?: "auto" | WasmActorMode;
  /** Override the target's baseUrl (e.g. a local mock). */
  baseUrl?: string;
  /** Defaults to ws(s)://<this host>/session/actor/cdp (Next rewrite → session server). */
  cdpUrl?: string;
  /** Where the built assets are served; default `/actor`. */
  assetBase?: string;
}

export interface WasmActorHandle {
  stop(): void;
  /** Engine in use. Provisional ("quickjs-wasm") until `ready` resolves; then the truth. */
  readonly mode: WasmActorMode;
  readonly ready: Promise<WasmActorMode>;
  readonly done: Promise<{ ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }>;
}

/** UI label for a mode. */
export const wasmActorModeLabel = (m: WasmActorMode) => (m === "quickjs-wasm" ? "QuickJS·wasm" : "worker·js");

export function startWasmActor(opts: StartWasmActorOptions): WasmActorHandle {
  const base = (opts.assetBase ?? "/actor").replace(/\/$/, "");
  const abs = (p: string) => new URL(p, location.href).href;
  // Next's dev rewrite doesn't forward WebSocket upgrades, so connect to the session server directly
  // (NEXT_PUBLIC_SESSION_WS overrides, e.g. wss://studio.example/actor/cdp behind a real reverse proxy).
  const cdpUrl = opts.cdpUrl ?? process.env.NEXT_PUBLIC_SESSION_WS
    ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${process.env.NEXT_PUBLIC_SESSION_PORT ?? "7801"}/actor/cdp`;
  let mode: WasmActorMode = opts.engine === "worker-js" ? "worker-js" : "quickjs-wasm";
  let exited = false;
  const emit = (e: ActorEvent) => { if (e.kind === "exit") exited = true; try { opts.onEvent(e); } catch { /* view errors don't stop the run */ } };

  const worker = new Worker(abs(`${base}/actor-worker.js`), { type: "module", name: "a2flow-actor" });
  let resolveReady!: (m: WasmActorMode) => void;
  const ready = new Promise<WasmActorMode>((r) => (resolveReady = r));
  let resolveDone!: (r: { ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }) => void;
  const done = new Promise<{ ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }>((r) => (resolveDone = r));
  const finish = (r: { ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }) => {
    if (!exited) emit({ kind: "exit", line: `■ exited ${r.ok ? 0 : 1}`, at: Date.now(), code: r.ok ? 0 : 1 });
    resolveReady(mode);
    resolveDone(r);
    worker.terminate();
  };

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m?.type === "event") emit(m.event);
    else if (m?.type === "mode") {
      mode = m.mode;
      emit({ kind: "log", line: `· engine: ${m.detail}`, at: Date.now() });
      opts.onMode?.(m.mode, m.detail);
      resolveReady(m.mode);
    } else if (m?.type === "finished") finish(m.result ?? { ok: false });
  };
  worker.onerror = (e) => { emit({ kind: "fault", line: `! worker error: ${e.message}`, at: Date.now() }); finish({ ok: false, error: e.message }); };

  void (async () => {
    try {
      const manifest: any = opts.manifest ? structuredClone(opts.manifest) : await (await fetch(opts.manifestUrl!)).json();
      if (opts.baseUrl) manifest.target = { ...manifest.target, baseUrl: opts.baseUrl };
      const name = opts.manifestUrl ? decodeURIComponent(opts.manifestUrl.split("/").pop() ?? "") : manifest.id;
      worker.postMessage({
        type: "start", manifest, inputs: opts.inputs, name, cdpUrl, mode: opts.engine ?? "auto",
        bundleUrl: abs(`${base}/a2flow-actor.js`), wasmUrl: abs(`${base}/quickjs-asyncify.wasm`),
      });
    } catch (e) {
      emit({ kind: "fault", line: `! could not load manifest: ${(e as Error).message}`, at: Date.now() });
      finish({ ok: false, error: (e as Error).message });
    }
  })();

  return {
    stop() {
      worker.postMessage({ type: "stop", reason: "stopped by user" });
      // the run ends via `finished`; if the worker is wedged, terminate (the proxy kills the browser on socket close)
      setTimeout(() => finish({ ok: false, error: "stopped" }), 3000);
    },
    get mode() { return mode; },
    ready,
    done,
  };
}
