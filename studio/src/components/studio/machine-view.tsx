"use client";

import "@xyflow/react/dist/style.css";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import {
  BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { CircleXIcon, ScanIcon, ZapIcon } from "lucide-react";
import { Retro } from "./retro";
import { Button } from "@/components/ui/button";
import { usePlayback } from "@/lib/playback";
import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------- graph model

type NodeKind = "initial" | "state" | "invoke" | "final" | "failure" | "ghost";
type EdgeKind = "init" | "event" | "always" | "done" | "error" | "child";
interface GNode { id: string; label: string; kind: NodeKind; src?: string; compound?: boolean }
interface GEdge { id: string; source: string; target: string; kind: EdgeKind; label?: string; title?: string }
interface Graph { nodes: GNode[]; edges: GEdge[] }

const INIT = "__initial";
const FAIL_NAME = /fail|error|abort|crash/i;

const strip = (v: unknown): string => {
  if (typeof v === "string") return v.replace(/\{\{\s*|\s*\}\}/g, "").replace(/\s*\|.*$/, "").replace(/^event\.(output\.)?/, "").trim();
  if (isObj(v)) {
    const [k, x] = Object.entries(v)[0] ?? [];
    if (k === "count" || k === "$count") return `count(${strip(x)})`;
    return k ? `${k}(${strip(x)})` : "";
  }
  return JSON.stringify(v);
};
const OPS: Record<string, string> = { eq: "=", ne: "≠", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" };

/** Guard → short human condition: {cond:{eq:[view,"notFound"]}} → "view = notFound". */
function guardText(g: unknown): string | undefined {
  if (!g) return undefined;
  if (typeof g === "string") return g;
  if (!isObj(g)) return undefined;
  const cond = (p: unknown): string => {
    if (!isObj(p)) return strip(p);
    return Object.entries(p).map(([op, v]) => {
      if (op === "or" || op === "and") return arr(v).map(cond).join(` ${op} `);
      if (op === "not") return `not ${cond(v)}`;
      if (OPS[op] && Array.isArray(v)) return `${strip(v[0])} ${OPS[op]} ${strip(v[1])}`;
      if (op === "empty") return `${strip(v)} empty`;
      if (op === "exists") return `${strip(v)} exists`;
      return `${op} ${strip(v)}`;
    }).join(" and ");
  };
  if (g.type === "cond" && g.params) return cond(g.params);
  return typeof g.type === "string" ? g.type : undefined;
}

function buildGraph(machine: unknown): Graph {
  const g: Graph = { nodes: [], edges: [] };
  if (!isObj(machine) || !isObj(machine.states)) return g;
  const rootId = typeof machine.id === "string" ? machine.id : "";
  const paths = new Set<string>();
  const collect = (states: Obj, prefix: string) => {
    for (const [name, st] of Object.entries(states)) {
      const p = prefix ? `${prefix}.${name}` : name;
      paths.add(p);
      if (isObj(st) && isObj(st.states)) collect(st.states, p);
    }
  };
  collect(machine.states, "");

  const resolve = (from: string, target: string): string | null => {
    if (target.startsWith("#")) {
      let t = target.slice(1);
      if (rootId && (t === rootId || t.startsWith(rootId + "."))) t = t.slice(rootId.length + 1);
      if (paths.has(t)) return t;
      return [...paths].find((p) => p.endsWith("." + t.split(".").pop()!)) ?? null;
    }
    if (target.startsWith(".")) return paths.has(`${from}${target}`) ? `${from}${target}` : null;
    const parts = from.split(".");
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = [...parts.slice(0, i), target].join(".");
      if (paths.has(p)) return p;
    }
    return paths.has(target) ? target : null;
  };

  // unresolved targets still end at a node: a dashed "ghost" one
  const ghosts = new Set<string>();
  const edge = (from: string, tgt: unknown, kind: EdgeKind, label?: string, title?: string) => {
    if (tgt == null) return; // targetless transition (actions only)
    const raw = String(tgt);
    let target = resolve(from, raw);
    if (!target) {
      target = `?${raw}`;
      if (!ghosts.has(target)) { ghosts.add(target); g.nodes.push({ id: target, label: raw, kind: "ghost" }); }
    }
    g.edges.push({ id: `${from}>${target}#${g.edges.length}`, source: from, target, kind, label, title: title ?? label });
  };
  /** a transition list: guarded branches get their condition, a trailing unguarded one becomes "else" */
  const transitions = (from: string, spec: unknown, kind: EdgeKind, base?: string) => {
    const list = arr(spec);
    const guarded = list.some((t) => isObj(t) && t.guard);
    list.forEach((t) => {
      if (typeof t === "string") { edge(from, t, kind, base); return; }
      if (!isObj(t)) return;
      const gt = guardText(t.guard);
      const cond = gt ?? (guarded ? "else" : undefined);
      const label = [base, cond].filter(Boolean).join(" · ") || undefined;
      edge(from, t.target, kind, label && label.length > 30 ? `${label.slice(0, 29)}…` : label, label);
    });
  };

  const walk = (states: Obj, prefix: string) => {
    for (const [name, st] of Object.entries(states)) {
      const p = prefix ? `${prefix}.${name}` : name;
      const s: Obj = isObj(st) ? st : {};
      const inv = arr(s.invoke).find(isObj) as Obj | undefined;
      const src = inv ? (typeof inv.src === "string" ? inv.src : isObj(inv.src) && typeof inv.src.type === "string" ? inv.src.type : "actor") : undefined;
      const entryFails = arr(s.entry).some((a) => (isObj(a) ? String(a.type ?? "") : String(a)).match(/\.fail$|fail/i));
      const kind: NodeKind = s.type === "final" ? "final" : FAIL_NAME.test(name) || entryFails ? "failure" : inv ? "invoke" : "state";
      g.nodes.push({ id: p, label: name, kind, src, compound: isObj(s.states) });
      if (isObj(s.on)) for (const [ev, spec] of Object.entries(s.on)) transitions(p, spec, "event", ev);
      if (s.always) transitions(p, s.always, "always");
      if (inv) {
        transitions(p, inv.onDone, "done", "done");
        transitions(p, inv.onError, "error", "error");
      }
      if (isObj(s.states)) {
        if (typeof s.initial === "string") edge(p, `.${s.initial}`, "child");
        walk(s.states, p);
      }
    }
  };
  walk(machine.states, "");
  if (typeof machine.initial === "string" && paths.has(machine.initial)) {
    g.nodes.unshift({ id: INIT, label: "", kind: "initial" });
    g.edges.unshift({ id: `${INIT}>${machine.initial}`, source: INIT, target: machine.initial, kind: "init" });
  }
  return g;
}

// ---------------------------------------------------------------- layout (dagre routes the edges too)

type Dir = "LR" | "TB";
interface Pt { x: number; y: number }
interface Laid { w: number; h: number; nodes: Record<string, { x: number; y: number; w: number; h: number }>; edges: Record<string, { points: Pt[]; label?: Pt }> }

function sizeOf(n: GNode): { w: number; h: number } {
  if (n.kind === "initial") return { w: 12, h: 12 };
  const text = n.label.length * 6.8 + 34;
  if (n.kind === "invoke") return { w: Math.round(Math.min(220, Math.max(112, text, (n.src?.length ?? 0) * 6 + 40))), h: 46 };
  if (n.kind === "final") return { w: Math.round(Math.min(200, Math.max(84, text + 8))), h: 32 };
  return { w: Math.round(Math.min(220, Math.max(96, text + (n.kind === "failure" ? 14 : 0)))), h: 32 };
}
const labelSize = (l?: string) => (l ? { width: Math.round(l.length * 6 + 14), height: 18 } : { width: 0, height: 0 });

function layout(g: Graph, dir: Dir): Laid {
  const dg = new dagre.graphlib.Graph({ multigraph: true });
  dg.setGraph({ rankdir: dir, nodesep: dir === "LR" ? 18 : 28, ranksep: dir === "LR" ? 36 : 40, edgesep: 12, marginx: 16, marginy: 16, ranker: "network-simplex" });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) { const s = sizeOf(n); dg.setNode(n.id, { width: s.w, height: s.h }); }
  for (const e of g.edges) dg.setEdge(e.source, e.target, { ...labelSize(e.label), labelpos: "c", minlen: 1, weight: e.kind === "error" ? 1 : 2 }, e.id);
  dagre.layout(dg);
  const gl = dg.graph();
  const out: Laid = { w: gl.width ?? 0, h: gl.height ?? 0, nodes: {}, edges: {} };
  for (const id of dg.nodes()) {
    const n = dg.node(id);
    if (n) out.nodes[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height };
  }
  for (const e of g.edges) {
    const de = dg.edge({ v: e.source, w: e.target, name: e.id }) as { points?: Pt[]; x?: number; y?: number } | undefined;
    if (de?.points?.length) out.edges[e.id] = { points: de.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), label: e.label && de.x != null && de.y != null ? { x: de.x, y: de.y } : undefined };
  }
  return out;
}

/** Smooth path through dagre's routed points (quadratic corners), ending exactly on the target boundary. */
function pathOf(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  if (pts.length === 2) return `${d} L${pts[1].x},${pts[1].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const m = i === pts.length - 2 ? b : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    d += ` Q${a.x},${a.y} ${m.x},${m.y}`;
  }
  return d;
}

// ---------------------------------------------------------------- live state

/** "a.b", {a:"b"}, {a:{b:"c"}} → every node on the active path */
function activePaths(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, prefix: string) => {
    if (typeof v === "string") {
      if (v.startsWith("{")) { try { return walk(JSON.parse(v), prefix); } catch { /* plain */ } }
      const parts = v.split(".");
      parts.forEach((_, i) => out.add([prefix, ...parts.slice(0, i + 1)].filter(Boolean).join(".")));
      if (prefix) out.add(prefix);
    } else if (isObj(v)) {
      for (const [k, c] of Object.entries(v)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); walk(c, p); }
    }
  };
  walk(value, "");
  return out;
}
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const setKey = (s: Set<string>) => [...s].sort().join("|");

/** `follow`: the production run streams its machine state live (no buffered scene to replay) */
function useLiveState(follow = false) {
  const live = useSession((s) => s.machine);
  const isLive = usePlayback((s) => s.view.live);
  const playing = usePlayback((s) => s.cur !== null);
  const marks = usePlayback((s) => s.view.stateMarks);
  const mi = usePlayback((s) => s.view.stateIdx);
  // scene data only while playing / holding; the live SSE value only when idle and caught up
  const replay = !isLive && !!marks;
  const value: unknown = follow ? (live?.value ?? null) : replay ? (mi >= 0 ? marks![mi].label : null) : isLive ? (live?.value ?? null) : null;
  const valueKey = typeof value === "string" ? value : JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const active = useMemo(() => activePaths(value), [valueKey]);

  const runId = useSession((s) => s.scenes.findLast((x) => x.kind === "run")?.id ?? null);
  const acc = useRef<{ run: string | null; set: Set<string> }>({ run: null, set: new Set() });
  const [liveVisited, setLiveVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (acc.current.run !== runId) acc.current = { run: runId, set: new Set() };
    if (!live || (!isLive && !follow)) return;
    let changed = false;
    for (const p of activePaths(live.value)) if (!acc.current.set.has(p)) { acc.current.set.add(p); changed = true; }
    if (changed) setLiveVisited(new Set(acc.current.set));
  }, [live, runId, isLive, follow]);
  const replayVisited = useMemo(() => {
    const s = new Set<string>();
    if (replay) for (let i = 0; i <= mi; i++) for (const p of activePaths(marks![i].label)) s.add(p);
    return s;
  }, [replay, mi, marks]);

  // "running" = a run scene is being played back: the view then follows the active state
  if (follow) return { active, visited: liveVisited, running: !!live };
  return { active, visited: replay ? replayVisited : liveVisited, running: replay && playing && mi >= 0 };
}

// ---------------------------------------------------------------- nodes & edges

type NodeData = { label: string; kind: NodeKind; src?: string; compound?: boolean; w: number; h: number; active: boolean; visited: boolean; running: boolean };
const hidden = "!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent";

const StateNode = memo(function StateNode({ data: d }: NodeProps<Node<NodeData>>) {
  const handles = (
    <>
      <Handle type="target" position={Position.Left} className={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} className={hidden} isConnectable={false} />
    </>
  );
  if (d.kind === "initial") return <div style={{ width: d.w, height: d.h }} className="rounded-full bg-foreground">{handles}</div>;

  const idle = d.running && !d.active && !d.visited;
  const tone = cn(
    "relative flex flex-col justify-center border bg-card text-card-foreground transition-[border-color,background-color,opacity,box-shadow] duration-300",
    d.kind === "final" ? "items-center rounded-full px-3" : "rounded-md px-2.5",
    d.kind === "ghost" && "border-dashed bg-transparent text-muted-foreground",
    d.kind === "failure" && "border-destructive/40 text-destructive",
    d.kind === "final" && "border-foreground/50",
    d.compound && "border-dashed",
    d.visited && !d.active && "border-foreground/35",
    d.active && "border-foreground bg-accent ring-4 ring-foreground/8",
    d.active && d.kind === "failure" && "border-destructive ring-destructive/15",
    idle && "opacity-70",
  );
  return (
    <div style={{ width: d.w, height: d.h }} className={tone} title={d.src ? `${d.label} · invokes ${d.src}` : d.label}>
      {handles}
      {d.kind === "final" && <span className="pointer-events-none absolute inset-[3px] rounded-full border border-foreground/30" />}
      <span className="flex min-w-0 items-center gap-1.5">
        {d.kind === "failure" && <CircleXIcon className="size-3 shrink-0" strokeWidth={1.75} />}
        <span className={cn("truncate text-[11px] leading-tight font-medium", d.kind === "ghost" && "font-mono font-normal")}>{d.kind === "ghost" ? `→ ${d.label}?` : d.label}</span>
        {d.active && <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-foreground" />}
      </span>
      {d.kind === "invoke" && d.src && (
        <span className="mt-1 flex min-w-0 items-center gap-1 text-muted-foreground">
          <ZapIcon className="size-2.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate font-mono text-[9.5px] leading-none">{d.src}</span>
        </span>
      )}
    </div>
  );
});

type EdgeData = { points: Pt[]; label?: string; title?: string; lx?: number; ly?: number; kind: EdgeKind; taken: boolean };

const FlowEdge = memo(function FlowEdge({ id, data, markerEnd, style }: EdgeProps<Edge<EdgeData>>) {
  if (!data) return null;
  const d = pathOf(data.points);
  return (
    <>
      <BaseEdge id={id} path={d} markerEnd={markerEnd} style={style} interactionWidth={0} />
      {data.label && data.lx != null && data.ly != null && (
        <EdgeLabelRenderer>
          <div
            title={data.title}
            className={cn(
              "nodrag nopan pointer-events-auto absolute max-w-48 truncate rounded-[4px] border bg-background px-1 font-mono text-[9.5px] leading-4 text-muted-foreground transition-colors",
              data.kind === "event" && "text-foreground",
              data.kind === "error" && "border-destructive/30 text-destructive",
              data.taken && "border-foreground/60 text-foreground",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${data.lx}px, ${data.ly}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { state: StateNode };
const edgeTypes = { flow: FlowEdge };

const mix = (v: string, p: number) => `color-mix(in oklab, var(${v}) ${p}%, transparent)`;
function edgeLook(kind: EdgeKind, taken: boolean): { stroke: string; width: number; dash?: string } {
  if (taken) return { stroke: "var(--foreground)", width: 1.5 };
  switch (kind) {
    case "init": return { stroke: mix("--foreground", 70), width: 1.25 };
    case "error": return { stroke: mix("--destructive", 55), width: 1, dash: "4 3" };
    case "always": return { stroke: mix("--muted-foreground", 45), width: 1 };
    case "child": return { stroke: mix("--muted-foreground", 45), width: 1, dash: "2 3" };
    default: return { stroke: mix("--muted-foreground", 70), width: 1 };
  }
}

const flowVars = {
  "--xy-background-color-default": "transparent",
  "--xy-edge-label-background-color-default": "var(--background)",
} as React.CSSProperties;

// ---------------------------------------------------------------- view

/** Whichever direction fits the pane at the larger scale. */
const pick = (l: Record<Dir, Laid>, box: { w: number; h: number }): Dir => {
  const fit = (x: Laid) => Math.min(box.w / Math.max(1, x.w), box.h / Math.max(1, x.h));
  return fit(l.LR) >= fit(l.TB) ? "LR" : "TB";
};

function Flow({ machine, box, follow }: { machine: unknown; box: { w: number; h: number }; follow?: boolean }) {
  // keyed on content: the machine object is rebuilt on every streamed token / parent render
  const sig = useMemo(() => JSON.stringify(machine ?? null), [machine]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = useMemo(() => buildGraph(machine), [sig]);
  const graphSig = useMemo(() => JSON.stringify(graph), [graph]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const both = useMemo(() => ({ LR: layout(graph, "LR"), TB: layout(graph, "TB") }), [graphSig]);
  const dir = pick(both, box);
  const laid = both[dir];
  const { fitView, fitBounds } = useReactFlow();
  const { active, visited, running } = useLiveState(follow);

  // the edge just taken animates briefly
  const prev = useRef<Set<string>>(new Set());
  const [taken, setTaken] = useState<{ from: Set<string>; to: Set<string> } | null>(null);
  const activeKey = setKey(active);
  useEffect(() => {
    if (sameSet(prev.current, active)) return;
    const from = prev.current;
    prev.current = active;
    if (!from.size || !active.size) { setTaken(null); return; }
    setTaken({ from, to: active });
    const t = setTimeout(() => setTaken(null), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const nodes = useMemo<Node<NodeData>[]>(() => graph.nodes.flatMap((n) => {
    const p = laid.nodes[n.id];
    if (!p) return [];
    return [{
      id: n.id, type: "state", position: { x: p.x, y: p.y }, width: p.w, height: p.h,
      draggable: false, selectable: false, connectable: false,
      data: { label: n.label, kind: n.kind, src: n.src, compound: n.compound, w: p.w, h: p.h, active: active.has(n.id), visited: visited.has(n.id), running },
    }];
  }), [graph, laid, active, visited, running]);

  const edges = useMemo<Edge<EdgeData>[]>(() => graph.edges.flatMap((e) => {
    const r = laid.edges[e.id];
    if (!r || r.points.length < 2) return [];
    const isTaken = !!taken && taken.from.has(e.source) && taken.to.has(e.target) && !taken.from.has(e.target);
    const look = edgeLook(e.kind, isTaken);
    return [{
      id: e.id, source: e.source, target: e.target, type: "flow", animated: isTaken, selectable: false, focusable: false,
      zIndex: isTaken ? 1 : 0,
      markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: look.stroke, strokeWidth: 1 },
      style: { stroke: look.stroke, strokeWidth: look.width, strokeDasharray: look.dash },
      data: { points: r.points, label: e.label, title: e.title, lx: r.label?.x, ly: r.label?.y, kind: e.kind, taken: isTaken },
    }];
  }), [graph, laid, taken]);

  const fit = () => void fitView({ padding: 0.08, duration: 250, maxZoom: 1.1 });

  // while a run plays, frame the active state and its immediate neighbours (smooth pan); otherwise everything
  const focusKey = useMemo(() => {
    if (!running) return "";
    const ids = new Set([...active].filter((id) => laid.nodes[id]));
    if (!ids.size) return "";
    for (const e of graph.edges) {
      if (active.has(e.source) && laid.nodes[e.target]) ids.add(e.target);
      if (active.has(e.target) && laid.nodes[e.source]) ids.add(e.source);
    }
    return [...ids].sort().join("|");
  }, [running, active, graph, laid]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => {
      if (!focusKey) { fit(); return; }
      const ns = focusKey.split("|").map((k) => laid.nodes[k]).filter(Boolean);
      const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
      const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h));
      void fitBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { padding: 0.2, duration: 600 });
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid, box, focusKey, ready]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      style={flowVars}
      onInit={() => setReady(true)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      panOnScroll
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      maxZoom={1.4}
    >
      <Panel position="bottom-right" className="!m-2">
        <Button variant="ghost" size="icon-xs" aria-label="Fit to view" className="text-muted-foreground" onClick={fit}><ScanIcon /></Button>
      </Panel>
    </ReactFlow>
  );
}

/** The manifest's XState machine as a laid-out state diagram, highlighted live during runs and replays. */
export function MachineView({ machine, follow }: { machine: unknown; follow?: boolean }) {
  const deferred = useDeferredValue(machine);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 400 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width && height) setBox((b) => (Math.abs(b.w - width) < 24 && Math.abs(b.h - height) < 24 ? b : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const empty = !isObj(deferred) || !isObj(deferred.states) || Object.keys(deferred.states).length === 0;
  return (
    <div ref={ref} className="size-full">
      {empty ? (
        <div className="flex size-full flex-col items-center justify-center gap-2.5 text-xs text-muted-foreground">
          <Retro name="machine" size={32} />
          No machine yet
        </div>
      ) : (
        <ReactFlowProvider>
          <Flow machine={deferred} box={box} follow={follow} />
        </ReactFlowProvider>
      )}
    </div>
  );
}
