"use client";
import { pushActorEvent, sessionApi, sessionStore } from "./session-store";

/**
 * Where the actor runs. Both sources feed the same `actor` reducer in the session store, so the terminal
 * renders identically:
 *   - "quickjs-wasm" / "worker-js": the in-browser actor from ./wasm-actor (loaded on demand, optional)
 *   - "server": POST /session/actor/run → a sandboxed headless runner on the session server, lines over SSE
 */
export type ActorMode = "quickjs-wasm" | "worker-js" | "server";
export type ActorPrefer = "browser" | "server";
export interface ActorRun { mode: ActorMode; stop: () => void }

type WasmEvent = { kind: string; line?: string; at?: number; route?: string; item?: unknown; name?: string; code?: number | null };
type WasmMode = "quickjs-wasm" | "worker-js";
/** `mode` is provisional until `ready` resolves (QuickJS may fail to start and fall back to worker-js). */
type WasmHandle = { stop: () => void; mode: WasmMode; ready?: Promise<unknown> };
type WasmModule = {
  startWasmActor: (o: { manifestUrl?: string; manifest?: unknown; inputs: Record<string, unknown>; onEvent: (e: WasmEvent) => void }) =>
    WasmHandle | Promise<WasmHandle>;
};

let wasm: Promise<WasmModule | null> | null = null;
/** The in-browser runtime, if it has been built (the module is optional until then). */
export function loadWasmActor(): Promise<WasmModule | null> {
  return (wasm ??= (async () => {
    try {
      // @ts-ignore -- optional module, may not exist yet
      const m = (await import(/* turbopackOptional: true */ "./wasm-actor")) as Partial<WasmModule>;
      return typeof m.startWasmActor === "function" ? (m as WasmModule) : null;
    } catch {
      return null;
    }
  })());
}

export const MODE_LABEL: Record<ActorMode, string> = {
  "quickjs-wasm": "QuickJS·wasm in this tab · page via sandboxed server browser",
  "worker-js": "worker·js in this tab · page via sandboxed server browser",
  server: "server · headless runner (server-side, sandboxed)",
};

export async function startActor({ name, url, inputs, prefer = "browser" }: { name: string; url: string; inputs: Record<string, unknown>; prefer?: ActorPrefer }): Promise<ActorRun> {
  if (prefer === "browser") {
    const mod = await loadWasmActor();
    if (mod) {
      try {
        pushActorEvent({ kind: "start", line: `▶ ${name} ${JSON.stringify(inputs)}`, name, at: Date.now() });
        const h = await mod.startWasmActor({ manifestUrl: url, inputs, onEvent: (e) => { if (e.kind !== "start") pushActorEvent({ ...e, at: e.at ?? Date.now() }); } });
        await h.ready?.catch(() => {}); // label the window with the engine that actually started
        return {
          mode: h.mode,
          stop: () => {
            h.stop();
            if (sessionStore.get().actor.running) pushActorEvent({ kind: "exit", line: "■ stopped", code: null, at: Date.now() });
          },
        };
      } catch (e) {
        pushActorEvent({ kind: "fault", line: `! in-browser runtime failed (${(e as Error)?.message ?? e}); falling back to the server`, at: Date.now() });
      }
    }
  }
  await sessionApi.post("actor/run", { name, inputs });
  return { mode: "server", stop: () => void sessionApi.post("actor/stop", {}) };
}
