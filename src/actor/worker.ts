/**
 * Studio Worker host for the in-browser actor (built to studio/public/actor/actor-worker.js, module worker).
 *
 *   main thread (studio/src/lib/wasm-actor.ts) ──postMessage──▶ this Worker
 *      mode "quickjs-wasm": QuickJS (quickjs-emscripten, release-asyncify wasm) runs a2flow-actor.js; this Worker
 *                           only bridges the WebSocket, timers and events (see ./quickjs-host.ts)
 *      mode "worker-js":    fallback — the same a2flow-actor.js evaluated directly by the Worker's JS engine
 *   The WebSocket goes to the session server's /actor/cdp proxy (dedicated headless browser, server-side).
 */
import { newQuickJSAsyncWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import RELEASE_ASYNC from "@jitl/quickjs-wasmfile-release-asyncify";
import { runActorInQuickJS, type HostSocket } from "./quickjs-host.js";

type Mode = "quickjs-wasm" | "worker-js";
interface StartMsg {
  type: "start"; manifest: unknown; inputs: Record<string, unknown>; name?: string;
  cdpUrl: string; bundleUrl: string; wasmUrl: string; mode?: "auto" | Mode;
}

const post = (m: unknown) => (globalThis as any).postMessage(m);
const event = (kind: string, line: string, extra: Record<string, unknown> = {}) => post({ type: "event", event: { kind, line, at: Date.now(), ...extra } });
let stopFn: ((reason?: string) => void) | undefined;
let ws: WebSocket | undefined;

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const s = new WebSocket(url);
    s.onopen = () => res(s);
    s.onerror = () => rej(new Error(`could not connect to ${url}`));
  });
}

async function startQuickJS(m: StartMsg, bundleSource: string) {
  const t = Date.now();
  const module = await newQuickJSAsyncWASMModuleFromVariant(newVariant(RELEASE_ASYNC as any, { wasmLocation: m.wasmUrl }) as any);
  post({ type: "mode", mode: "quickjs-wasm", detail: `QuickJS·wasm (quickjs-emscripten release-asyncify, wasm instantiated in ${Date.now() - t}ms)` });
  ws = await openSocket(m.cdpUrl);
  const socket: HostSocket = { send: (d) => ws!.send(d), close: () => ws!.close() };
  ws.onmessage = (e) => socket.onmessage?.(String(e.data));
  ws.onclose = (e) => socket.onclose?.(`${e.code} ${e.reason}`.trim());
  const h = await runActorInQuickJS({
    module, bundleSource, manifest: m.manifest, inputs: m.inputs, socket, name: m.name,
    onEvent: (e) => post({ type: "event", event: e }),
  });
  stopFn = (r) => h.stop(r);
  return { done: h.done };
}

async function startWorkerJs(m: StartMsg, bundleSource: string) {
  (0, eval)(bundleSource); // defines globalThis.runActor in this Worker's own JS engine
  post({ type: "mode", mode: "worker-js", detail: "worker·js (bundle evaluated by the Worker's own JS engine — not WASM)" });
  ws = await openSocket(m.cdpUrl);
  const h = (globalThis as any).runActor(m.manifest, m.inputs, ws, { name: m.name, onEvent: (e: unknown) => post({ type: "event", event: e }) });
  stopFn = (r) => h.stop(r);
  return { done: h.done.then((r: any) => ({ ok: r.ok, error: r.error, ms: r.ms, counts: Object.fromEntries(Object.entries(r.results ?? {}).map(([k, v]) => [k, (v as unknown[]).length])) })) };
}

(globalThis as any).onmessage = async (ev: MessageEvent) => {
  const m = ev.data as StartMsg | { type: "stop"; reason?: string };
  if (m.type === "stop") { if (stopFn) stopFn(m.reason); else ws?.close(); return; }
  if (m.type !== "start") return;
  const want = m.mode ?? "auto";
  try {
    const bundleSource = await (await fetch(m.bundleUrl)).text();
    let mode: Mode = want === "worker-js" ? "worker-js" : "quickjs-wasm";
    let run: { done: Promise<any> };
    if (mode === "quickjs-wasm") {
      try {
        run = await startQuickJS(m, bundleSource);
      } catch (e) {
        if (want !== "auto") throw e;
        ws?.close(); // no half-open proxy browser from the failed attempt
        event("log", `· QuickJS·wasm unavailable (${(e as Error).message}) — falling back to worker·js`);
        mode = "worker-js";
        run = await startWorkerJs(m, bundleSource);
      }
    } else run = await startWorkerJs(m, bundleSource);
    const r = await run.done;
    post({ type: "finished", result: r, mode });
  } catch (e) {
    event("fault", `! ${(e as Error).message}`);
    event("exit", "■ exited 1", { code: 1 });
    post({ type: "finished", result: { ok: false, error: (e as Error).message } });
  }
};
