/**
 * Host for the in-browser actor inside QuickJS compiled to WebAssembly (quickjs-emscripten, asyncify build).
 * Shared verbatim by the Studio Worker (src/actor/worker.ts → studio/public/actor/actor-worker.js) and the
 * Node smoke test (test/wasm-actor.smoke.test.ts), so the test exercises exactly what the Worker runs.
 *
 * QuickJS is a bare ECMAScript engine: no event loop, timers, console, URL, TextDecoder, atob, structuredClone.
 * The bridge:
 *   host → VM   __a2.fireTimer(id) · __a2.wsMessage(text) · __a2.wsClose(reason)   (then the job queue is drained)
 *   VM → host   __host.setTimer(id, ms) · clearTimer(id) · wsSend(text) · wsClose() · log(level, text)
 *               · emit(json) (actor events / state / a2ui) · parseURL(input, base) → JSON | throws
 * Everything else (atob, TextDecoder, structuredClone, queueMicrotask, performance) is a pure-JS polyfill.
 *
 * CDP is message-based, so the runtime's async work is plain promises resolved by host→VM calls; no host function
 * ever needs to suspend the VM. (The asyncify build is used as agreed; the bridge does not depend on asyncify.)
 */
import type { QuickJSAsyncContext, QuickJSAsyncWASMModule, QuickJSHandle } from "quickjs-emscripten";

export interface HostSocket {
  send(data: string): void;
  close(): void;
  /** Host wiring: call these when the real socket delivers. */
  onmessage?: (data: string) => void;
  onclose?: (reason?: string) => void;
}

export interface QuickJSActorOptions {
  module: QuickJSAsyncWASMModule;
  bundleSource: string;
  manifest: unknown;
  inputs: Record<string, unknown>;
  socket: HostSocket;
  name?: string;
  onEvent: (e: any) => void;
  onState?: (s: unknown) => void;
  onA2ui?: (m: unknown) => void;
  memoryLimitBytes?: number;
}

export interface QuickJSActorHandle {
  stop(reason?: string): void;
  done: Promise<{ ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }>;
  stats(): { memoryUsedBytes?: number };
}

/** Pure-JS environment for the bundle, evaluated in the VM before it. */
export const QUICKJS_PRELUDE = String.raw`
(function (g) {
  var H = g.__host;
  var timers = new Map(), nextTimer = 1;
  function fmt(a) { return Array.prototype.map.call(a, function (x) { if (typeof x === "string") return x; if (x instanceof Error) return x.stack || String(x); try { return JSON.stringify(x); } catch (e) { return String(x); } }).join(" "); }
  g.console = { log: function () { H.log("log", fmt(arguments)); }, info: function () { H.log("info", fmt(arguments)); },
    warn: function () { H.log("warn", fmt(arguments)); }, error: function () { H.log("error", fmt(arguments)); }, debug: function () {} };
  function setT(fn, ms, rep) { var args = Array.prototype.slice.call(arguments, 3); var id = nextTimer++; timers.set(id, { fn: fn, args: args, rep: rep ? Math.max(1, +ms || 0) : 0 }); H.setTimer(id, Math.max(0, +ms || 0)); return id; }
  g.setTimeout = function (fn, ms) { var a = Array.prototype.slice.call(arguments, 2); return setT.apply(null, [fn, ms, false].concat(a)); };
  g.setInterval = function (fn, ms) { var a = Array.prototype.slice.call(arguments, 2); return setT.apply(null, [fn, ms, true].concat(a)); };
  g.clearTimeout = g.clearInterval = function (id) { if (id != null && timers.delete(+id)) H.clearTimer(+id); };
  g.queueMicrotask = function (fn) { Promise.resolve().then(fn); };
  g.performance = g.performance || { now: function () { return Date.now(); }, timeOrigin: Date.now() };
  g.structuredClone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  g.atob = function (s) { s = String(s).replace(/[^A-Za-z0-9+/]/g, ""); var out = "", buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) { buf = (buf << 6) | B64.indexOf(s[i]); bits += 6; if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 255); } } return out; };
  g.TextDecoder = function () {}; g.TextDecoder.prototype.decode = function (b) { var s = "", i = 0; b = b || [];
    while (i < b.length) { var c = b[i++];
      if (c < 128) s += String.fromCharCode(c);
      else if (c < 224) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
      else if (c < 240) s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
      else { var cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); s += String.fromCodePoint(cp); } }
    return s; };
  function URLx(input, base) { var p = JSON.parse(H.parseURL(String(input), base === undefined ? "" : String(base))); for (var k in p) this["_" + k] = p[k]; this.searchParams = new URLSearchParamsx(this._search); }
  ["href", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "origin", "username", "password"].forEach(function (k) {
    Object.defineProperty(URLx.prototype, k, { get: function () { return this["_" + k]; } }); });
  URLx.prototype.toString = URLx.prototype.toJSON = function () { return this._href; };
  URLx.canParse = function (i, b) { try { new URLx(i, b); return true; } catch (e) { return false; } };
  function URLSearchParamsx(q) { this._p = []; q = String(q || "").replace(/^\?/, ""); if (q) q.split("&").forEach(function (kv) { var i = kv.indexOf("="); var d = function (x) { return decodeURIComponent(x.replace(/\+/g, " ")); };
    this._p.push(i < 0 ? [d(kv), ""] : [d(kv.slice(0, i)), d(kv.slice(i + 1))]); }, this); }
  URLSearchParamsx.prototype.get = function (k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) return this._p[i][1]; return null; };
  URLSearchParamsx.prototype.has = function (k) { return this.get(k) !== null; };
  URLSearchParamsx.prototype.toString = function () { return this._p.map(function (p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&"); };
  g.URL = URLx; g.URLSearchParams = URLSearchParamsx;
  function Signal() { this.aborted = false; this.reason = undefined; this.onabort = null; this._l = []; }
  Signal.prototype.addEventListener = function (t, fn) { if (t === "abort") this._l.push(fn); };
  Signal.prototype.removeEventListener = function (t, fn) { var i = this._l.indexOf(fn); if (i >= 0) this._l.splice(i, 1); };
  Signal.prototype.throwIfAborted = function () { if (this.aborted) throw this.reason; };
  function AbortControllerx() { this.signal = new Signal(); }
  AbortControllerx.prototype.abort = function (reason) { var s = this.signal; if (s.aborted) return; s.aborted = true;
    s.reason = reason === undefined ? new Error("This operation was aborted") : reason; var ev = { type: "abort", target: s };
    if (s.onabort) s.onabort(ev); s._l.slice().forEach(function (f) { f(ev); }); };
  g.AbortController = g.AbortController || AbortControllerx; g.AbortSignal = g.AbortSignal || Signal;

  var sock = { send: function (d) { H.wsSend(String(d)); }, close: function () { H.wsClose(); }, onmessage: null, onclose: null };
  g.__a2 = {
    socket: sock,
    fireTimer: function (id) { var t = timers.get(id); if (!t) return; if (t.rep) H.setTimer(id, t.rep); else timers.delete(id); t.fn.apply(null, t.args); },
    wsMessage: function (d) { if (sock.onmessage) sock.onmessage(d); },
    wsClose: function (r) { if (sock.onclose) sock.onclose(r); },
  };
})(globalThis);
`;

export async function runActorInQuickJS(o: QuickJSActorOptions): Promise<QuickJSActorHandle> {
  const runtime = o.module.newRuntime();
  runtime.setMemoryLimit(o.memoryLimitBytes ?? 512 * 1024 * 1024);
  runtime.setMaxStackSize(0); // ajv/jsonata recurse; the wasm stack is the real bound
  const ctx: QuickJSAsyncContext = runtime.newContext();
  const hostTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let finish!: (r: { ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }) => void;
  const done = new Promise<{ ok: boolean; error?: string; counts?: Record<string, number>; ms?: number }>((r) => (finish = r));

  // ---- VM → host ----
  const host = ctx.newObject();
  const fn = (name: string, impl: (...a: QuickJSHandle[]) => QuickJSHandle | void) => {
    const f = ctx.newFunction(name, impl as any);
    ctx.setProp(host, name, f);
    f.dispose();
  };
  fn("log", (lvl, txt) => { const l = ctx.getString(lvl), t = ctx.getString(txt); o.onEvent({ kind: "log", line: `· [${l}] ${t}`, at: Date.now() }); });
  fn("setTimer", (idH, msH) => {
    const id = ctx.getNumber(idH), ms = ctx.getNumber(msH);
    const prev = hostTimers.get(id); if (prev) clearTimeout(prev);
    hostTimers.set(id, setTimeout(() => { hostTimers.delete(id); callVm("fireTimer", ctx.newNumber(id)); }, ms));
  });
  fn("clearTimer", (idH) => { const id = ctx.getNumber(idH); const t = hostTimers.get(id); if (t) clearTimeout(t); hostTimers.delete(id); });
  fn("wsSend", (d) => { o.socket.send(ctx.getString(d)); });
  fn("wsClose", () => { o.socket.close(); });
  fn("emit", (j) => {
    const m = JSON.parse(ctx.getString(j));
    if (m.t === "event") o.onEvent(m.e);
    else if (m.t === "state") o.onState?.(m.s);
    else if (m.t === "a2ui") o.onA2ui?.(m.m);
    else if (m.t === "done") { finish(m.r); queueMicrotask(cleanup); }
  });
  fn("parseURL", (i, b) => {
    const input = ctx.getString(i), base = ctx.getString(b);
    let u: URL;
    try { u = base ? new URL(input, base) : new URL(input); } catch { throw new TypeError(`Invalid URL: ${input}`); }
    const { href, protocol, host: h, hostname, port, pathname, search, hash, origin, username, password } = u;
    return ctx.newString(JSON.stringify({ href, protocol, host: h, hostname, port, pathname, search, hash, origin, username, password }));
  });
  ctx.setProp(ctx.global, "__host", host);
  host.dispose();

  const check = (r: any, what: string) => {
    if (r.error) { const e = ctx.dump(r.error); r.error.dispose(); throw new Error(`${what}: ${typeof e === "object" ? `${e?.name}: ${e?.message}\n${e?.stack ?? ""}` : e}`); }
    r.value.dispose();
  };
  /** Drain the QuickJS job queue (promise reactions) after every host→VM entry. */
  const pump = () => {
    if (disposed) return;
    for (;;) {
      const r = runtime.executePendingJobs(-1);
      if (r.error) {
        const e = ctx.dump(r.error); r.error.dispose();
        o.onEvent({ kind: "log", line: `· [quickjs] unhandled job error: ${typeof e === "object" ? e?.message : e}`, at: Date.now() });
        continue;
      }
      if (r.value === 0) return;
    }
  };
  const callVm = (name: string, arg?: QuickJSHandle) => {
    if (disposed) { arg?.dispose(); return; }
    const a2 = ctx.getProp(ctx.global, "__a2");
    const f = ctx.getProp(a2, name);
    const r = ctx.callFunction(f, ctx.undefined, ...(arg ? [arg] : []));
    f.dispose(); a2.dispose(); arg?.dispose();
    if (r.error) { const e = ctx.dump(r.error); r.error.dispose(); o.onEvent({ kind: "log", line: `· [quickjs] ${name} threw: ${typeof e === "object" ? e?.message : e}`, at: Date.now() }); }
    else r.value.dispose();
    pump();
  };
  function cleanup() {
    if (disposed) return;
    disposed = true;
    for (const t of hostTimers.values()) clearTimeout(t);
    hostTimers.clear();
    try { ctx.dispose(); runtime.dispose(); } catch { /* leaked handles in a dead VM are irrelevant */ }
  }

  // ---- host socket → VM ----
  o.socket.onmessage = (d) => { if (!disposed) callVm("wsMessage", ctx.newString(d)); };
  o.socket.onclose = (r) => { if (!disposed) callVm("wsClose", ctx.newString(r ?? "closed")); };

  // ---- boot ----
  check(ctx.evalCode(QUICKJS_PRELUDE, "prelude.js"), "prelude");
  check(ctx.evalCode(o.bundleSource, "a2flow-actor.js"), "actor bundle");
  const boot = `(function () {
    var send = function (o) { __host.emit(JSON.stringify(o)); };
    var h = globalThis.runActor(${JSON.stringify(JSON.stringify(o.manifest))}, ${JSON.stringify(o.inputs)}, __a2.socket, {
      name: ${JSON.stringify(o.name ?? null)} || undefined,
      onEvent: function (e) { send({ t: "event", e: e }); },
      onState: function (s) { send({ t: "state", s: s }); },
      ${o.onA2ui ? `onA2ui: function (m) { send({ t: "a2ui", m: m }); },` : ""}
    });
    globalThis.__a2.handle = h;
    h.done.then(function (r) {
      var counts = {}; for (var k in (r.results || {})) counts[k] = r.results[k].length;
      send({ t: "done", r: { ok: r.ok, error: r.error, counts: counts, ms: r.ms } });
    });
  })()`;
  check(ctx.evalCode(boot, "boot.js"), "boot");
  pump();

  return {
    stop(reason = "stopped by user") {
      if (disposed) return;
      const a2 = ctx.getProp(ctx.global, "__a2");
      const h = ctx.getProp(a2, "handle");
      const stop = ctx.getProp(h, "stop");
      const why = ctx.newString(reason);
      const r = ctx.callFunction(stop, h, why);
      if (r.error) r.error.dispose(); else r.value.dispose();
      why.dispose(); stop.dispose(); h.dispose(); a2.dispose();
      pump();
    },
    done,
    stats: () => ({ memoryUsedBytes: disposed ? undefined : Number(/memory_used_size:\s*(\d+)/.exec(runtime.dumpMemoryUsage())?.[1] ?? NaN) }),
  };
}
