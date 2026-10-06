/**
 * In-browser actor entry: `runActor(manifest, inputs, transport, hooks)`.
 *
 * Built by scripts/build-actor.mjs into studio/public/actor/a2flow-actor.js (IIFE, sets globalThis.runActor).
 * The same bundle runs inside QuickJS-wasm (studio/public/actor/actor-worker.js) or directly in a Worker.
 * Page control goes over `transport`: a page-scoped raw CDP socket (the session server's /actor/cdp proxy,
 * which owns the real headless browser). No disk: in-memory ledger + results, no recorder / fault bundles,
 * no domhash drift checks.
 */
import { CdpAdapterCore, type CdpSocket } from "../adapters/cdp-core.js";
import { MachineRunner } from "../machine/runner.js";
import type { FlowManifest } from "../manifest/types.js";

/** WebSocket-like: `send(text)`, `close()`, and the actor assigns `onmessage` / `onclose`. */
export interface ActorTransport {
  send(data: string): void;
  close(): void;
  onmessage?: ((ev: { data: string } | string) => void) | null;
  onclose?: ((ev?: { code?: number; reason?: string } | string) => void) | null;
}

/** Same shape as the session server's SSE `actor` events. */
export interface ActorEvent { kind: "start" | "log" | "item" | "unit" | "fault" | "done" | "exit"; line: string; route?: string; item?: unknown; at: number; code?: number }

export interface ActorHooks {
  onEvent?: (e: ActorEvent) => void;
  onState?: (s: { value: unknown }) => void;
  onA2ui?: (m: unknown) => void;
  /** Label for the start line. */
  name?: string;
}

export interface ActorHandle {
  stop(reason?: string): void;
  done: Promise<{ ok: boolean; results?: Record<string, unknown[]>; error?: string; ms: number }>;
}

function socketOf(t: ActorTransport): CdpSocket {
  const msgFns: ((d: string) => void)[] = [];
  const closeFns: ((r?: string) => void)[] = [];
  t.onmessage = (ev) => { const d = typeof ev === "string" ? ev : ev.data; for (const f of msgFns) f(d); };
  t.onclose = (ev) => { const r = typeof ev === "string" ? ev : ev ? `${ev.code ?? ""} ${ev.reason ?? ""}`.trim() : undefined; for (const f of closeFns) f(r); };
  return { send: (d) => t.send(d), close: () => t.close(), onMessage: (f) => msgFns.push(f), onClose: (f) => closeFns.push(f) };
}

export function runActor(manifestIn: FlowManifest | string, inputs: Record<string, unknown>, transport: ActorTransport, hooks: ActorHooks = {}): ActorHandle {
  const manifest: FlowManifest = typeof manifestIn === "string" ? JSON.parse(manifestIn) : JSON.parse(JSON.stringify(manifestIn));
  const emit = (kind: ActorEvent["kind"], line: string, extra: Partial<ActorEvent> = {}) => { try { hooks.onEvent?.({ kind, line, at: Date.now(), ...extra }); } catch { /* UI errors never kill the run */ } };
  // drift checks are off in-browser: drop fingerprints so nothing even tries
  for (const v of Object.values(manifest.views ?? {})) delete (v as any).fingerprint;
  let runner: MachineRunner | undefined;
  let stopped: string | undefined;
  const t0 = Date.now();
  emit("start", `▶ ${hooks.name ?? manifest.id ?? "manifest"} ${JSON.stringify(inputs)}`, { name: hooks.name ?? manifest.id } as any);
  const sock = socketOf(transport);
  let closed = false;
  sock.onClose?.((r) => { closed = true; if (!stopped) runner?.abort(`CDP proxy closed${r ? ` (${r})` : ""}`); });

  const done = (async () => {
    try {
      if (!manifest.machine) throw new Error("the in-browser actor runs v0.2 manifests (machine + control) only");
      const adapter = await CdpAdapterCore.overPageSocket(sock, { viewport: manifest.target?.viewport });
      if (stopped) throw new Error(stopped);
      runner = new MachineRunner(manifest, adapter, inputs, {});
      runner.on("log", (l: unknown) => emit("log", `· ${l}`));
      runner.on("unit", (u: any) => { if (u.status !== "running") emit("unit", `  unit ${u.type}:${u.key} ${u.status}${u.reason ? ` (${u.reason})` : u.error ? ` (${String(u.error).slice(0, 80)})` : ""}`); });
      runner.on("item", ({ route, item }: { route: string; item: unknown }) => emit("item", `+ ${route} ${JSON.stringify(item).slice(0, 110)}`, { route, item }));
      runner.on("fault", (f: any) => emit("fault", `! fault ${f.reason}: ${f.error ?? ""}`));
      runner.on("state", (s: any) => { try { hooks.onState?.({ value: s.value }); } catch { /* ignore */ } });
      if (hooks.onA2ui) runner.on("message", (m: unknown) => { try { hooks.onA2ui!(m); } catch { /* ignore */ } });
      const res = await runner.run();
      const ms = Date.now() - t0;
      emit("done", `done in ${(ms / 1000).toFixed(1)}s: ${Object.entries(res).map(([k, v]) => `${k}=${v.length}`).join(" ")} (in-browser, not persisted)`);
      emit("exit", "■ exited 0", { code: 0 });
      return { ok: true, results: res as Record<string, unknown[]>, ms };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      emit("fault", `! ${msg}`);
      emit("exit", `■ exited 1`, { code: 1 });
      return { ok: false, error: msg, results: runner?.results as Record<string, unknown[]> | undefined, ms: Date.now() - t0 };
    } finally {
      if (!closed) { try { transport.close(); } catch { /* already closed */ } }
    }
  })();

  return {
    stop(reason = "stopped by user") { stopped = reason; runner?.abort(reason); try { transport.close(); } catch { /* ignore */ } },
    done,
  };
}

(globalThis as any).runActor = runActor;
