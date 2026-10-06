"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { FacetSnapshot, SceneSummary, TimelineMark } from "./facets";
import { mergeScenes, sessionStore, useSession, type Act, type Highlight } from "./session-store";

/**
 * Scene player. The session server buffers everything (agent actions, UI actions, runs) as scenes and
 * only streams a ~2fps "resting" still while idle. This module plays CLOSED scenes only, in order, on one
 * rAF clock (frame, facets, a2ui, acts, state marks), each fully fetched and decoded before it starts.
 * While a scene is still recording the last played frame is held (no live frames, no tail following);
 * live SSE values apply only when idle and caught up. `useBrowserView()` is the single read side.
 */

export interface SceneData extends SceneSummary {
  frameTimes: number[];
  facets: { t: number; snap: FacetSnapshot }[];
  a2ui: { t: number; msg: unknown }[];
  acts: { t: number; act: Act }[];
}

const SHORT = 300; // scenes shorter than this hold their last frame...
const HOLD = 250; // ...for at least this long
const MAX_CATCHUP = 2; // backlog speed-up is gentle
const SCENES_POLL = 2000; // scene list refresh (SSE is primary)
const CACHE = 12;

// ---------------------------------------------------------------- tiny stores

function store<T>(init: T) {
  let v = init;
  const ls = new Set<() => void>();
  return {
    get: () => v,
    set(n: T) { if (n !== v) { v = n; ls.forEach((l) => l()); } },
    sub: (cb: () => void) => { ls.add(cb); return () => void ls.delete(cb); },
  };
}
const merge = <T extends object>(cur: T, p: Partial<T>): T => {
  for (const k in p) if (p[k] !== cur[k]) return { ...cur, ...p };
  return cur;
};

interface View {
  snap: FacetSnapshot | null;
  act: { act: Act; key: string } | null;
  /** buffered a2ui messages up to now (null = follow the live stream) */
  a2ui: unknown[] | null;
  /** caught up: showing the resting still + live feed */
  live: boolean;
  hasImage: boolean;
  /** state marks of the scene on screen, and the index at the playhead (state machine replay) */
  stateMarks: TimelineMark[] | null;
  stateIdx: number;
}
interface PB { view: View; cur: string | null; shown: string | null; paused: boolean; speed: number; eff: number; recording: boolean }

const pbS = store<PB>({
  view: { snap: null, act: null, a2ui: null, live: true, hasImage: false, stateMarks: null, stateIdx: -1 },
  cur: null, shown: null, paused: false, speed: 1, eff: 1, recording: false,
});
const imgS = store<HTMLImageElement | null>(null); // frame swaps never re-render the overlay tree
const clockS = store(0); // playhead (ms into the current scene)

const patchPb = (p: Partial<PB>) => pbS.set(merge(pbS.get(), p));
const patchView = (p: Partial<View>) => patchPb({ view: merge(pbS.get().view, p) });
const setImage = (im: HTMLImageElement) => { imgS.set(im); patchView({ hasImage: true }); };

export interface ConsoleLine { level: "log" | "warn" | "error"; message: string; timestamp: Date }
const consoleS = store<ConsoleLine[]>([]);
const pushLog = (level: ConsoleLine["level"], message: string) => consoleS.set([...consoleS.get().slice(-199), { level, message, timestamp: new Date() }]);
const levelOf = (m: string): ConsoleLine["level"] => (/error|fail|exception|fault/i.test(m) ? "error" : /warn/i.test(m) ? "warn" : "log");
function actText(a: Act) {
  switch (a.kind) {
    case "scroll": return `scroll ${a.dir ?? ""} ${a.amount ?? ""}`.trim();
    case "click": return `click ${Math.round(Number(a.x))},${Math.round(Number(a.y))}`;
    case "navigate": return `navigate ${a.url ?? ""}`;
    case "back": return "back";
    case "key": return `key ${a.key ?? ""}`;
    default: return "type";
  }
}

const useStore = <T, S>(s: { get: () => T; sub: (cb: () => void) => () => void }, sel: (v: T) => S): S =>
  useSyncExternalStore(s.sub, () => sel(s.get()), () => sel(s.get()));

export const usePlayback = <T,>(sel: (s: PB) => T): T => useStore(pbS, sel);
export const usePlayhead = () => useStore(clockS, (v) => v);
export const useConsole = () => useStore(consoleS, (v) => v);
export const useBrowserImage = () => useStore(imgS, (v) => v);
/** a scene is still being recorded server-side (the player holds its last frame meanwhile) */
export const useRecording = () => useStore(pbS, (v) => v.recording);

// ---------------------------------------------------------------- loading

interface Loaded {
  id: string;
  data: SceneData;
  imgs: HTMLImageElement[];
  ok: boolean[];
  dec: Promise<void>[];
  tf: number[]; ts: number[]; ta: number[]; tc: number[]; // frame / facet / a2ui / act times
  stateMarks: TimelineMark[];
  final: boolean;
  ci: number; ai: number; aArr: unknown[];
}

const cache = new Map<string, Loaded>();
const inflight = new Map<string, Promise<Loaded>>();
const played = new Set<string>();
let cur: Loaded | null = null;
let pending: string | null = null;
let pos = 0;
let ready = false;

const scenes = () => sessionStore.get().scenes;
const isPlayable = (s: SceneSummary) => s.done;
const anyRecording = () => scenes().some((s) => !s.done);
const firstUnplayed = () => scenes().find((s) => !played.has(s.id));
const playableEnd = (l: Loaded) => l.data.duration;

/** last index i with arr[i] <= t (or -1) */
export function lastAtOrBefore(arr: number[], t: number): number {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

function ingest(raw: SceneData): Loaded {
  const d: SceneData = { ...raw, marks: raw.marks ?? [], frameTimes: raw.frameTimes ?? [], facets: raw.facets ?? [], a2ui: raw.a2ui ?? [], acts: raw.acts ?? [] };
  const l = cache.get(d.id) ?? { id: d.id, imgs: [], ok: [], dec: [], ci: -1, ai: -2, aArr: [] } as unknown as Loaded;
  l.data = d;
  l.final = !!d.done;
  l.tf = d.frameTimes; l.ts = d.facets.map((f) => f.t); l.ta = d.a2ui.map((m) => m.t); l.tc = d.acts.map((a) => a.t);
  l.stateMarks = d.marks.filter((m) => m.kind === "state");
  for (let i = l.imgs.length; i < d.frameTimes.length; i++) {
    const im = new Image();
    im.decoding = "async";
    im.src = `/session/scenes/${d.id}/frame/${i}`;
    l.imgs.push(im); l.ok.push(false);
  }
  cache.delete(d.id); cache.set(d.id, l);
  for (const k of cache.keys()) { // evict least recently used, never the scene in play or queued
    if (cache.size <= CACHE) break;
    if (k !== cur?.id && k !== pending) cache.delete(k);
  }
  return l;
}

function decode(l: Loaded, i: number) {
  return (l.dec[i] ??= l.imgs[i].decode().then(
    () => { l.ok[i] = true; if (cur === l && !raf) render(); },
    () => {},
  ));
}
/** every frame decoded: scenes are small, and a fully buffered scene plays without a single hitch */
const settled = (l: Loaded) => Promise.all(l.imgs.map((_, i) => decode(l, i)));

async function fetchScene(id: string) {
  const r = await fetch(`/session/scenes/${id}`);
  if (!r.ok) throw new Error(String(r.status));
  return ingest((await r.json()) as SceneData);
}

async function load(id: string): Promise<Loaded> {
  const hit = cache.get(id);
  if (hit?.final && hit.imgs.length === hit.data.frameTimes.length) { await settled(hit); return hit; }
  let p = inflight.get(id);
  if (!p) { p = fetchScene(id).finally(() => inflight.delete(id)); inflight.set(id, p); }
  const l = await p;
  await settled(l);
  return l;
}

/** Keep the next couple of closed scenes fetched and their first frames decoded. */
function warm() {
  let n = 0;
  for (const s of scenes()) {
    if (played.has(s.id) || s.id === cur?.id || s.id === pending) continue;
    if (!s.done) break;
    void load(s.id).catch(() => {});
    if (++n >= 2) break;
  }
}

// ---------------------------------------------------------------- clock

let raf = 0;
let last = 0;
let holdUntil = 0;

function effSpeed() {
  const backlog = scenes().filter((s) => s.done && !played.has(s.id) && s.id !== cur?.id).length;
  const speed = pbS.get().speed;
  return backlog > 1 ? Math.max(speed, Math.min(MAX_CATCHUP, speed * (1 + backlog * 0.25))) : speed;
}

function run() {
  if (raf || !cur || pbS.get().paused) return;
  last = performance.now();
  raf = requestAnimationFrame(tick);
}
function stop() { cancelAnimationFrame(raf); raf = 0; }

function tick(now: number) {
  raf = 0;
  const l = cur;
  if (!l || pbS.get().paused) return;
  const dt = Math.min(now - last, 100);
  last = now;
  if (holdUntil) {
    if (now >= holdUntil) { holdUntil = 0; finish(); return; }
  } else {
    const end = playableEnd(l);
    const eff = effSpeed();
    patchPb({ eff });
    if (pos < end) pos = Math.min(end, pos + dt * eff);
    render();
    if (pos >= end) {
      if (l.data.duration < SHORT) holdUntil = now + HOLD;
      else { finish(); return; }
    }
  }
  raf = requestAnimationFrame(tick);
}

/** Paint the scene at `pos`: frame (only once decoded), facets, a2ui, acts, state marks. */
function render() {
  const l = cur;
  if (!l) return;
  clockS.set(pos);
  const fi = lastAtOrBefore(l.tf, pos);
  for (let k = fi + 1; k <= fi + 8 && k < l.imgs.length; k++) void decode(l, k);
  if (fi >= 0) void decode(l, fi);
  let k = fi;
  while (k >= 0 && !l.ok[k] && fi - k < 60) k--;
  if (k >= 0 && l.ok[k] && l.imgs[k] !== imgS.get()) setImage(l.imgs[k]);

  const p: Partial<View> = { live: false, stateMarks: l.stateMarks.length ? l.stateMarks : null, stateIdx: lastAtOrBefore(l.stateMarks.map((m) => m.t), pos) };
  const si = lastAtOrBefore(l.ts, pos);
  if (si >= 0) p.snap = l.data.facets[si].snap; // before the first snapshot, the previous one carries over
  if (l.data.a2ui.length) {
    const ai = lastAtOrBefore(l.ta, pos);
    if (ai !== l.ai) { l.ai = ai; l.aArr = l.data.a2ui.slice(0, ai + 1).map((m) => m.msg); }
    p.a2ui = l.aArr;
  } else p.a2ui = null;
  const ci = lastAtOrBefore(l.tc, pos);
  if (ci > l.ci) { l.ci = ci; p.act = { act: l.data.acts[ci].act, key: `pb${++actSeq}` }; pushLog("log", `act: ${actText(l.data.acts[ci].act)}`); }
  patchView(p);
}
let actSeq = 0;

function start(l: Loaded, at = 0) {
  cur = l; pending = null; holdUntil = 0;
  pos = Math.min(at, playableEnd(l));
  l.ci = at > 0 ? lastAtOrBefore(l.tc, pos) : -1; // seeks don't replay earlier acts
  l.ai = -2;
  patchPb({ cur: l.id, shown: l.id });
  pushLog(l.data.kind === "run" ? "warn" : "log", `scene: ${l.data.label}`);
  render();
  run();
}

function finish() {
  if (cur) played.add(cur.id);
  cur = null; holdUntil = 0; stop();
  schedule();
}

function goLive() {
  stop(); cur = null; holdUntil = 0;
  patchPb({ cur: null });
  if (anyRecording()) return;
  patchView({ live: true, a2ui: null, stateMarks: null, stateIdx: -1 });
}

/** Live feed applies only when idle and caught up: nothing playing, queued or still recording. */
const isLiveNow = () => !cur && !pending && !pbS.get().paused && !firstUnplayed() && !anyRecording();

function schedule() {
  if (!ready || pbS.get().paused) return;
  warm();
  if (cur || pending) return;
  const next = firstUnplayed();
  if (!next) { if (!anyRecording()) goLive(); return; } // caught up (a recording scene holds the last frame)
  if (!isPlayable(next)) return; // the next scene is still recording: hold until it closes
  pending = next.id;
  patchView({ live: false });
  load(next.id).then(
    (l) => { if (pending !== next.id) return; pending = null; if (!cur && !pbS.get().paused) start(l); },
    () => { if (pending !== next.id) return; pending = null; if (next.done) { played.add(next.id); schedule(); } },
  );
}

function jump(id: string, frac = 0) {
  const all = scenes();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0 || !isPlayable(all[idx])) return;
  played.clear();
  all.slice(0, idx).forEach((s) => played.add(s.id));
  stop(); cur = null; pending = id;
  load(id).then(
    (l) => { if (pending === id) start(l, frac * l.data.duration); },
    () => { if (pending === id) pending = null; },
  );
}

// ---------------------------------------------------------------- live feed (caught up)

let restTok = 0;
function onFrame() {
  const f = sessionStore.get().frame;
  if (!f || !isLiveNow()) return;
  const tok = ++restTok, im = new Image();
  im.src = `data:image/jpeg;base64,${f}`;
  im.decode().then(() => { if (tok === restTok && isLiveNow()) setImage(im); }, () => {});
}
function onFacets() { const f = sessionStore.get().facets; if (f && isLiveNow()) patchView({ snap: f }); }
function onAct() { const a = sessionStore.get().act; if (a && isLiveNow()) { patchView({ act: { act: a, key: `live${a.at}` } }); pushLog("log", `act: ${actText(a)}`); } }
function applyLive() { onFacets(); onFrame(); }

function onScenes() {
  const recording = anyRecording();
  if (pbS.get().recording !== recording) patchPb({ recording });
  if (!ready) return;
  schedule();
  if (isLiveNow()) applyLive();
}

/** Safety net for missed SSE scene events: refresh the scene list (summaries only, never a recording's frames). */
async function pollScenes() {
  if (!ready) return;
  try {
    const r = await fetch("/session/scenes");
    const j = await r.json();
    mergeScenes(Array.isArray(j) ? j : (j?.scenes ?? []));
  } catch { /* offline */ }
}

// ---------------------------------------------------------------- public API

export const playback = {
  play() {
    patchPb({ paused: false });
    if (cur) {
      if (pos >= playableEnd(cur)) { if (firstUnplayed()) finish(); else start(cur, 0); }
      else run();
    } else { schedule(); if (isLiveNow()) applyLive(); }
  },
  pause() { patchPb({ paused: true }); stop(); },
  speed(speed: number) { patchPb({ speed, eff: effSpeed() }); },
  /** jump to a scene (optionally part-way in) and keep playing the queue from there */
  jump,
  prev() {
    const all = scenes(), i = all.findIndex((s) => s.id === pbS.get().shown);
    if (i < 0) { if (all.length) jump(all[all.length - 1].id); return; }
    jump(cur && pos > 1000 ? all[i].id : all[Math.max(0, i - 1)].id);
  },
  next() {
    const all = scenes(), i = all.findIndex((s) => s.id === pbS.get().shown);
    if (i >= 0 && i < all.length - 1) jump(all[i + 1].id); else playback.live();
  },
  /** jump to the end and follow */
  live() {
    scenes().forEach((s) => { if (s.done) played.add(s.id); }); // a recording scene still plays once it closes
    stop(); cur = null; pending = null;
    patchPb({ paused: false, shown: scenes().at(-1)?.id ?? null });
    goLive();
    applyLive();
  },
};

/** Mount once: wires the session store to the player, seeds the "already seen" baseline, polls open runs. */
export function usePlaybackDriver() {
  useEffect(() => {
    let alive = true;
    let prev = sessionStore.get();
    const unsub = sessionStore.subscribe(() => {
      const s = sessionStore.get();
      const p = prev;
      prev = s;
      if (s.scenes !== p.scenes) onScenes();
      if (s.frame !== p.frame) onFrame();
      if (s.facets !== p.facets) onFacets();
      if (s.act !== p.act) onAct();
      if (s.logs !== p.logs && s.logs.length) { const m = s.logs[s.logs.length - 1]; pushLog(levelOf(m), m); }
    });
    const iv = setInterval(() => void pollScenes(), SCENES_POLL);

    (async () => {
      try {
        const r = await fetch("/session/scenes");
        const j = await r.json();
        mergeScenes(Array.isArray(j) ? j : (j?.scenes ?? []));
      } catch { /* the store's own scenes (SSE) are the fallback */ }
      if (!alive) return;
      // history present at load isn't replayed; only scenes that close afterwards are
      for (const s of scenes()) if (s.done) played.add(s.id);
      patchPb({ shown: scenes().filter((s) => s.done).at(-1)?.id ?? null });
      ready = true;
      applyLive();
      onScenes();
    })();

    return () => { alive = false; unsub(); clearInterval(iv); };
  }, []);
}

// ---------------------------------------------------------------- consumers

export interface BrowserView extends View {
  highlights: Highlight[];
  viewport: [number, number];
}

/** What the browser shows: the scene being played, or (caught up) the resting still + live facets/acts. */
export function useBrowserView(): BrowserView {
  const view = usePlayback((s) => s.view);
  const highlights = useSession((s) => s.highlights);
  const vp = useSession((s) => s.viewport);
  return useMemo(() => ({
    ...view,
    highlights: view.live ? highlights : [],
    viewport: view.snap?.viewport ?? (vp ? [vp.width, vp.height] : [1280, 900]),
  }), [view, highlights, vp]);
}
