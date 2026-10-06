/**
 * One live Studio session: a humanised CloakBrowser the authoring agent drives through MCP tools,
 * streamed to the UI (screencast, highlights, schema, manifest, A2UI, parity) over SSE.
 *
 * Phases: discover (browse + enumerate input/output shapes) → design (derive views, write manifest)
 *         → tune (run manifest in lockstep, measure parity, patch, repeat).
 */
import { EventEmitter } from "node:events";
import { launchAdapter, type BrowserAdapter } from "../adapters/index.js";
import { inpageRuntime, INLINE_JSON_SCRIPTS } from "../render/projector.js";
import { findTarget, type Visual } from "../harness/perceive.js";
import { digestJson } from "./sanitize.js";
import { apifyPrices, apifyRows, benchMarkdown, costTable, perItem, type Bench } from "./pricing.js";
import { cpus } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { settleDom } from "../derive/capture.js";
import { derive } from "../derive/derive.js";
import { checkManifest } from "../manifest/load.js";
import type { FlowManifest, ViewSpec } from "../manifest/types.js";
import { MachineRunner } from "../machine/runner.js";
import { parity, type ExpectedRecord, type ParityReport } from "../author/parity.js";

export type Phase = "discover" | "design" | "tune" | "production";
export interface Highlight { id: string; label: string; kind: "input" | "output" | "action" | "mapping"; rect: { x: number; y: number; width: number; height: number } }
export interface SchemaProposal {
  inputs: { name: string; kind: string; description: string; example?: unknown }[];
  outputs: Record<string, { description: string; fields: { name: string; type: string; description?: string }[] }>;
}
/** One facet (model pointer) of the current view and where its visible instances are. */
export interface Facet { path: string; kind: "field" | "group" | "list" | "item" | "net"; parent: string | null; depth: number; rects: number[][]; values: (string | null)[]; idx?: number[]; count?: number; net?: string }
export interface FacetSnapshot { view: string | null; url: string; viewport: [number, number]; scroll: [number, number]; docHeight: number; facets: Facet[]; draft?: boolean }
/**
 * A buffered run: frames, facet snapshots and A2UI messages on one clock (ms since t0), with
 * record/unit marks. Frames are not streamed during a run; the UI plays the timeline back in sync.
 */
export interface Timeline {
  id: string; t0: number; done: boolean;
  /** what the scene shows: the agent tool / UI action / "run" */
  label: string; kind: "action" | "run";
  acts: { t: number; act: Record<string, unknown> }[];
  frames: { t: number; data: Buffer }[];
  facets: { t: number; snap: FacetSnapshot }[];
  a2ui: { t: number; msg: unknown }[];
  marks: { t: number; kind: "record" | "state" | "fault"; label: string; route?: string; key?: unknown }[];
}
interface NetSample { url: string; method: string; status: number; at: number; shape: string; body?: unknown }

const KIND_COLOR: Record<Highlight["kind"], string> = { input: "#2563eb", output: "#16a34a", action: "#d97706", mapping: "#db2777" };

/** Compact structural description of a JSON value (keys, types, array lengths, first item). */
export function shapeOf(v: unknown, depth = 0): string {
  if (depth > 3) return "…";
  if (Array.isArray(v)) return `[${v.length}× ${v.length ? shapeOf(v[0], depth + 1) : "?"}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).slice(0, 18).map(([k, x]) => `${k}: ${shapeOf(x, depth + 1)}`).join(", ")}${Object.keys(v).length > 18 ? ", …" : ""} }`;
  return typeof v === "string" ? (v.length > 24 ? "str" : JSON.stringify(v)) : String(typeof v === "number" ? "num" : v);
}

/** Repeated sibling lines (same indent + role) → first 3 + "… +N more <role>": lists are the point, not every tile. */
function collapseRuns(lines: string[]): string[] {
  const out: string[] = [];
  const sig = (l: string) => /^(\s*)(\S+)/.exec(l)?.slice(1).join("|") ?? l;
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    const ind = /^\s*/.exec(lines[i])![0].length;
    // a run = consecutive items at this indent with the same role (children of each item included)
    const starts = [i];
    while (j < lines.length) {
      const d = /^\s*/.exec(lines[j])![0].length;
      if (d > ind) { j++; continue; }
      if (d === ind && sig(lines[j]) === sig(lines[i])) { starts.push(j); j++; continue; }
      break;
    }
    if (starts.length > 3) {
      out.push(...lines.slice(i, starts[3]));
      out.push(`${" ".repeat(ind)}… +${starts.length - 3} more ${sig(lines[i]).split("|")[1]}`);
    } else out.push(...lines.slice(i, j));
    i = j;
  }
  return out;
}

export class StudioSession extends EventEmitter {
  adapter?: BrowserAdapter;
  phase: Phase = "discover";
  url = "";
  schema?: SchemaProposal;
  highlights: Highlight[] = [];
  manifest?: FlowManifest;
  manifestErrors: string[] = [];
  views: Record<string, ViewSpec> = {};
  expected: ExpectedRecord[] = [];
  lastResults: Record<string, Record<string, unknown>[]> = {};
  lastParity?: ParityReport;
  lastFrame?: string;
  a2uiBacklog: unknown[] = [];
  net: NetSample[] = [];
  runner?: MachineRunner;
  private starting?: Promise<void>;
  /** Views the facet feed resolves against: a streamed draft from the UI, else the manifest's. */
  facetViews?: Record<string, unknown>;
  facetDraft = false;
  lastFacets?: FacetSnapshot;
  /** last run scene (compat: /timeline) */
  timeline?: Timeline;
  /** every agent/UI action and run, recorded as a buffered scene; the UI plays closed scenes back in order */
  scenes: Timeline[] = [];
  scene?: Timeline;
  machineState?: { value: unknown; at: number };
  private facetTimer?: ReturnType<typeof setTimeout>;
  private facetBusy = false;
  private lastFrameAt = 0;

  constructor(readonly opts: { headless?: boolean; outDir?: string } = {}) { super(); this.setMaxListeners(50); }

  /** Everything the UI was told (minus frames), timestamped — for session export / replay. */
  eventLog: { t: number; ev: Record<string, unknown> }[] = [];

  broadcast(ev: Record<string, unknown>) {
    if (ev.type !== "frame" && this.eventLog.length < 50_000) this.eventLog.push({ t: Date.now(), ev });
    const tl = this.scene && !this.scene.done ? this.scene : undefined;
    const now = Date.now();
    if (ev.type === "frame") {
      if (tl) { // buffer instead of streaming: ≤ ~8 fps, played back by the UI as a whole scene
        if (now - this.lastFrameAt < 120 || tl.frames.length >= 2000) return;
        this.lastFrameAt = now;
        tl.frames.push({ t: now - tl.t0, data: Buffer.from(ev.data as string, "base64") });
        this.evictFrames();
        this.scheduleFacets(400);
        if (tl.frames.length % 8 === 1) this.emit("event", { type: "scene", ...this.sceneSummary(tl) });
        return;
      }
      // idle (no scene open): an occasional still so the UI's resting frame stays current
      if (now - this.lastFrameAt < 500) { this.lastFrame = ev.data as string; return; }
      this.lastFrameAt = now;
      this.lastFrame = ev.data as string;
    }
    if (tl && ev.type === "a2ui") tl.a2ui.push({ t: now - tl.t0, msg: ev.msg });
    if (tl && ev.type === "act") { tl.acts.push({ t: now - tl.t0, act: ev }); return; }
    if (tl && ev.type === "facets") { tl.facets.push({ t: now - tl.t0, snap: ev as unknown as FacetSnapshot }); return; }
    if (ev.type === "a2ui" || ev.type === "client") { this.a2uiBacklog.push(ev); if (this.a2uiBacklog.length > 3000) this.a2uiBacklog.splice(0, 1000); }
    this.emit("event", ev);
  }

  /** Everything a newly connected UI needs. */
  replay(): Record<string, unknown>[] {
    return [
      { type: "phase", phase: this.phase }, { type: "url", url: this.url },
      ...(this.schema ? [{ type: "schema", schema: this.schema }] : []),
      { type: "highlights", items: this.highlights, viewport: { width: 1280, height: 900 } },
      ...(this.manifest ? [this.manifestEvent()] : []),
      ...(this.lastParity ? [{ type: "parity", ...this.lastParity }] : []),
      ...(this.expected.length ? [{ type: "expected", records: this.expected }] : []),
      ...(this.lastFrame ? [{ type: "frame", data: this.lastFrame }] : []),
      ...(this.lastFacets ? [{ type: "facets", ...this.lastFacets }] : []),
      ...(this.timeline ? [{ type: "timeline", ...this.timelineSummary() }] : []),
      ...this.scenes.map((sc) => ({ type: "scene", ...this.sceneSummary(sc) })),
      ...(this.machineState ? [{ type: "machine", ...this.machineState }] : []),
      ...(this.a2uiBacklog as Record<string, unknown>[]),
    ];
  }

  setPhase(p: Phase) { this.phase = p; this.broadcast({ type: "phase", phase: p }); }

  ensure(): Promise<void> { return (this.starting ??= this.start()); }

  private async start() {
    const a = (this.adapter = await launchAdapter({ adapter: "playwright", headless: this.opts.headless ?? true, humanize: true, viewport: { width: 1280, height: 900 } }));
    await a.addInitScript(inpageRuntime());
    this.instrumentActs(a);
    // page → UI scroll sync
    await a.exposeBinding("__studio_scroll", (r) => { this.broadcast({ type: "scroll", ratio: Number(r) }); this.scheduleFacets(60); });
    await a.addInitScript(`(() => { let t = 0; addEventListener("scroll", () => { const n = Date.now(); if (n - t < 80) return; t = n;
      const m = document.documentElement.scrollHeight - innerHeight; try { window.__studio_scroll(String(m > 0 ? scrollY / m : 0)); } catch {} }, { passive: true }); })()`);
    // No continuous screencast: frames are only produced while a scene records (castOn/castOff); idle gets one still.
    a.onCdp("Page.screencastFrame", (p: any) => {
      a.cdp("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      if (this.casting) this.broadcast({ type: "frame", data: p.data });
    });
    void this.still();
    a.onCdp("Page.frameNavigated", (p: any) => { if (!p.frame.parentId) { this.url = p.frame.url; this.broadcast({ type: "url", url: this.url }); this.scheduleFacets(600); } });
    // passive JSON XHR capture: the agent should notice when the page's own API already carries the data
    await a.cdp("Network.enable").catch(() => {});
    const pending = new Map<string, { url: string; method: string; status: number }>();
    const methods = new Map<string, string>();
    a.onCdp("Network.requestWillBeSent", (p: any) => {
      methods.set(p.requestId, p.request.method);
      if (!["WebSocket", "EventSource", "Media", "Ping"].includes(p.type)) { this.inflight.add(p.requestId); this.lastNetAt = Date.now(); }
    });
    const done = (p: any) => { if (this.inflight.delete(p.requestId)) this.lastNetAt = Date.now(); if (p.encodedDataLength) this.bytesIn += p.encodedDataLength; };
    a.onCdp("Network.loadingFinished", done);
    a.onCdp("Network.loadingFailed", done);
    a.onCdp("Network.responseReceived", (p: any) => {
      if (!/json/i.test(p.response.mimeType ?? "") || !["XHR", "Fetch"].includes(p.type)) return;
      pending.set(p.requestId, { url: p.response.url, method: methods.get(p.requestId) ?? "GET", status: p.response.status });
    });
    // first-load data embedded in the document (SSR state, ld+json) — visible to the agent like an XHR
    await a.cdp("Page.enable").catch(() => {});
    a.onCdp("Page.domContentEventFired", () => {
      void a.evaluate<{ id: string; text: string }[]>(INLINE_JSON_SCRIPTS).then((scripts) => {
        for (const sc of scripts) {
          if (sc.text.length < 40) continue;
          try {
            const json = JSON.parse(sc.text);
            this.net.push({ url: `inline:${sc.id}`, method: "INLINE", status: 200, at: Date.now(), shape: shapeOf(json), body: json });
            this.trimNet();
          } catch { /* not JSON */ }
        }
      }).catch(() => {});
    });
    a.onCdp("Network.loadingFinished", (p: any) => {
      const r = pending.get(p.requestId);
      if (!r) return;
      pending.delete(p.requestId);
      void a.cdp<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: p.requestId }).then(({ body, base64Encoded }) => {
        const json = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
        this.net.push({ ...r, at: Date.now(), shape: shapeOf(json), body: json });
        this.trimNet();
      }).catch(() => {});
    });
  }

  /** Every input the agent or the runner sends to the page → an "act" event (the UI shows a HUD). */
  private instrumentActs(a: BrowserAdapter) {
    const act = (ev: Record<string, unknown>) => this.broadcast({ type: "act", at: Date.now(), ...ev });
    const wrap = <K extends keyof BrowserAdapter>(k: K, f: (...args: any[]) => Record<string, unknown>) => {
      const orig = (a[k] as any).bind(a);
      (a as any)[k] = (...args: any[]) => { try { act(f(...args)); } catch { /* ignore */ } return orig(...args); };
    };
    wrap("wheel", (dy: number, at?: { x: number; y: number }) => ({ kind: "scroll", dir: dy >= 0 ? "down" : "up", amount: Math.abs(dy), x: at?.x, y: at?.y }));
    wrap("mouseClick", (x: number, y: number) => ({ kind: "click", x, y }));
    wrap("click", (sel: string) => ({ kind: "click", target: String(sel).slice(0, 80) }));
    wrap("goto", (url: string) => ({ kind: "navigate", url }));
    wrap("back", () => ({ kind: "back" }));
    if (typeof (a as any).press === "function") wrap("press" as keyof BrowserAdapter, (key: string) => ({ kind: "key", key }));
    if (typeof (a as any).type === "function") wrap("type" as keyof BrowserAdapter, (_sel: string, text: string) => ({ kind: "type", text: String(text ?? "").slice(0, 40) }));
  }

  // ---------------- observation ----------------

  /** Accessibility outline: role "name" lines, indented, capped — the text half of the agent's perception. */
  async outline(maxLines = 120): Promise<string> {
    const a = this.adapter!;
    const { nodes } = await a.cdp<{ nodes: any[] }>("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const lines: string[] = [];
    const walk = (n: any, d: number) => {
      if (!n || lines.length >= maxLines) return;
      const role = n.role?.value ?? "", name = String(n.name?.value ?? "").replace(/\s+/g, " ").slice(0, 90);
      const keep = !n.ignored && !["generic", "none", "InlineTextBox", "LineBreak"].includes(role) && (name || ["main", "list", "listitem", "article", "feed", "navigation", "heading", "link", "button", "img", "textbox", "searchbox", "tab", "dialog"].includes(role));
      if (keep && !(role === "StaticText" && name.length < 2)) lines.push(`${"  ".repeat(Math.min(d, 8))}${role}${name ? ` "${name}"` : ""}`);
      for (const c of n.childIds ?? []) walk(byId.get(c), keep ? d + 1 : d);
    };
    walk(nodes.find((n) => !n.parentId), 0);
    return collapseRuns(lines).join("\n") + (lines.length >= maxLines ? "\n… (truncated)" : "");
  }

  /** Downscaled viewport JPEG (768px wide, q≈55) — roughly 4× fewer image tokens than full size. */
  async smallScreenshot(): Promise<Buffer> {
    const a = this.adapter!;
    const [w, h, sy] = await a.evaluate<[number, number, number]>("[innerWidth, innerHeight, scrollY]");
    const r = await a.cdp<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 55, clip: { x: 0, y: sy, width: w, height: h, scale: 768 / w } });
    return Buffer.from(r.data, "base64");
  }

  async observe(screenshot = false) {
    const a = this.adapter!;
    await settleDom(a, 400, 3000).catch(() => {});
    const [shot, outline, repeats, meta] = await Promise.all([
      screenshot ? this.smallScreenshot().catch(() => undefined) : Promise.resolve(undefined),
      this.outline().catch(() => ""),
      a.evaluate<any[]>("window.__a2flow ? window.__a2flow.repeats() : []").catch(() => []),
      a.evaluate<{ title: string; scroll: number; height: number }>("({ title: document.title, scroll: scrollY, height: document.documentElement.scrollHeight })"),
    ]);
    const lists = repeats.slice(0, 4).map((r) => `- ${r.count}× ${r.itemSel}: ${r.fields.map((f: any) => `${f.kind}${f.sel ? `(${f.sel})` : ""}=${JSON.stringify(f.samples[0] ?? "").slice(0, 50)}`).join("; ")}`).join("\n");
    // newest sample per URL path only, digested: where the records are, their fields, paging
    const byPath = new Map<string, NetSample>();
    for (const n of this.net) byPath.set(n.url.split("?")[0], n);
    const net = [...byPath.values()].slice(-5).map((n) => `- ${n.method} ${n.status} ${n.url.split("?")[0].slice(0, 120)}\n${digestJson(n.body, { maxFields: 18 })}`).join("\n");
    const overlays = await this.overlays();
    return { url: await a.url(), ...meta, screenshot: shot, outline, lists, net, overlays };
  }

  // ---------------- actions (human-like) ----------------

  async navigate(url: string) { await this.ensure(); await this.adapter!.goto(url); await settleDom(this.adapter!, 500, 12_000).catch(() => {}); }

  /**
   * Scroll like a person and verify it actually happened: each step records scrollY before/after. A step
   * that doesn't move means the page is at its end, or something (usually a modal) is eating the wheel —
   * then we stop and report what's over the page instead of pretending the scroll succeeded.
   */
  async scroll(times = 1, direction: "down" | "up" = "down"): Promise<{ requested: number; moved: number; from: number; to: number; height: number; blocked?: string }> {
    const a = this.adapter!;
    const pos = () => a.evaluate<[number, number, number]>("[scrollY, document.documentElement.scrollHeight, innerHeight]");
    const [from] = await pos();
    let moved = 0, blocked: string | undefined;
    for (let i = 0; i < times; i++) {
      await this.ready(400, 5000); // never scroll past content that hasn't loaded yet
      const [y0] = await pos();
      await a.wheel((direction === "down" ? 1 : -1) * (650 + Math.round(Math.random() * 250)), { x: 640, y: 520 });
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 400));
      const [y1, h, vh] = await pos();
      if (Math.abs(y1 - y0) >= 40) { moved++; continue; }
      const overlays = await this.overlays();
      if (overlays) { blocked = `overlay over the page:\n${overlays}`; break; }
      if (direction === "down" && y1 + vh >= h - 4) { await this.ready(600, 4000); const [y2] = await pos(); if (Math.abs(y2 - y0) < 40) { blocked = "end of page (no more content loaded)"; break; } }
    }
    // feeds never go fully quiet (autoplay, counters): settle briefly, the XHRs are captured regardless
    await settleDom(a, 350, 2500).catch(() => {});
    const [to, height] = await pos();
    return { requested: times, moved, from: Math.round(from), to: Math.round(to), height: Math.round(height), blocked };
  }

  /** Click by visible text / href / aria fragment (perception), or a selector, or viewport fractions. */
  async click(t: { text?: string; href?: string; selector?: string; x?: number; y?: number }): Promise<void> {
    const a = this.adapter!;
    if (t.selector) { await a.click(t.selector); }
    else if (t.x != null && t.y != null) { await a.mouseClick(Math.round(t.x * 1280), Math.round(t.y * 900)); }
    else {
      const v = await a.evaluate<Visual>("window.__a2flow.visual({ selectors: false, canvas: false, max: 4000 })");
      const target = findTarget(v, [t.href, t.text].filter(Boolean) as string[], []);
      if (!target) throw new Error(`no visible clickable element matching ${JSON.stringify(t)}`);
      const [x, y, w, h] = target.rect;
      const cy = y - v.scroll[1] + h / 2;
      if (cy < 0 || cy > v.viewport[1]) { await a.wheel(Math.round(cy - v.viewport[1] / 2), { x: 640, y: 450 }); await new Promise((r) => setTimeout(r, 400)); return this.click(t); }
      await a.mouseClick(Math.round(x - v.scroll[0] + w / 2), Math.round(cy));
    }
    await settleDom(a, 500, 10_000).catch(() => {});
  }

  async back() { await this.adapter!.back(); await settleDom(this.adapter!, 500, 10_000).catch(() => {}); }

  // ---------------- highlighting ----------------

  /** Outline + label elements on the live page (visible in the screencast) and publish them to the UI. */
  async highlight(items: { selector?: string; text?: string; label: string; kind: Highlight["kind"] }[], replace = false) {
    const a = this.adapter!;
    const found = await a.evaluate<(Highlight & { abs: number[] } | null)[]>(`(${JSON.stringify(items)}).map((it, i) => {
      let el = null;
      try { if (it.selector) el = document.querySelector(it.selector); } catch {}
      if (!el && it.text) { const t = it.text.toLowerCase();
        el = [...document.querySelectorAll("body *")].filter((e) => e.children.length < 4 && (e.innerText || "").toLowerCase().includes(t) && e.getBoundingClientRect().height > 0)
          .sort((x, y) => x.innerText.length - y.innerText.length)[0] || null; }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id: "h" + Date.now() + "-" + i, label: it.label, kind: it.kind, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, abs: [r.x + scrollX, r.y + scrollY, r.width, r.height] };
    })`);
    const ok = found.filter(Boolean) as (Highlight & { abs: number[] })[];
    this.highlights = [...(replace ? [] : this.highlights), ...ok.map(({ abs: _a, ...h }) => h)];
    await this.redraw(ok.map((h) => ({ label: h.label, rect: h.abs, color: KIND_COLOR[h.kind] })), replace);
    this.broadcast({ type: "highlights", items: this.highlights, viewport: { width: 1280, height: 900 } });
    return { highlighted: ok.length, missed: items.filter((_, i) => !found[i]).map((it) => it.label) };
  }
  private drawn: { label: string; rect: number[]; color: string }[] = [];
  private async redraw(boxes: { label: string; rect: number[]; color: string }[], replace: boolean) {
    this.drawn = [...(replace ? [] : this.drawn), ...boxes];
    await this.adapter!.evaluate(`window.__a2flow && window.__a2flow.annotate(${JSON.stringify(this.drawn)})`).catch(() => {});
  }
  async clearHighlights() {
    this.highlights = []; this.drawn = [];
    await this.adapter?.evaluate("window.__a2flow && window.__a2flow.clearAnnotations()").catch(() => {});
    this.broadcast({ type: "highlights", items: [], viewport: { width: 1280, height: 900 } });
  }

  /** Label every anchored component of the matching manifest view on the live page (design/tune). */
  async showMappings() {
    if (!this.manifest || !this.adapter) return 0;
    const a = this.adapter;
    const views = Object.fromEntries(Object.entries(this.manifest.views).map(([k, v]) => [k, { match: v.match, model: Object.fromEntries(Object.entries(v.model).filter(([, ex]) => !(ex as any).net)) }]));
    await a.evaluate(`window.__a2flow.configure(${JSON.stringify(views)})`);
    const view = await a.evaluate<string | null>("window.__a2flow.matchView()");
    if (!view) return 0;
    const items: { label: string; rect: number[]; color: string }[] = [];
    for (const [cid, anchor] of Object.entries(this.manifest.views[view].anchors)) {
      const r = await a.evaluate<any>(`(() => { const sy = scrollY; const r = window.__a2flow.locate(${JSON.stringify(view)}, ${JSON.stringify(anchor)}, null, 0); scrollTo(0, sy); return r && { ...r, sy }; })()`);
      if (r) items.push({ label: `${view}.${cid}`, rect: [r.rect.x, r.rect.y + r.sy, r.rect.width, r.rect.height], color: KIND_COLOR.mapping });
    }
    await this.redraw(items, true);
    this.highlights = items.map((b, i) => ({ id: `m${i}`, label: b.label, kind: "mapping" as const, rect: { x: b.rect[0], y: b.rect[1], width: b.rect[2], height: b.rect[3] } }));
    this.broadcast({ type: "highlights", items: this.highlights, viewport: { width: 1280, height: 900 } });
    return items.length;
  }

  // ---------------- facet feed ----------------

  /** UI streams the manifest draft it is rendering; null falls back to the written manifest. */
  setFacetViews(views: Record<string, unknown> | null) {
    this.facetDraft = !!views;
    this.facetViews = views ?? (this.manifest?.views as Record<string, unknown> | undefined);
    this.scheduleFacets(0);
  }

  private lastFacetsAt = 0;
  /** Facet snapshots walk the DOM in-page: at most ~3/s, whatever triggers them (frames, scroll, navigation). */
  scheduleFacets(ms = 120) {
    if (this.facetTimer || !this.facetViews || !this.adapter) return;
    ms = Math.max(ms, 300 - (Date.now() - this.lastFacetsAt));
    this.facetTimer = setTimeout(() => { this.facetTimer = undefined; void this.refreshFacets(); }, ms);
  }

  async refreshFacets(): Promise<FacetSnapshot | undefined> {
    if (!this.adapter || !this.facetViews || this.facetBusy) return;
    this.facetBusy = true;
    try {
      this.lastFacetsAt = Date.now();
      const snap = await this.adapter.evaluate<FacetSnapshot>(`window.__a2flow && window.__a2flow.facets(${JSON.stringify(this.facetViews)})`);
      if (!snap) return;
      snap.draft = this.facetDraft;
      this.lastFacets = snap;
      this.broadcast({ type: "facets", ...snap });
      return snap;
    } catch { return; } finally { this.facetBusy = false; }
  }

  /** Keep captured JSON bounded by size, not count: a feed's first page must survive until the run seeds from it. */
  private trimNet(maxBytes = 40_000_000) {
    const size = (n: NetSample) => (n as any).bytes ??= JSON.stringify(n.body ?? null).length;
    let total = this.net.reduce((a, n) => a + size(n), 0);
    while (this.net.length > 300 || (total > maxBytes && this.net.length > 1)) total -= size(this.net.shift()!);
  }

  /** Interrupts over the page right now (modals, banners, captchas), as one line each for the model. */
  async overlays(): Promise<string> {
    const found = await this.adapter?.evaluate<any[]>("window.__a2flow ? window.__a2flow.detectOverlays() : []").catch(() => []) ?? [];
    for (const o of found) if (!this.overlaysSeen.some((x) => x.selector === o.selector)) this.overlaysSeen.push(o);
    return found.map((o) => `- ${o.kind} (${o.coverage}% of viewport) ${o.selector} "${o.text.slice(0, 80)}"${o.closers.length ? ` · close: ${o.closers.map((c: any) => `${c.selector} "${c.label}"`).join(" | ")}` : " · no close control found"}`).join("\n");
  }
  /** Every distinct overlay seen this session/run (for run reports). */
  overlaysSeen: { kind: string; selector: string; text: string; closers: { selector: string; label: string }[] }[] = [];

  // ---------------- readiness ----------------

  private inflight = new Set<string>();
  private bytesIn = 0;
  lastBench?: Bench;
  private lastNetAt = 0;
  /**
   * "Content has loaded": ≤ 2 requests in flight (feeds keep long-polls/analytics open) for `quietMs`, and the
   * images in the viewport have decoded — so a scroll never starts on skeletons and a scene ends on the result.
   */
  async ready(quietMs = 500, timeoutMs = 8000) {
    const a = this.adapter;
    if (!a) return;
    const end = Date.now() + timeoutMs;
    let lastSig = "", stableSince = Date.now();
    while (Date.now() < end) {
      const quiet = this.inflight.size <= 2 && Date.now() - this.lastNetAt >= quietMs;
      // in-viewport content: decoded images, pending images, visible skeleton/placeholder/shimmer elements, DOM size
      const st = await a.evaluate<{ loaded: number; pending: number; skeletons: number; nodes: number }>(`(() => {
        const inView = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 8 && r.height > 8; };
        const imgs = [...document.images].filter(inView);
        const skel = [...document.querySelectorAll('[class*="keleton" i],[class*="placeholder" i],[class*="shimmer" i],[aria-busy="true"]')].filter(inView).length;
        return { loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, pending: imgs.filter((i) => !i.complete).length, skeletons: skel, nodes: document.querySelectorAll('body *').length };
      })()`).catch(() => ({ loaded: 0, pending: 0, skeletons: 0, nodes: 0 }));
      const sig = `${st.loaded}|${st.nodes}`;
      if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); }
      if (quiet && st.pending === 0 && st.skeletons === 0 && Date.now() - stableSince >= 400) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // ---------------- screencast (scene-scoped) ----------------

  private casting = false;
  private async castOn() {
    if (this.casting || !this.adapter) return;
    this.casting = true;
    await this.adapter.cdp("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 960, everyNthFrame: 2 }).catch(() => {});
  }
  private async castOff() {
    if (!this.casting || !this.adapter) return;
    this.casting = false;
    await this.adapter.cdp("Page.stopScreencast").catch(() => {});
  }
  /** One crisp frame of the current viewport (the resting still between scenes). */
  async still(): Promise<string | undefined> {
    if (!this.adapter) return;
    try {
      const [w, h, sy] = await this.adapter.evaluate<[number, number, number]>("[innerWidth, innerHeight, scrollY]");
      const r = await this.adapter.cdp<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: 0, y: sy, width: w, height: h, scale: Math.min(1, 960 / w) } });
      this.lastFrame = r.data;
      this.emit("event", { type: "frame", data: r.data });
      return r.data;
    } catch { return; }
  }

  // ---------------- scenes ----------------

  /** Open a scene: frames, facets, acts and A2UI are buffered (not streamed) until it closes. */
  beginScene(label: string, kind: Timeline["kind"] = "action"): Timeline {
    if (this.scene && !this.scene.done) this.endScene();
    const sc: Timeline = { id: `${kind}-${Date.now()}`, label, kind, t0: Date.now(), done: false, frames: [], facets: [], a2ui: [], acts: [], marks: [] };
    if (this.lastFrame) sc.frames.push({ t: 0, data: Buffer.from(this.lastFrame, "base64") }); // start from what's on screen
    this.scene = sc;
    this.scenes.push(sc);
    void this.castOn();
    if (this.scenes.length > 60) this.scenes.splice(0, this.scenes.length - 60);
    if (this.lastFacets) sc.facets.push({ t: 0, snap: this.lastFacets });
    this.emit("event", { type: "scene", ...this.sceneSummary(sc) });
    return sc;
  }

  endScene() {
    const sc = this.scene;
    if (!sc || sc.done) return;
    void this.castOff();
    sc.done = true;
    if (sc.frames.length) this.lastFrame = sc.frames.at(-1)!.data.toString("base64");
    this.emit("event", { type: "scene", ...this.sceneSummary(sc) });
    if (this.lastFrame) this.emit("event", { type: "frame", data: this.lastFrame }); // resting still
  }

  /** Run `fn` inside a scene (the agent's browser tools, UI clicks/scrolls). */
  async inScene<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.beginScene(label);
    try { return await fn(); } finally {
      await this.ready(500, 6000); // the scene ends on the loaded result, not mid-load
      await new Promise((r) => setTimeout(r, 200)); // let it paint
      await this.refreshFacets(); this.endScene();
    }
  }

  /** Keep total buffered frames bounded: oldest scenes lose their frames first. */
  private evictFrames(max = 4000) {
    let total = this.scenes.reduce((a, s) => a + s.frames.length, 0);
    for (const s of this.scenes) { if (total <= max || s === this.scene) break; total -= s.frames.length; s.frames = []; }
  }

  sceneSummary(sc: Timeline) {
    return { id: sc.id, label: sc.label, kind: sc.kind, t0: sc.t0, done: sc.done, duration: (sc.done ? sc.frames.at(-1)?.t ?? 0 : Date.now() - sc.t0), frames: sc.frames.length, marks: sc.marks };
  }
  sceneData(id: string) {
    const sc = this.scenes.find((s) => s.id === id);
    return sc && { ...this.sceneSummary(sc), frameTimes: sc.frames.map((f) => f.t), facets: sc.facets, a2ui: sc.a2ui, acts: sc.acts };
  }
  sceneFrame(id: string, i: number) { return this.scenes.find((s) => s.id === id)?.frames[i]?.data; }

  timelineSummary() { return this.sceneSummary(this.timeline!); }
  /** Last run's scene (compat). */
  timelineData() { return this.timeline ? this.sceneData(this.timeline.id) : null; }
  frameAt(i: number) { return this.timeline?.frames[i]?.data; }

  // ---------------- schema / manifest ----------------

  proposeSchema(s: SchemaProposal) { this.schema = s; this.broadcast({ type: "schema", schema: s }); }

  async deriveView(viewId: string, urls: string[]) {
    await this.ensure();
    const r = await derive(this.adapter!, { viewId, urls, outDir: `${this.opts.outDir ?? "out/studio"}/derive` });
    this.views[viewId] = r.view;
    if (!this.manifest && !this.facetDraft) { this.facetViews = this.views as Record<string, unknown>; this.scheduleFacets(0); }
    return r;
  }

  manifestEvent() {
    const m = this.manifest!;
    // full document for the code panel, minus machine evidence (fingerprint vectors)
    const doc = { ...m, views: Object.fromEntries(Object.entries(m.views ?? {}).map(([k, v]) => [k, { ...v, fingerprint: v.fingerprint ? { minSimilarity: v.fingerprint.minSimilarity } : undefined }])) };
    return { type: "manifest", id: m.id, views: Object.keys(m.views), routes: Object.keys(m.routes), valid: !this.manifestErrors.length, errors: this.manifestErrors.slice(0, 20), doc };
  }

  setManifest(m: FlowManifest) {
    // the model never sees fingerprint vectors (sanitised out), so carry them over from derived/previous views
    for (const [id, v] of Object.entries(m.views ?? {})) {
      // derived views: whatever the agent omits (components/anchors/actions/settle) comes from derive_view
      const d = this.views[id];
      if (d) {
        if (!v.components?.length) v.components = d.components;
        v.anchors ??= d.anchors;
        v.actions ??= d.actions;
        v.model = { ...d.model, ...(v.model ?? {}) };
        v.match ??= d.match;
      }
      v.fingerprint ??= this.views[id]?.fingerprint ?? this.manifest?.views[id]?.fingerprint;
    }
    this.manifest = m;
    this.manifestErrors = checkManifest(m);
    this.broadcast(this.manifestEvent());
    if (!this.facetDraft) { this.facetViews = m.views as Record<string, unknown>; this.scheduleFacets(0); }
    return this.manifestErrors;
  }

  /** Run the manifest on the live page (A2UI streams to the UI); stop after `maxSeconds`. */
  async run(inputs: Record<string, unknown>, maxSeconds = 120) {
    if (!this.manifest) throw new Error("no manifest yet — write_manifest first");
    if (this.manifestErrors.length) throw new Error(`manifest invalid:\n${this.manifestErrors.join("\n")}`);
    await this.ensure();
    if (this.phase !== "tune") this.setPhase("tune");
    this.a2uiBacklog = [];
    this.broadcast({ type: "a2ui-reset" });
    const runner = (this.runner = new MachineRunner(structuredClone(this.manifest), this.adapter!, inputs, { outDir: `${this.opts.outDir ?? "out/studio"}/run-${Date.now()}`, reuseOpenPage: true, seedNet: this.net.map((n) => ({ url: n.url, method: n.method, body: n.body })) }));
    runner.on("message", (msg) => this.broadcast({ type: "a2ui", msg }));
    runner.on("action", (msg) => this.broadcast({ type: "client", msg }));
    runner.on("log", (text) => this.broadcast({ type: "log", text: String(text) }));
    const tl: Timeline = (this.timeline = this.beginScene("run_manifest", "run"));
    this.facetDraft = false; this.facetViews = this.manifest.views as Record<string, unknown>;
    await this.adapter!.evaluate("window.__a2flow && window.__a2flow.clearAnnotations()").catch(() => {});
    this.broadcast({ type: "timeline", ...this.timelineSummary() });
    const mark = (m: Omit<Timeline["marks"][number], "t">) => { tl.marks.push({ t: Date.now() - tl.t0, ...m }); this.emit("event", { type: "timeline", ...this.timelineSummary() }); this.emit("event", { type: "scene", ...this.sceneSummary(tl) }); };
    runner.on("item", (e: { route: string; item: Record<string, unknown> }) => {
      const key = this.manifest?.routes[e.route]?.key;
      const k = key ? e.item[key] : undefined;
      mark({ kind: "record", route: e.route, key: k, label: `${e.route}${k != null ? ` ${String(k)}` : ""}` });
    });
    this.overlaysSeen = [];
    const handled = new Set<string>();
    runner.projector.on("interrupt", (e: { view: string; present: boolean }) => { if (e.present) handled.add(e.view); });
    // breadcrumb: states in order, loops folded back with a count (Open › Explore › More ×7)
    const crumbs: { state: string; n: number }[] = [];
    let batch: { route: string; item: unknown }[] = [], flushAt = 0, total = 0;
    const flush = () => { if (batch.length) { this.broadcast({ type: "records", items: batch, total }); batch = []; } };
    runner.on("item", (e: { route: string; item: unknown }) => {
      total++; batch.push(e);
      if (Date.now() - flushAt > 250) { flushAt = Date.now(); flush(); }
    });
    this.broadcast({ type: "records-reset" });
    runner.on("state", (s: { value: unknown; context?: Record<string, unknown> }) => {
      const leaf = typeof s.value === "string" ? s.value : JSON.stringify(s.value);
      const i = crumbs.findIndex((c) => c.state === leaf);
      if (i >= 0) { crumbs.length = i + 1; crumbs[i].n++; } else crumbs.push({ state: leaf, n: 1 });
      this.broadcast({ type: "breadcrumb", crumbs: crumbs.map((c) => ({ ...c })) });
      void this.overlays();
      mark({ kind: "state", label: typeof s.value === "string" ? s.value : JSON.stringify(s.value) });
      this.machineState = { value: s.value, at: Date.now() };
      this.broadcast({ type: "machine", ...this.machineState });
      this.scheduleFacets(0);
    });
    runner.on("fault", (f: { reason: string }) => mark({ kind: "fault", label: f.reason }));
    const timer = setTimeout(() => runner.abort(`stopped after ${maxSeconds}s (studio time budget)`), maxSeconds * 1000);
    // benchmark: Node CPU (orchestration + extraction), browser renderer task time, bytes received, wall time
    await this.adapter!.cdp("Performance.enable").catch(() => {});
    const taskTime = async () => ((await this.adapter!.cdp<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
    const cpu0 = process.cpuUsage(), task0 = await taskTime(), bytes0 = this.bytesIn, wall0 = Date.now();
    let error: string | undefined;
    try { this.lastResults = await runner.run(); }
    catch (e) { error = String((e as Error).message ?? e); this.lastResults = runner.results; }
    finally { clearTimeout(timer); }
    await this.refreshFacets();
    this.endScene();
    this.broadcast({ type: "timeline", ...this.timelineSummary() });
    flush();
    const cpu = process.cpuUsage(cpu0);
    const records = Object.values(this.lastResults).reduce((a, v) => a + v.length, 0);
    this.lastBench = { records, wallMs: Date.now() - wall0, nodeCpuMs: (cpu.user + cpu.system) / 1000, browserCpuMs: Math.max(0, (await taskTime()) - task0), bytes: this.bytesIn - bytes0, cpuMHz: cpus()[0]?.speed || 3000 };
    await this.overlays();
    const declared = Object.entries(this.manifest!.views).filter(([, v]) => v.interrupt).map(([k]) => k);
    // why did paging stop? the last captured response for each net source's URL, with its paging keys
    const paging: Record<string, unknown> = {};
    for (const v of Object.values(this.manifest!.views)) for (const ex of Object.values(v.model ?? {})) {
      for (const n of ([] as any[]).concat((ex as any).net ?? [])) {
        const re = new RegExp(n.url);
        const last = [...this.net].reverse().find((x) => re.test(x.url));
        const body = last?.body as Record<string, unknown> | undefined;
        if (body && typeof body === "object") paging[n.url] = Object.fromEntries(Object.entries(body).filter(([k, x]) => /cursor|hasmore|has_more|next|offset|total|status/i.test(k) && (x == null || typeof x !== "object")));
      }
    }
    return { error, results: this.lastResults, stats: runner.stats, faults: runner.faults, paging,
      interrupts: { declared, handled: [...handled], seenOnPage: this.overlaysSeen.map((o) => `${o.kind} ${o.selector}${o.closers[0] ? ` (close: ${o.closers[0].selector})` : ""}`) } };
  }

  /** After parity: the production run — bench + cost estimate + the manifest as a downloadable artifact. */
  async runAtScale(inputs: Record<string, unknown>, maxSeconds = 600) {
    this.setPhase("production");
    const r = await this.run(inputs, maxSeconds);
    const b = this.lastBench!;
    const brand = (new URL(this.manifest!.target.baseUrl).hostname.split(".").find((p) => !["www", "m"].includes(p)) ?? "");
    const apify = await apifyPrices(brand).catch(() => []);
    const md = benchMarkdown(b, apifyRows(apify));
    this.broadcast({ type: "bench", bench: b, perItem: perItem(b), costs: costTable(b), apify, markdown: md });
    const name = `${this.manifest!.id}.a2flow.json`;
    const dir = join(this.opts.outDir ?? "out/studio", "artifacts");
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(this.manifest, null, 2);
    writeFileSync(join(dir, name), body);
    this.artifacts.set(name, join(dir, name));
    this.broadcast({ type: "artifact", name, url: `/session/artifacts/${encodeURIComponent(name)}`, bytes: body.length, records: b.records });
    return { ...r, bench: b, markdown: md, artifact: name };
  }
  artifacts = new Map<string, string>();

  setExpected(records: ExpectedRecord[]) { this.expected = records; this.broadcast({ type: "expected", records }); }

  computeParity(): ParityReport {
    const keys = Object.fromEntries(Object.entries(this.manifest?.routes ?? {}).map(([k, r]) => [r.dataset ?? k, r.key]));
    this.lastParity = parity(this.expected, this.lastResults, keys);
    this.broadcast({ type: "parity", ...this.lastParity, mismatches: this.lastParity.mismatches.slice(0, 50) });
    return this.lastParity;
  }

  async scrollTo(ratio: number) {
    await this.adapter?.evaluate(`window.scrollTo({ top: ${Math.max(0, Math.min(1, ratio))} * (document.documentElement.scrollHeight - innerHeight) })`).catch(() => {});
  }
}
