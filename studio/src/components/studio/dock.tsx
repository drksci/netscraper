"use client";

import { useMemo } from "react";
import { BookmarkIcon, FingerprintIcon, HashIcon, HeartIcon, ImageIcon, LinkIcon, MessageCircleIcon, PlayIcon, Share2Icon, UserIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { componentFacets } from "@/lib/component-facets";
import { colorOfPath, facetKey, type Facet, type FacetColor } from "@/lib/facets";
import { matchesHover, setHover, useHover } from "@/lib/facet-hover";
import { useBrowserView } from "@/lib/playback";
import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { A2UIStream } from "./a2ui-stream";
import { useBrowserRect } from "./browser";

/** lofi: A2UI components cover their source elements (a lo-fi filter over the page); stream: the raw A2UI stream. */
export type OverlayMode = "lofi" | "stream" | "off";

type Kind = "image" | "id" | "count" | "author" | "link" | "heading" | "text" | "button";
interface Prim { key: string; path: string; leaf: string; value: string; rect: number[]; kind: Kind; color: FacetColor }
interface Item { key: string; path: string; rect: number[]; color: FacetColor; fields: Prim[] }

// ---------------------------------------------------------------- classification

const IMG_LEAF = /(cover|avatar|image|img|thumb|photo|poster|picture)/i;
const IMG_VAL = /\.(jpe?g|png|svg|webp|gif|avif)(\?|$)|^data:image\//i;
const ID_LEAF = /(^|[._])(id|uid|key)$|Id$/;
const AUTHOR_LEAF = /^(author|user|username|handle|uniqueId|owner|creator)$/i;
const URL_LEAF = /(url|href|link)$/i;
const COUNT_LEAF = /count|plays|views|likes|fans|followers|following|hearts?|diggs?|shares|comments/i;
const NUM_VAL = /^[\d.,]+\s?[KMBkmb]?$/;

/** facet path → A2UI component type of the matched view (best effort) */
function componentKinds(components: unknown): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const { component: c, path } of componentFacets(components)) {
    if (!path) continue;
    if (c.component === "Image") out.set(path, "image");
    else if (c.component === "Button") out.set(path, "button");
    else if (c.component === "Text" && /^h[1-3]$/.test(c.variant ?? "")) out.set(path, "heading");
  }
  return out;
}

function kindOf(path: string, leaf: string, value: string, known: Map<string, Kind>): Kind {
  const k = known.get(path);
  if (k === "image" || k === "button") return k;
  if (IMG_LEAF.test(leaf) || IMG_VAL.test(value)) return "image";
  if (AUTHOR_LEAF.test(leaf)) return "author";
  if (URL_LEAF.test(leaf) || /^https?:\/\//.test(value)) return "link";
  if (ID_LEAF.test(leaf)) return "id";
  if (COUNT_LEAF.test(leaf) || NUM_VAL.test(value.trim())) return "count";
  return k ?? "text";
}

const hasValue = (v: string | null | undefined): v is string => v != null && v !== "";

/** Only what matched and carries a value: fields with a rect + value, grouped into their list items. */
function build(facets: Facet[], known: Map<string, Kind>) {
  const items = new Map<string, Item>();
  const loose: Prim[] = [];
  const itemRects = new Map<string, number[]>();
  for (const f of facets) if (f.kind === "item") f.rects.forEach((r, i) => itemRects.set(`${f.path}#${f.idx?.[i] ?? i}`, r));
  for (const f of facets) {
    if (f.kind !== "field") continue;
    const leaf = facetKey(f.path).leaf ?? f.path;
    const at = f.path.indexOf("/*/");
    f.rects.forEach((r, i) => {
      const value = f.values[i];
      if (!hasValue(value) || r[2] <= 0 || r[3] <= 0) return;
      const p: Prim = { key: `${f.path}#${f.idx?.[i] ?? i}`, path: f.path, leaf, value, rect: r, kind: kindOf(f.path, leaf, value, known), color: colorOfPath(f.path) };
      if (at < 0 || f.idx?.[i] == null) { loose.push(p); return; }
      const itemPath = f.path.slice(0, at + 2), k = `${itemPath}#${f.idx[i]}`;
      let it = items.get(k);
      if (!it) { it = { key: k, path: itemPath, rect: itemRects.get(k) ?? r, color: colorOfPath(itemPath), fields: [] }; items.set(k, it); }
      if (!itemRects.has(k)) { // no item rect: grow around its fields
        const x0 = Math.min(it.rect[0], r[0]), y0 = Math.min(it.rect[1], r[1]);
        it.rect = [x0, y0, Math.max(it.rect[0] + it.rect[2], r[0] + r[2]) - x0, Math.max(it.rect[1] + it.rect[3], r[1] + r[3]) - y0];
      }
      it.fields.push(p);
    });
  }
  return { items: [...items.values()], loose };
}

/** Fields sharing (almost) the same rect render as one block: media at the back, text lines stacked on it. */
interface Block { key: string; rect: number[]; image: Prim | null; lines: Prim[] }
function blocksOf(fields: Prim[]): Block[] {
  const out: Block[] = [];
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  for (const p of fields) {
    let b = out.find((x) => near(x.rect, p.rect));
    if (!b) { b = { key: p.key, rect: p.rect, image: null, lines: [] }; out.push(b); }
    if (p.kind === "image" && !b.image) b.image = p;
    else if (p.kind !== "image" && !b.lines.some((l) => l.value === p.value)) b.lines.push(p);
  }
  // media blocks first (behind), then smaller blocks on top
  return out.sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]);
}

// ---------------------------------------------------------------- lo-fi primitives

const shortId = (v: string) => { const d = v.replace(/^.*\//, ""); return d.length > 10 ? `${d.slice(0, 4)}…${d.slice(-4)}` : d; };
const compact = (v: string) => {
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && String(v).trim() !== "" ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n) : v;
};
function countIcon(leaf: string): LucideIcon {
  const l = leaf.toLowerCase();
  if (/play|view/.test(l)) return PlayIcon;
  if (/digg|like|heart/.test(l)) return HeartIcon;
  if (/comment/.test(l)) return MessageCircleIcon;
  if (/share/.test(l)) return Share2Icon;
  if (/collect|save|bookmark/.test(l)) return BookmarkIcon;
  if (/fan|follow/.test(l)) return UsersIcon;
  return HashIcon;
}

function Glyph({ icon: Icon, text, strong, className }: { icon: LucideIcon; text: string; strong?: boolean; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      <Icon className="size-2.5 shrink-0 text-muted-foreground" strokeWidth={2} />
      <span className={cn("min-w-0 leading-none tabular-nums", strong ? "whitespace-nowrap font-medium text-foreground" : "truncate text-muted-foreground")}>{text}</span>
    </span>
  );
}

// ---------------------------------------------------------------- geometry

/** Page CSS px rect → frame px box. Edges are rounded (not sizes), so adjacent boxes share exact pixel edges. */
interface Box { l: number; t: number; w: number; h: number }
const toBox = (r: number[], s: number): Box => {
  const l = Math.round(r[0] * s), t = Math.round(r[1] * s);
  return { l, t, w: Math.round((r[0] + r[2]) * s) - l, h: Math.round((r[1] + r[3]) * s) - t };
};
const contains = (o: number[], i: number[], tol = 2) =>
  i[0] >= o[0] - tol && i[1] >= o[1] - tol && i[0] + i[2] <= o[0] + o[2] + tol && i[1] + i[3] <= o[1] + o[3] + tol;

/** A covered element: an item card (with its field blocks inside) or a single loose field. */
interface Cover { key: string; path: string; rect: number[]; color: FacetColor; blocks: Block[] }

/** Outermost wins: a cover lying inside another (nested lists, duplicate rects) is already represented by it. */
function covers(items: Item[], loose: Prim[]): Cover[] {
  const all: Cover[] = [
    ...items.map((it) => ({ key: it.key, path: it.path, rect: it.rect, color: it.color, blocks: blocksOf(it.fields) })),
    ...blocksOf(loose).map((b) => { const p = b.image ?? b.lines[0]; return { key: b.key, path: p.path, rect: b.rect, color: p.color, blocks: [b] }; }),
  ].filter((c) => c.rect[2] > 0 && c.rect[3] > 0);
  all.sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]);
  const out: Cover[] = [];
  for (const c of all) if (!out.some((o) => contains(o.rect, c.rect))) out.push(c);
  return out;
}

// ---------------------------------------------------------------- lo-fi components

/** One field as its lo-fi A2UI component, holding the extracted value in simplified form. Never overflows. */
function Line({ p, round, clamp }: { p: Prim; round?: boolean; clamp?: boolean }) {
  switch (p.kind) {
    case "id": return <Glyph icon={FingerprintIcon} text={shortId(p.value)} />;
    case "link": return <Glyph icon={LinkIcon} text={shortId(p.value)} />;
    case "count": return <Glyph icon={countIcon(p.leaf)} text={compact(p.value)} strong />;
    case "author":
      return round
        ? <span className="flex size-full items-center justify-center rounded-full bg-muted"><UserIcon className="size-[60%] text-muted-foreground" strokeWidth={2} /></span>
        : <span className="flex min-w-0 items-center gap-1"><span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" /><span className="truncate font-medium">@{p.value.replace(/^@/, "")}</span></span>;
    case "button": return <span className="truncate font-medium">{p.value}</span>;
    case "heading": return <span className={cn("min-w-0 font-medium", clamp ? "line-clamp-2" : "truncate")}>{p.value}</span>;
    default: return <span className={cn("min-w-0 text-foreground/80", clamp ? "line-clamp-2" : "truncate")}>{p.value}</span>;
  }
}

/** A field block at its own box inside the cover: media → glyph on a muted plate, text → centred line(s). */
function BlockView({ b, box, dim }: { b: Block; box: Box; dim: (path: string) => boolean }) {
  const { w, h } = box;
  const media = !!b.image;
  const paths = [b.image, ...b.lines].filter((p): p is Prim => !!p).map((p) => p.path);
  const pad = Math.max(2, Math.min(8, Math.round(h * 0.18)));
  const font = h < 14 ? 8 : h < 22 ? 9 : 10;
  const room = Math.max(1, Math.floor((h - pad * 2) / (font + 4)));
  const lines = [...b.lines].sort((a, z) => Number(a.kind === "text") - Number(z.kind === "text")).slice(0, media ? Math.min(3, room) : room);
  const round = !media && lines.length === 1 && lines[0].kind === "author" && Math.abs(w - h) < 3 && w < 44;
  return (
    <div
      onMouseEnter={() => setHover(facetKey(paths[paths.length - 1]), "page")}
      onMouseLeave={() => setHover(null, "page")}
      className={cn("pointer-events-auto absolute overflow-hidden transition-opacity duration-200", media ? "bg-muted" : "bg-background", paths.every(dim) && "opacity-40")}
      style={{ left: box.l, top: box.t, width: w, height: h, fontSize: font, lineHeight: 1.2 }}
    >
      {media && (
        <span className="absolute inset-0 flex items-center justify-center">
          <ImageIcon className={cn("text-muted-foreground/50", h > 60 ? "size-5" : "size-3")} strokeWidth={1.25} />
        </span>
      )}
      {round ? (
        <Line p={lines[0]} round />
      ) : lines.length > 0 && (
        <div
          className={cn("flex size-full min-w-0 flex-col gap-0.5", media ? "justify-start" : "justify-center")}
          style={{ padding: media ? pad : `0 ${pad}px` }}
        >
          {lines.map((p) => <Line key={p.key} p={p} clamp={!media && lines.length === 1 && h - pad * 2 >= font * 2.6} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- overlay

/**
 * A2UI over the browser. Lo-fi: every matched element is covered, at exactly its rect (same scale and letterbox as
 * the facet outlines), by one opaque lo-fi rendering of its component; the page shows only between covers.
 */
export function A2UIOverlay({ mode }: { mode: OverlayMode }) {
  const view = useBrowserView();
  const rect = useBrowserRect();
  const manifest = useSession((s) => s.manifest);
  const { key: hovered } = useHover();
  const facets = view.snap?.facets;
  const viewName = view.snap?.view;
  const components = viewName ? manifest?.doc?.views?.[viewName]?.components : undefined;
  const known = useMemo(() => componentKinds(components), [components]);
  const list = useMemo(() => { const { items, loose } = build(facets ?? [], known); return covers(items, loose); }, [facets, known]);

  if (mode === "off" || !rect) return null;
  if (mode === "stream") {
    return (
      <div className="absolute inset-y-0 right-0 z-10 w-[min(34%,360px)] animate-in overflow-hidden border-l bg-background/95 duration-200 fade-in slide-in-from-right-2">
        <A2UIStream replay={view.a2ui} />
      </div>
    );
  }

  const s = rect.scale;
  const dim = (path: string) => !!hovered && !matchesHover(facetKey(path), hovered);
  const visible = (r: number[]) => r[1] + r[3] > 0 && r[1] < rect.vh && r[0] < rect.vw && r[0] + r[2] > 0;

  return (
    // the frame's own box (same origin as the canvas and the facet outlines); covers clip at the frame edge
    <div className="pointer-events-none absolute z-10 overflow-hidden" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {list.filter((c) => visible(c.rect)).map((c) => {
        const cb = toBox(c.rect, s);
        return (
          <div
            key={c.key}
            className={cn("absolute overflow-hidden rounded-[4px] bg-background transition-opacity duration-200", c.blocks.every((b) => [b.image, ...b.lines].every((p) => !p || dim(p.path))) && dim(c.path) && "opacity-40")}
            style={{ left: cb.l, top: cb.t, width: cb.w, height: cb.h }}
          >
            {c.blocks.map((b) => {
              const bb = toBox(b.rect, s);
              // field boxes relative to the card, from the same rounded edges: no drift, no double edges
              const l = Math.max(0, bb.l - cb.l), t = Math.max(0, bb.t - cb.t);
              const box = { l, t, w: Math.min(cb.w - l, bb.w - (l - (bb.l - cb.l))), h: Math.min(cb.h - t, bb.h - (t - (bb.t - cb.t))) };
              return box.w > 0 && box.h > 0 ? <BlockView key={b.key} b={b} box={box} dim={dim} /> : null;
            })}
            {/* the facet-colour hairline sits on top of the content, inside the rect */}
            <span className="pointer-events-none absolute inset-0 rounded-[4px] border" style={{ borderColor: c.color.border }} />
          </div>
        );
      })}
    </div>
  );
}
