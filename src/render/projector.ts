/**
 * Streaming renderer: projects the live page into A2UI v0.9 messages.
 *
 *   page DOM ──MutationObserver/history──▶ snapshot {view, model} ──diff──▶ createSurface / updateComponents /
 *                                                                          updateDataModel / deleteSurface
 *
 * View changes (URL/selector match) swap surfaces; within a view only data-model patches stream,
 * so the component tree is stable and the stream stays tiny (infinite scroll = appends).
 */
import { EventEmitter } from "node:events";
import { INPAGE_RUNTIME } from "../inpage/source.js";
import type { BrowserAdapter } from "../adapters/types.js";
import type { FlowManifest } from "../manifest/types.js";
import { msg, type ServerMessage } from "../a2ui/types.js";
import { SurfaceStore } from "../a2ui/surface.js";
import { diff } from "../a2ui/pointer.js";

export interface Snapshot { url: string; path: string; view: string | null; model: Record<string, unknown>; interrupts?: { id: string; model: Record<string, unknown> }[]; ts: number }

const RUNTIME = INPAGE_RUNTIME;
export const inpageRuntime = () => RUNTIME;
const BINDING = "__a2flow_emit";
/** base64 → UTF-8 text without Node's Buffer (the projector also runs in the in-browser actor). */
function decodeBase64Utf8(b64: string): string {
  const B = (globalThis as any).Buffer;
  if (B) return B.from(b64, "base64").toString("utf8");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/** Set a (possibly nested) pointer on a shallow-copied model without mutating shared objects. */
function setTopLevel(model: Record<string, unknown>, ptr: string, v: unknown) {
  const parts = ptr.split("/").filter(Boolean);
  let cur: any = model;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = { ...(cur[parts[i]] ?? {}) };
  cur[parts[parts.length - 1]] = structuredClone(v);
}

/** In-page: embedded JSON scripts (id or "ld+json:<i>" / "json:<i>") with their text. */
type NetSource = { url: string; method?: string; when?: string; select: string; key?: string; mode?: string };

export const INLINE_JSON_SCRIPTS = `[...document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"],script#__NEXT_DATA__,script#SIGI_STATE')]
  .map((s, i) => ({ id: s.id || ((s.type || "").includes("ld+json") ? "ld+json:" + i : "json:" + i), text: s.textContent || "" }))
  .filter((x) => x.text.length > 2)`;

export class Projector extends EventEmitter {
  readonly store = new SurfaceStore();
  readonly log: ServerMessage[] = [];
  private seq = 0;
  private cur?: { view: string; surfaceId: string; model: unknown; path: string };
  last?: Snapshot;
  lastChange = Date.now();

  constructor(public adapter: BrowserAdapter, readonly manifest: FlowManifest, private surfacePrefix = "") {
    super();
  }

  /** Install the in-page runtime + live observer. Call before the first navigation. */
  async attach(opts: { quietMs?: number; maxWaitMs?: number } = {}) {
    // network-sourced pointers are fed from CDP here; the page only extracts DOM pointers
    const domOnly = (m: Record<string, any>) => Object.fromEntries(Object.entries(m).filter(([, ex]) => !ex.net));
    const views = Object.fromEntries(Object.entries(this.manifest.views).map(([k, v]) => [k, { match: v.match, model: domOnly(v.model), interrupt: !!v.interrupt }]));
    await this.attachNetwork();
    const boot = `${RUNTIME}
;window.__a2flow.configure(${JSON.stringify(views)});
window.__a2flow.observe(${JSON.stringify(BINDING)}, ${opts.quietMs ?? 120}, ${opts.maxWaitMs ?? 600});`;
    await this.adapter.exposeBinding(BINDING, (p) => { try { this.ingest(JSON.parse(p)); } catch (e) { this.emit("error", e); } });
    await this.adapter.addInitScript(boot);
  }

  /** Pull a snapshot now (deterministic sync point used by the runner between steps). */
  async sync(): Promise<Snapshot> {
    const snap = await this.adapter.evaluate<Snapshot>("window.__a2flow ? window.__a2flow.snapshot() : null");
    if (snap) this.ingest(snap);
    return this.last ?? snap!; // merged (DOM + network-sourced) snapshot
  }

  // ---------------- network sources ----------------
  private _netSources?: (NetSource & { view: string; ptr: string; re: RegExp })[];
  private get netSources() { return (this._netSources ??= this.computeNetSources()); }
  private computeNetSources() { return Object.entries(this.manifest.views).flatMap(([view, v]) =>
    Object.entries(v.model).filter(([, ex]) => (ex as any).net).flatMap(([ptr, ex]) => ([] as NetSource[]).concat((ex as any).net).map((n) => ({ view, ptr, ...n, re: new RegExp(n.url) })))); }
  /** document path → view → pointer → accumulated value. Keyed per document so a navigation can't wipe the
   *  previous page's data before its surface closes; reset only when that same path is (re)loaded. */
  private net: Record<string, Record<string, Record<string, unknown>>> = {};
  private netPath = "";
  private netAttached?: BrowserAdapter;
  readonly netStats = { matched: 0, parsed: 0, failed: 0 };

  private async attachNetwork() {
    if (!this.netSources.length || this.netAttached === this.adapter) return;
    const a = (this.netAttached = this.adapter);
    await a.cdp("Network.enable").catch(() => {});
    await a.cdp("Page.enable").catch(() => {});
    const pending = new Map<string, string>();
    const methods = new Map<string, string>();
    a.onCdp("Network.requestWillBeSent", (p: any) => methods.set(p.requestId, p.request.method));
    a.onCdp("Page.frameNavigated", (p: any) => {
      if (p.frame.parentId) return;
      try { this.netPath = new URL(p.frame.url).pathname; } catch { return; }
      delete this.net[this.netPath];
      const keys = Object.keys(this.net);
      if (keys.length > 8) for (const k of keys.slice(0, keys.length - 8)) delete this.net[k];
    });
    a.onCdp("Network.responseReceived", (p: any) => {
      if (this.netSources.some((s) => s.re.test(p.response.url))) pending.set(p.requestId, p.response.url);
    });
    a.onCdp("Network.loadingFinished", (p: any) => {
      const url = pending.get(p.requestId);
      if (!url) return;
      pending.delete(p.requestId);
      this.netStats.matched++;
      // async: never block the page or the runner on body retrieval/JSONata
      void (async () => {
        try {
          const { body, base64Encoded } = await a.cdp<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: p.requestId });
          const json = JSON.parse(base64Encoded ? decodeBase64Utf8(body) : body);
          const method = methods.get(p.requestId);
          methods.delete(p.requestId);
          await this.applyNet(url, method, json);
        } catch { this.netStats.failed++; }
      })();
    });
    // First-load data is often server-rendered into the document (Next/TikTok/ld+json), not fetched:
    // expose embedded JSON scripts as pseudo-responses "inline:<script id>" so `net` pointers can read them.
    if (this.netSources.some((s) => s.re.test("inline:") || /inline:/.test(s.url))) {
      const harvest = async () => {
        try {
          const scripts = await a.evaluate<{ id: string; text: string }[]>(INLINE_JSON_SCRIPTS);
          for (const sc of scripts) {
            const url = `inline:${sc.id}`;
            if (!this.netSources.some((s) => s.re.test(url))) continue;
            this.netStats.matched++;
            try { await this.applyNet(url, "INLINE", JSON.parse(sc.text)); } catch { this.netStats.failed++; }
          }
        } catch { /* page gone */ }
      };
      a.onCdp("Page.domContentEventFired", () => { void harvest(); });
      void harvest(); // document already loaded when attaching
    }
  }

  /** Apply a response captured before this projector attached (e.g. the Studio's own browsing) to `path`. */
  async seedNet(url: string, method: string, json: unknown, path: string) {
    await this.attachNetwork().catch(() => {});
    if (!this.netPath) this.netPath = path;
    if (this.netPath !== path) return;
    try { await this.applyNet(url, method, json); } catch { /* not for us */ }
  }

  /** Route one JSON payload (response body or inline script) through every matching net source. */
  private async applyNet(url: string, method: string | undefined, json: unknown) {
    const { default: jsonata } = await import("jsonata");
    for (const s of this.netSources.filter((x) => x.re.test(url) && (!x.method || x.method.toUpperCase() === method))) {
      if (s.when && !(await jsonata(s.when).evaluate(json))) continue; // content match
      const v = await jsonata(s.select).evaluate(json);
      const items = v == null ? [] : Array.isArray(v) ? v : [v];
      const slot = ((this.net[this.netPath] ??= {})[s.view] ??= {});
      if (s.mode === "replace" || !s.key) slot[s.ptr] = JSON.parse(JSON.stringify(s.key || Array.isArray(v) ? items : v));
      else {
        const cur = [...((slot[s.ptr] as any[]) ?? [])]; // copy-on-write: published models must never alias live state
        const seen = new Set(cur.map((x) => String(x?.[s.key!])));
        for (const it of items) if (!seen.has(String(it?.[s.key!]))) { cur.push(JSON.parse(JSON.stringify(it))); seen.add(String(it?.[s.key!])); }
        slot[s.ptr] = cur;
      }
    }
    this.netStats.parsed++;
    if (this.last) this.ingest({ ...this.last, ts: Date.now() });
  }

  ingest(snap: Snapshot) {
    if (this.last && snap.ts < this.last.ts && snap.url === this.last.url) return; // stale binding delivery
    const net = snap.view ? this.net[snap.path]?.[snap.view] : undefined;
    if (net) {
      const model = { ...snap.model };
      for (const [ptr, v] of Object.entries(net)) setTopLevel(model, ptr, v);
      snap = { ...snap, model };
    }
    this.last = snap;
    this.emit("snapshot", snap);
    this.projectInterrupts(snap.interrupts ?? []);
    const view = snap.view;
    // a different document is a different entity → a new surface, even when the view type is the same
    if (view !== (this.cur?.view ?? null) || (view && snap.path !== this.cur?.path)) {
      if (this.cur) this.publish(msg.deleteSurface(this.cur.surfaceId));
      this.cur = undefined;
      if (view) {
        const v = this.manifest.views[view];
        const surfaceId = `${this.surfacePrefix}${view}-${++this.seq}`;
        this.publish(msg.createSurface(surfaceId, this.manifest.a2ui.catalogId, this.manifest.a2ui.theme));
        this.publish(msg.updateComponents(surfaceId, v.components));
        this.publish(msg.updateDataModel(surfaceId, "/", snap.model));
        this.cur = { view, surfaceId, model: snap.model, path: snap.path };
      }
      this.lastChange = Date.now();
      return;
    }
    if (!this.cur) return;
    const patches = diff(this.cur.model, snap.model);
    if (!patches.length) return;
    if (patches.length > 40) this.publish(msg.updateDataModel(this.cur.surfaceId, "/", snap.model));
    else for (const p of patches) this.publish(msg.updateDataModel(this.cur.surfaceId, p.path, p.value));
    this.cur.model = snap.model;
    this.lastChange = Date.now();
  }

  /** interrupt view → its live surface (layered over the page surface; never becomes the active surface) */
  readonly interruptSurfaces = new Map<string, { surfaceId: string; model: unknown }>();

  private projectInterrupts(found: { id: string; model: Record<string, unknown> }[]) {
    const active = this.store.active;
    for (const { id, model } of found) {
      const cur = this.interruptSurfaces.get(id);
      if (!cur) {
        const surfaceId = `${this.surfacePrefix}interrupt:${id}-${++this.seq}`;
        this.publish(msg.createSurface(surfaceId, this.manifest.a2ui.catalogId, this.manifest.a2ui.theme));
        this.publish(msg.updateComponents(surfaceId, this.manifest.views[id].components));
        this.publish(msg.updateDataModel(surfaceId, "/", model));
        this.interruptSurfaces.set(id, { surfaceId, model });
        this.store.active = active; // the page surface stays the one the flow reads
        this.emit("interrupt", { view: id, present: true, surfaceId });
      } else if (JSON.stringify(cur.model) !== JSON.stringify(model)) {
        this.publish(msg.updateDataModel(cur.surfaceId, "/", model));
        cur.model = model;
      }
    }
    for (const [id, cur] of this.interruptSurfaces) {
      if (found.some((f) => f.id === id)) continue;
      this.publish(msg.deleteSurface(cur.surfaceId));
      this.interruptSurfaces.delete(id);
      this.store.active = active && this.store.surfaces.has(active) ? active : this.cur?.surfaceId;
      this.emit("interrupt", { view: id, present: false, surfaceId: cur.surfaceId });
    }
  }

  /** The view a surface projects (page view or an interrupt view). */
  viewOfSurface(surfaceId: string): string | null {
    if (surfaceId === this.cur?.surfaceId) return this.cur.view;
    for (const [id, s] of this.interruptSurfaces) if (s.surfaceId === surfaceId) return id;
    return null;
  }

  /** Publish a server→client message (also used for non-projected surfaces, e.g. the v0.2 control surface). */
  publish(m: ServerMessage) {
    this.store.apply(m);
    this.log.push(m);
    this.emit("message", m);
  }

  get view(): string | null { return this.cur?.view ?? null; }
  get surfaceId(): string | undefined { return this.cur?.surfaceId; }

  /** Resolve when `pred` holds for the current snapshot (polls + live stream). */
  async waitFor(pred: (s: Snapshot) => boolean, timeoutMs = 30_000, what = "condition"): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.sync().catch(() => this.last);
      if (s && pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (view=${s?.view} url=${s?.url})`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Wait until the projected model has been stable for `quietMs`. */
  async settle(quietMs = 600, timeoutMs = 10_000): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.sync().catch(() => this.last!);
      if (Date.now() - this.lastChange >= quietMs || Date.now() > deadline) return s;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
