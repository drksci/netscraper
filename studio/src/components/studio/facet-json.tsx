"use client";

import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { isActive, isRevealed, registerFacet, useReveal } from "@/lib/facet-reveal";
import { hoverId, matchesHover, setHover, useHover, type HoverKey } from "@/lib/facet-hover";
import type { FacetColor } from "@/lib/facets";
import { cn } from "@/lib/utils";

export type JsonPath = (string | number)[];
export interface FacetInfo { color: FacetColor; key: { family: string; leaf: string | null }; pill?: string }
/** Maps a JSON path (+ its value) to the facet it describes, if any. */
export type FacetResolver = (keys: JsonPath, value: unknown) => FacetInfo | null;

/**
 * focus: fold what isn't linked to the page — subtrees with no facet, and facets not on screen
 * (onScreen = hover ids of facets with visible rects, plus their families). Folds open on click,
 * or when the page hovers them.
 */
/** spot: a facet is being stepped through (or hovered) — lines outside it dim; lit: inside that facet's block. */
type CtxValue = { resolve: FacetResolver; hover: HoverKey | null; focus: boolean; onScreen: Set<string> | null; spot: boolean; lit: boolean };
const Ctx = createContext<CtxValue>({ resolve: () => null, hover: null, focus: false, onScreen: null, spot: false, lit: false });

const facetCache = new WeakMap<FacetResolver, WeakMap<object, boolean>>();
/** Does this subtree (or the node itself) describe any facet? Cached per resolver × object. */
function containsFacet(resolve: FacetResolver, keys: JsonPath, value: unknown, depth = 0): boolean {
  if (resolve(keys, value)) return true;
  if (!value || typeof value !== "object" || depth > 12) return false;
  let m = facetCache.get(resolve);
  if (!m) facetCache.set(resolve, (m = new WeakMap()));
  const hit = m.get(value as object);
  if (hit !== undefined) return hit;
  const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  const r = entries.some(([k, v]) => containsFacet(resolve, [...keys, k], v, depth + 1));
  m.set(value as object, r);
  return r;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="text-muted-foreground">{JSON.stringify(value)}</span>;
  return <span className="text-foreground/80 italic">{String(value)}</span>;
}

function Pill({ text }: { text: string }) {
  return <span className="ml-2 rounded-[4px] bg-muted px-1 text-[9px] leading-4 text-muted-foreground">{text}</span>;
}

const Entry = memo(function Entry({ label, keys, value, comma }: { label: string | null; keys: JsonPath; value: unknown; comma: boolean }) {
  const ctx = useContext(Ctx);
  const { resolve, hover, focus, onScreen, spot } = ctx;
  const info = resolve(keys, value);
  const [open, setOpen] = useState<boolean | null>(null);
  const reveal = useReveal();
  const ref = useRef<HTMLDivElement>(null);
  if (info) registerFacet(info.key);
  const active = !!info && isActive(reveal, info.key);
  const lit = ctx.lit || active || (!reveal.active && !!info && !!hover && hoverId(hover) === hoverId(info.key));
  // washed out like a faded print (≈ 62% background over the line), not greyed
  const dim = spot && !lit ? "opacity-[0.38] transition-opacity duration-300" : "transition-opacity duration-300";
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [active]);
  const sep = comma ? "," : "";
  const keyEl = label !== null && (
    <>
      <span className={info ? "font-medium" : "text-foreground"} style={info ? { color: info.color.solid } : undefined}>{JSON.stringify(label)}</span>
      <span className="text-muted-foreground">: </span>
    </>
  );

  const id = info ? hoverId(info.key) : null;
  const pageTarget = !!info && !!hover && hoverId(hover) === id;
  function folded(userOpen: boolean | null): boolean {
    if (userOpen !== null) return !userOpen;
    if (!focus || keys.length === 0 || active || pageTarget) return false;
    if (!info) return !containsFacet(resolve, keys, value);
    return !!onScreen && onScreen.size > 0 && !onScreen.has(id!);
  }
  let body: React.ReactNode;
  if (!isObj(value)) {
    body = <div className={cn("break-words whitespace-pre-wrap", dim)}>{keyEl}<Scalar value={value} />{sep}{info?.pill && <Pill text={info.pill} />}</div>;
  } else if (folded(open)) {
    const arr = Array.isArray(value);
    const n = arr ? value.length : Object.keys(value).length;
    body = (
      <div className={cn("opacity-60 hover:opacity-100", spot && !lit && "opacity-[0.3]")}>
        {keyEl}
        <button type="button" onClick={() => setOpen(true)} className="rounded-[3px] bg-muted px-1 text-muted-foreground hover:text-foreground">
          {arr ? "[" : "{"}…{arr ? "]" : "}"}
        </button>
        <span className="ml-1.5 text-[10px] text-muted-foreground/60">{n} {arr ? (n === 1 ? "item" : "items") : n === 1 ? "key" : "keys"}</span>{sep}
      </div>
    );
  } else {
    const arr = Array.isArray(value);
    const entries: [string | number, unknown][] = arr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const [open, close] = arr ? ["[", "]"] : ["{", "}"];
    body = entries.length === 0 ? (
      <div className={dim}>{keyEl}<span className="text-muted-foreground">{open}{close}{sep}</span></div>
    ) : (
      <>
        <div className={dim}>{keyEl}<span className="text-muted-foreground">{open}</span>{info?.pill && <Pill text={info.pill} />}</div>
        <Ctx.Provider value={lit === ctx.lit ? ctx : { ...ctx, lit }}>
          <div className="pl-3.5">
            {entries.map(([k, v], i) => (
              <Entry key={k} label={arr ? null : String(k)} keys={[...keys, k]} value={v} comma={i < entries.length - 1} />
            ))}
          </div>
        </Ctx.Provider>
        <div className={cn("text-muted-foreground", dim)}>{close}{sep}</div>
      </>
    );
  }

  if (!info) return <>{body}</>;
  if (!isRevealed(reveal, info.key)) return null;
  const on = matchesHover(info.key, hover);
  const hot = !!hover && on;
  return (
    <div
      ref={ref}
      data-facet={hoverId(info.key)}
      onMouseOver={(e) => { e.stopPropagation(); setHover(info.key, "code"); }}
      className={cn("-ml-2 animate-in rounded-r-[3px] border-l pl-[7px] transition-colors duration-300 fade-in slide-in-from-left-1", active && "border-l-2 pl-1.5")}
      style={{
        borderColor: hover && !on ? `color-mix(in oklab, ${info.color.border} 25%, transparent)` : info.color.border,
        backgroundColor: active ? info.color.wash : hot ? info.color.tint : "transparent",
      }}
    >
      {body}
    </div>
  );
});

/** Pretty JSON with facet-coloured subtrees. `streaming` adds a blinking caret. */
export const FacetJson = memo(function FacetJson({ value, resolve, streaming, focus = false, onScreen = null, className }: { value: unknown; resolve: FacetResolver; streaming?: boolean; focus?: boolean; onScreen?: Set<string> | null; className?: string }) {
  const { key } = useHover();
  const reveal = useReveal();
  const spot = !!reveal.active || !!key;
  return (
    <Ctx.Provider value={{ resolve, hover: key, focus, onScreen, spot, lit: false }}>
      <div className={cn("font-mono text-[11px] leading-[18px]", className)} onMouseLeave={() => setHover(null, "code")}>
        <Entry label={null} keys={[]} value={value} comma={false} />
        {streaming && <span className="inline-block h-3 w-[5px] translate-y-0.5 animate-pulse bg-foreground/60" />}
      </div>
    </Ctx.Provider>
  );
});
