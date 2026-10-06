"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { FacetSnapshot, SceneSummary } from "./facets";

export type Phase = "discover" | "design" | "tune" | "production";
export type Highlight = {
  id: string;
  label: string;
  kind: "input" | "output" | "action" | "mapping";
  rect: { x: number; y: number; width: number; height: number };
};
export type Schema = {
  inputs: { name: string; kind?: string; description?: string; example?: unknown }[];
  outputs: Record<string, { description?: string; fields: { name: string; type?: string; description?: string }[] }>;
};
export type Parity = { score: number; coverage: number; mismatches: unknown[] };
export type Manifest = { id: string; views: unknown[]; routes: unknown[]; valid: boolean; errors: unknown[]; doc?: Record<string, any> };
export type Act = { kind: "scroll" | "click" | "navigate" | "back" | "key" | "type"; at: number; dir?: "up" | "down"; amount?: number; x?: number; y?: number; url?: string; key?: string; text?: string; target?: string };
export type ExpectedRecord = { route: string; record: Record<string, unknown> };
export type Research = { site: string; cached: boolean; ms: number; brief: string };

// ---------------- production (run_at_scale) ----------------
export type LiveRecord = { route: string; item: Record<string, unknown>; n: number };
export type Crumb = { state: string; n: number };
export type Bench = { records: number; wallMs: number; nodeCpuMs: number; browserCpuMs: number; bytes: number; cpuMHz: number };
export type PerItem = { wallMs: number; cpuMs: number; extractCpuMs: number; cycles: number; bytes: number };
export type CostRow = { platform: string; runs: "browser" | "extract-only"; note: string; source: string; costs: Record<string, number> };
export type ApifyRow = { actor: string; users: number; model: string; perItem: number | null; perItemBest: number | null; perRun: number; monthly?: number | null; note: string };
export type BenchReport = { bench: Bench; perItem: PerItem; costs: CostRow[]; apify: ApifyRow[]; markdown: string };
export type Artifact = { name: string; url: string; bytes: number; records: number; at: number };
export type ActorKind = "start" | "log" | "item" | "unit" | "fault" | "done" | "exit";
export type ActorLine = { kind: ActorKind; line: string; at: number; route?: string; item?: unknown; name?: string; code?: number | null; n: number };
export type ActorState = { running: boolean; name: string | null; startedAt: number | null; endedAt: number | null; lines: ActorLine[]; items: ActorLine[]; code: number | null };
export type Production = {
  records: LiveRecord[];
  total: number;
  /** wall clock of the scale run: records-reset → artifact */
  startedAt: number | null;
  endedAt: number | null;
  crumbs: Crumb[];
  report: BenchReport | null;
  artifact: Artifact | null;
};
const RECORDS_CAP = 20000;
const ACTOR_CAP = 3000;

export type SessionState = {
  connected: boolean;
  phase: Phase;
  url: string;
  frame: string | null;
  schema: Schema | null;
  highlights: Highlight[];
  viewport: { width: number; height: number } | null;
  parity: Parity | null;
  manifest: Manifest | null;
  logs: string[];
  scroll: { ratio: number; n: number };
  /** live facet feed (current page × draft/written manifest views) */
  facets: FacetSnapshot | null;
  /** buffered scenes in time order (played back by the scene player) */
  scenes: SceneSummary[];
  expected: ExpectedRecord[];
  /** last input sent to the page (HUD) */
  act: Act | null;
  /** live XState value of the runner */
  machine: { value: unknown; at: number } | null;
  /** latest research_site brief (markdown) */
  research: Research | null;
  production: Production;
  actor: ActorState;
};

const initial: SessionState = {
  connected: false,
  phase: "discover",
  url: "",
  frame: null,
  schema: null,
  highlights: [],
  viewport: null,
  parity: null,
  manifest: null,
  logs: [],
  scroll: { ratio: 0, n: 0 },
  facets: null,
  scenes: [],
  expected: [],
  act: null,
  machine: null,
  research: null,
  production: { records: [], total: 0, startedAt: null, endedAt: null, crumbs: [], report: null, artifact: null },
  actor: { running: false, name: null, startedAt: null, endedAt: null, lines: [], items: [], code: null },
};
let seq = 0;
const prod = (p: Partial<Production>) => set({ production: { ...state.production, ...p } });

let state: SessionState = initial;
const listeners = new Set<() => void>();
const set = (patch: Partial<SessionState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

// A2UI messages are kept as a backlog (replayed when the A2UI panel mounts) and fanned out to subscribers.
const a2uiBacklog: unknown[] = [];
const a2uiSubs = new Set<(msg: any) => void>();
export const a2uiStore = {
  backlog: () => a2uiBacklog,
  subscribe(cb: (msg: any) => void) {
    a2uiSubs.add(cb);
    return () => void a2uiSubs.delete(cb);
  },
};

/** Upsert scene summaries (kept sorted by start time); no-op when nothing changed. */
export function mergeScenes(list: SceneSummary[]) {
  const map = new Map(state.scenes.map((s) => [s.id, s]));
  let changed = false;
  for (const n of list) {
    const o = map.get(n.id);
    if (o && o.done === n.done && o.duration === n.duration && o.frames === n.frames && o.label === n.label && o.marks.length === (n.marks?.length ?? 0)) continue;
    map.set(n.id, { ...n, marks: n.marks ?? [] });
    changed = true;
  }
  if (changed) set({ scenes: [...map.values()].sort((a, b) => a.t0 - b.t0) });
}

function handle(ev: any) {
  switch (ev.type) {
    case "frame": set({ frame: ev.data }); break;
    case "phase": set({ phase: ev.phase }); break;
    case "url": set({ url: ev.url }); break;
    case "log": set({ logs: [...state.logs.slice(-199), String(ev.text)] }); break;
    case "schema": set({ schema: ev.schema }); break;
    case "highlights": set({ highlights: ev.items ?? [], viewport: ev.viewport ?? state.viewport }); break;
    case "a2ui":
      a2uiBacklog.push(ev.msg);
      if (a2uiBacklog.length > 5000) a2uiBacklog.splice(0, a2uiBacklog.length - 5000);
      a2uiSubs.forEach((s) => s(ev.msg));
      break;
    case "client": {
      set({ logs: [...state.logs.slice(-199), `client: ${JSON.stringify(ev.msg?.action?.name ?? ev.msg)}`] });
      // client actions join the a2ui stream (renderers skip them; the A2UI log shows them)
      const m = { clientAction: ev.msg };
      a2uiBacklog.push(m);
      a2uiSubs.forEach((sub) => sub(m));
      break;
    }
    case "scroll": set({ scroll: { ratio: Number(ev.ratio) || 0, n: state.scroll.n + 1 } }); break;
    case "parity": set({ parity: { score: ev.score, coverage: ev.coverage, mismatches: ev.mismatches ?? [] } }); break;
    case "manifest": set({ manifest: { id: ev.id, views: ev.views ?? [], routes: ev.routes ?? [], valid: !!ev.valid, errors: ev.errors ?? [], doc: ev.doc } }); break;
    case "facets": { const { type: _t, ...snap } = ev; set({ facets: snap as FacetSnapshot }); break; }
    case "scene": { const { type: _t, ...sc } = ev; mergeScenes([sc as SceneSummary]); break; }
    case "act": { const { type: _t, ...a } = ev; set({ act: a as Act }); break; }
    case "machine": set({ machine: { value: ev.value, at: Number(ev.at) || Date.now() } }); break;
    case "expected": set({ expected: ev.records ?? [] }); break;
    case "records-reset": prod({ records: [], total: 0, startedAt: Date.now(), endedAt: null, crumbs: [], report: null, artifact: null }); break;
    case "records": {
      const add: LiveRecord[] = (Array.isArray(ev.items) ? ev.items : []).map((x: any) => ({ route: String(x?.route ?? ""), item: x?.item && typeof x.item === "object" ? x.item : { value: x?.item }, n: ++seq }));
      const records = state.production.records.concat(add);
      prod({ records: records.length > RECORDS_CAP ? records.slice(-RECORDS_CAP) : records, total: Number(ev.total) || records.length, startedAt: state.production.startedAt ?? Date.now() });
      break;
    }
    case "breadcrumb": prod({ crumbs: Array.isArray(ev.crumbs) ? ev.crumbs : [] }); break;
    case "bench": prod({ report: { bench: ev.bench, perItem: ev.perItem, costs: ev.costs ?? [], apify: ev.apify ?? [], markdown: ev.markdown ?? "" } }); break;
    case "artifact": prod({ artifact: { name: String(ev.name), url: String(ev.url), bytes: Number(ev.bytes) || 0, records: Number(ev.records) || 0, at: Date.now() }, endedAt: Date.now() }); break;
    case "actor": {
      const a = state.actor;
      const line: ActorLine = { kind: ev.kind, line: String(ev.line ?? ""), at: Number(ev.at) || Date.now(), route: ev.route, item: ev.item, name: ev.name, code: ev.code, n: ++seq };
      const cap = (xs: ActorLine[]) => (xs.length > ACTOR_CAP ? xs.slice(-ACTOR_CAP) : xs);
      if (line.kind === "start") set({ actor: { running: true, name: line.name ?? a.name, startedAt: line.at, endedAt: null, lines: [line], items: [], code: null } });
      else if (line.kind === "item") set({ actor: { ...a, items: cap([...a.items, line]) } });
      else if (line.kind === "exit") set({ actor: { ...a, running: false, endedAt: line.at, code: line.code ?? 0, lines: cap([...a.lines, line]) } });
      else set({ actor: { ...a, lines: cap([...a.lines, line]) } });
      break;
    }
    case "research": set({ research: { site: String(ev.site ?? ""), cached: !!ev.cached, ms: Number(ev.ms) || 0, brief: String(ev.brief ?? "") } }); break;
  }
}

/** Mount once near the root: opens the SSE connection (EventSource auto-reconnects; we also recreate on hard close). */
export function useSessionEvents() {
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      es = new EventSource("/session/events");
      es.onopen = () => {
        // server replays state + a2ui backlog on connect: reset the local backlog to avoid duplicates
        a2uiBacklog.length = 0;
        a2uiSubs.forEach((s) => s({ __reset: true }));
        set({ connected: true });
      };
      es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch { /* ignore */ } };
      es.onerror = () => {
        set({ connected: false });
        if (es && es.readyState === EventSource.CLOSED && !stopped) {
          es.close();
          timer = setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); };
  }, []);
}

/** Feed actor events from a local source (the in-browser WASM actor) through the same reducer as SSE. */
export const pushActorEvent = (e: { kind: string; line?: string; at?: number; route?: string; item?: unknown; name?: string; code?: number | null }) =>
  handle({ ...e, type: "actor" });

/** Non-React access for the scene player. */
export const sessionStore = {
  get: () => state,
  subscribe(cb: () => void) { listeners.add(cb); return () => void listeners.delete(cb); },
};

export function useSession<T>(selector: (s: SessionState) => T): T {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => void listeners.delete(cb); },
    () => selector(state),
    () => selector(initial),
  );
}

export const sessionApi = {
  post: (path: string, body: unknown) =>
    fetch(`/session/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}),
};
