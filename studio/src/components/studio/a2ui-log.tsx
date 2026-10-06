"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CopyIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { colorOfPath, facetKey } from "@/lib/facets";
import { useBrowserView } from "@/lib/playback";
import { a2uiStore } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { FacetJson, type FacetResolver } from "./facet-json";
import { Segmented } from "./segmented";

/**
 * The A2UI message stream itself: one message per line (type badge · surface · path · value preview), newest at
 * the bottom, following. Click a line for the pretty, facet-coloured message. Source: the scene's a2ui up to the
 * playhead during playback, the live stream when caught up.
 */

type Kind = "create" | "components" | "data" | "delete" | "action" | "other";
type Group = "page" | "control" | "interrupt";
interface Line { i: number; msg: any; kind: Kind; surface: string; group: Group; path: string; preview: string }

// badge tints come from the facet palette (the only raw colours in the app), keyed by message type
const KIND: Record<Kind, { label: string; hue: number }> = {
  create: { label: "create", hue: 1 }, components: { label: "components", hue: 4 }, data: { label: "data", hue: 0 },
  delete: { label: "delete", hue: 3 }, action: { label: "action", hue: 2 }, other: { label: "msg", hue: -1 },
};
const PAL = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];
const badge = (hue: number): React.CSSProperties => (hue < 0 ? {} : { backgroundColor: `${PAL[hue]}1f`, color: PAL[hue] });

const preview = (v: unknown) => {
  if (v === undefined) return "";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

function classify(msg: any, i: number): Line {
  const body = msg?.createSurface ?? msg?.updateComponents ?? msg?.updateDataModel ?? msg?.deleteSurface;
  const kind: Kind = msg?.createSurface ? "create" : msg?.updateComponents ? "components" : msg?.updateDataModel ? "data" : msg?.deleteSurface ? "delete" : msg?.clientAction ? "action" : "other";
  const surface = String(body?.surfaceId ?? msg?.clientAction?.action?.surfaceId ?? "");
  const group: Group = surface.includes("interrupt:") ? "interrupt" : /control/.test(surface) ? "control" : "page";
  let path = "", pv = "";
  if (kind === "data") { path = String(msg.updateDataModel.path ?? "/"); pv = preview(msg.updateDataModel.value ?? msg.updateDataModel.contents); }
  else if (kind === "components") pv = `${(msg.updateComponents.components ?? []).length} components`;
  else if (kind === "create") pv = String(msg.createSurface.catalogId ?? "").split("/").pop() ?? "";
  else if (kind === "action") { path = String(msg.clientAction?.action?.name ?? ""); pv = preview(msg.clientAction?.action?.context); }
  return { i, msg, kind, surface, group, path, preview: pv };
}

/** live stream, or the playing scene's messages up to the playhead */
function useMessages(): unknown[] {
  const replay = useBrowserView().a2ui;
  const [live, setLive] = useState<unknown[]>(() => [...a2uiStore.backlog()]);
  useEffect(() => {
    if (replay) return;
    let raf = 0;
    const flush = () => { raf = 0; setLive([...a2uiStore.backlog()]); };
    flush();
    const unsub = a2uiStore.subscribe(() => { if (!raf) raf = requestAnimationFrame(flush); });
    return () => { unsub(); cancelAnimationFrame(raf); };
  }, [replay]);
  return replay ?? live;
}

const shortSurface = (s: string) => s.replace(/^.*?(interrupt:)/, "$1").replace(/-(\d+)$/, "·$1");
/** data-model path → facet path ("/videos/3/playCount" → "/videos/*\/playCount") */
const toFacet = (p: string) => p.replace(/\/\d+(?=\/|$)/g, "/*");

function dataResolver(base: string): FacetResolver {
  return (keys) => {
    const segs = [...base.split("/").filter(Boolean), ...keys.map(String)];
    if (!segs.length || /^\d+$/.test(segs[segs.length - 1])) return null;
    const path = toFacet(`/${segs.join("/")}`);
    return { color: colorOfPath(path), key: facetKey(path) };
  };
}
const noFacets: FacetResolver = () => null;

const Row = memo(function Row({ l, open, onToggle, raw }: { l: Line; open: boolean; onToggle: () => void; raw: boolean }) {
  const k = KIND[l.kind];
  const dataColor = l.kind === "data" && l.path && l.path !== "/" ? colorOfPath(toFacet(l.path)).solid : undefined;
  return (
    <div className={cn("border-b border-border/40", open && "bg-muted/40")}>
      <button type="button" onClick={onToggle} className="flex h-[18px] w-full min-w-0 items-center gap-1.5 px-3 text-left whitespace-nowrap hover:bg-muted/50">
        <span className="w-7 shrink-0 text-right text-[9px] text-muted-foreground/50 tabular-nums">{l.i}</span>
        {raw ? (
          <span className="min-w-0 truncate text-muted-foreground">{JSON.stringify(l.msg)}</span>
        ) : (
          <>
            <span className={cn("w-[68px] shrink-0 rounded-[3px] px-1 text-center text-[9px] leading-[14px]", k.hue < 0 && "bg-muted text-muted-foreground")} style={badge(k.hue)}>{k.label}</span>
            <span className="max-w-[20ch] shrink-0 truncate text-muted-foreground">{shortSurface(l.surface)}</span>
            {l.path && <span className="shrink-0" style={{ color: dataColor }}>{l.path}</span>}
            <span className="min-w-0 truncate text-muted-foreground/70">{l.preview}</span>
          </>
        )}
      </button>
      {open && (
        <div className="px-3 pt-1 pb-2 pl-12">
          <FacetJson value={l.msg} resolve={l.kind === "data" ? wrapResolver(l.path) : noFacets} />
        </div>
      )}
    </div>
  );
});

/** facet colours apply under updateDataModel.value; the rest of the envelope stays neutral */
function wrapResolver(path: string): FacetResolver {
  const inner = dataResolver(path === "/" ? "" : path);
  return (keys, value) => (keys[0] === "updateDataModel" && keys[1] === "value" ? inner(keys.slice(2), value) : null);
}

const GROUPS: Group[] = ["page", "control", "interrupt"];
const KINDS: Kind[] = ["create", "components", "data", "delete", "action"];
const MAX = 1500;

export function A2UILog() {
  const msgs = useMessages();
  const lines = useMemo(() => msgs.map((m, i) => classify(m, i + 1)).filter((l) => !(l.msg as any)?.__reset), [msgs]);
  const [groups, setGroups] = useState<Set<Group>>(() => new Set(GROUPS));
  const [kinds, setKinds] = useState<Set<Kind>>(() => new Set([...KINDS, "other"]));
  const [mode, setMode] = useState<"pretty" | "raw">("pretty");
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMemo(() => lines.filter((l) => groups.has(l.group) && kinds.has(l.kind)), [lines, groups, kinds]);
  const tail = shown.slice(-MAX);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [tail.length, tail.at(-1)?.i]);

  const jsonl = () => shown.map((l) => JSON.stringify(l.msg)).join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([jsonl() + "\n"], { type: "application/x-ndjson" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "a2ui-stream.jsonl" });
    a.click();
    URL.revokeObjectURL(url);
  };
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const chip = (on: boolean) => cn("h-5 rounded-[4px] px-1.5 text-[10px] transition-colors", on ? "bg-muted text-foreground" : "text-muted-foreground/60 hover:text-muted-foreground");

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b px-2 whitespace-nowrap">
        {GROUPS.map((g) => <button key={g} type="button" className={chip(groups.has(g))} onClick={() => setGroups((s) => toggle(s, g))}>{g === "interrupt" ? "interrupt:*" : g}</button>)}
        <span className="mx-1 h-3 w-px bg-border" />
        {KINDS.map((k) => <button key={k} type="button" className={chip(kinds.has(k))} onClick={() => setKinds((s) => toggle(s, k))}>{KIND[k].label}</button>)}
        <span className="ml-auto" />
        <span className="px-1 text-[10px] text-muted-foreground tabular-nums">{shown.length}</span>
        <Segmented label="Format" value={mode} onChange={setMode} items={[{ id: "pretty", label: "Pretty" }, { id: "raw", label: "JSONL" }]} className="h-5 [&_button]:h-4 [&_button]:text-[10px]" />
        <Button variant="ghost" size="icon-xs" aria-label="Copy JSONL" title="Copy JSONL" onClick={() => void navigator.clipboard?.writeText(jsonl())}><CopyIcon /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Download .jsonl" title="Download .jsonl" onClick={download}><DownloadIcon /></Button>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}
        className="min-h-0 flex-1 overflow-auto font-mono text-[10.5px]"
      >
        {shown.length > MAX && <p className="px-3 py-1 text-[10px] text-muted-foreground">{shown.length - MAX} earlier messages hidden (download for all)</p>}
        {!tail.length && <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No A2UI messages yet</p>}
        {tail.map((l) => <Row key={l.i} l={l} raw={mode === "raw"} open={open === l.i} onToggle={() => setOpen((o) => (o === l.i ? null : l.i))} />)}
      </div>
    </div>
  );
}
