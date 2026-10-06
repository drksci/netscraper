"use client";

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon } from "lucide-react";
import { WebPreview, WebPreviewBody, WebPreviewNavigation, WebPreviewNavigationButton, WebPreviewUrl } from "@/components/ai-elements/web-preview";
import { colorOfPath, facetKey, type Facet } from "@/lib/facets";
import { matchesHover, setHover, useHover, type HoverKey } from "@/lib/facet-hover";
import { isActive, isRevealed, useReveal } from "@/lib/facet-reveal";
import { useBrowserImage, useBrowserView } from "@/lib/playback";
import { sessionApi, useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { ActionHud } from "./action-hud";
import { Hourglass, Retro } from "./retro";

/** Geometry of the page viewport (letterboxed frame) inside the pane; overlays (Dock, Inline) align to it. */
export interface BrowserRect { scale: number; width: number; height: number; vw: number; vh: number; x: number; y: number; paneW: number; paneH: number }
const RectContext = createContext<BrowserRect | null>(null);
export const useBrowserRect = () => useContext(RectContext);

export const useSessionUrl = () => useSession((s) => s.url || s.facets?.url || "");
export const navigateTo = (raw: string) => {
  const t = raw.trim();
  if (t) void sessionApi.post("navigate", { url: /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}` });
};

// ---------------------------------------------------------------- chrome

/** Web Preview nav row: back / forward / reload and the url; `end` holds compact controls. */
export function BrowserNav({ end, className }: { end?: React.ReactNode; className?: string }) {
  return (
    <WebPreviewNavigation className={cn("h-9 gap-0.5 border-b px-1.5", className)}>
      <WebPreviewNavigationButton tooltip="Back" onClick={() => void sessionApi.post("back", {})}><ArrowLeftIcon /></WebPreviewNavigationButton>
      <WebPreviewNavigationButton tooltip="Forward" disabled><ArrowRightIcon /></WebPreviewNavigationButton>
      <WebPreviewNavigationButton tooltip="Reload" onClick={() => void sessionApi.post("reload", {})}><RotateCwIcon /></WebPreviewNavigationButton>
      <WebPreviewUrl className="ml-1 h-6 min-w-0 flex-1 rounded-md border-0 bg-muted px-2.5 font-mono text-[11px] text-muted-foreground shadow-none focus-visible:text-foreground" />
      {end && <div className="ml-1.5 flex shrink-0 items-center gap-1.5">{end}</div>}
    </WebPreviewNavigation>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Slim footer under the canvas: matched view and the page's own data sources (net), then run status. */
export function StatusBar({ className }: { className?: string }) {
  const snap = useBrowserView().snap;
  const connected = useSession((s) => s.connected);
  const manifest = useSession((s) => s.manifest);
  const parity = useSession((s) => s.parity);
  const recording = useSession((s) => s.scenes.find((x) => x.kind === "run" && !x.done));
  const nets = (snap?.facets ?? []).filter((f) => f.kind === "net");
  return (
    <div className={cn("flex h-6 shrink-0 items-center gap-3 border-t px-3 font-mono text-[10px] text-muted-foreground", className)}>
      <span className="shrink-0">{snap?.view ? <>view <span className="text-foreground">{snap.view}</span></> : "no view matched"}</span>
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {nets.map((f) => (
          <span key={f.path} className="flex min-w-0 items-center gap-1.5" onMouseEnter={() => setHover(facetKey(f.path), "page")} onMouseLeave={() => setHover(null, "page")}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOfPath(f.path).solid }} />
            <span className="truncate">net {f.net} → {f.path}{f.count != null ? ` · ${f.count}` : ""}</span>
          </span>
        ))}
      </div>
      {recording && (
        <span className="flex shrink-0 items-center gap-1.5" title="A scene is being recorded; it plays back once it closes">
          <Hourglass />
          recording…
        </span>
      )}
      {manifest && <span className={cn("shrink-0", !manifest.valid && "text-destructive")}>{manifest.valid ? "manifest ok" : `${manifest.errors.length} errors`}</span>}
      {parity && <span className="shrink-0">parity {pct(parity.score)} · cov {pct(parity.coverage)}</span>}
      <span className="flex shrink-0 items-center gap-1.5" title={connected ? "Session server connected" : "Session server disconnected"}>
        <span className={cn("size-1.5 rounded-full", connected ? "bg-foreground/60" : "bg-destructive")} />
        {connected ? "live" : "offline"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- canvas

const FADE_MS = 140;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Frames are painted onto one canvas, and only once decoded, so swaps never flicker. Consecutive frames
 * crossfade briefly, which evens out the ~8fps capture cadence into continuous motion.
 */
function FrameCanvas(props: Pick<React.ComponentProps<"canvas">, "onClick" | "onMouseMove" | "onMouseLeave">) {
  const img = useBrowserImage();
  const ref = useRef<HTMLCanvasElement>(null);
  const shown = useRef<HTMLImageElement | null>(null);
  const raf = useRef(0);
  useLayoutEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img) return;
    cancelAnimationFrame(raf.current);
    const from = shown.current;
    shown.current = img;
    const sized = c.width === img.naturalWidth && c.height === img.naturalHeight;
    if (!sized) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
    if (!from || !sized || from.naturalWidth !== img.naturalWidth || from.naturalHeight !== img.naturalHeight) {
      ctx.globalAlpha = 1;
      ctx.drawImage(img, 0, 0);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / FADE_MS);
      ctx.globalAlpha = 1;
      ctx.drawImage(from, 0, 0);
      ctx.globalAlpha = ease(t);
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1;
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    step(t0);
    raf.current = requestAnimationFrame(step);
  }, [img]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return <canvas ref={ref} {...props} className="absolute inset-0 size-full cursor-default select-none" />;
}

type Lit = (f: Facet) => boolean;

/** Pale wash over the page with cut-outs around the facet being stepped through or hovered. */
function Spotlight({ facets, scale, lit }: { facets: Facet[]; scale: number; lit: Lit }) {
  const on = facets.filter((f) => f.kind !== "net" && f.rects.length && lit(f));
  if (!on.length) return null;
  const pad = 3;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full animate-in fade-in duration-200">
      <defs>
        <mask id="facet-spotlight">
          <rect width="100%" height="100%" fill="white" />
          {on.flatMap((f) => f.rects.map((r, i) => (
            <rect key={`${f.path}#${i}`} x={r[0] * scale - pad} y={r[1] * scale - pad} width={r[2] * scale + pad * 2} height={r[3] * scale + pad * 2} rx={4} fill="black" />
          )))}
        </mask>
      </defs>
      {/* a pale wash, like a faded print: background colour (white / near-black) over everything not lit */}
      <rect width="100%" height="100%" style={{ fill: "var(--background)" }} fillOpacity={0.62} mask="url(#facet-spotlight)" />
    </svg>
  );
}

/** Hairline outlines in facet colours; labels only on hover or while active. Containers stay quiet. */
const FacetOutlines = memo(function FacetOutlines({ facets, scale, hover }: { facets: Facet[]; scale: number; hover: HoverKey | null }) {
  const reveal = useReveal();
  const stepping = !!reveal.active;
  const lit: Lit = (f) => (stepping ? isActive(reveal, facetKey(f.path)) : !!hover && matchesHover(facetKey(f.path), hover));
  return (
    <>
      <Spotlight facets={facets} scale={scale} lit={lit} />
      {facets.flatMap((f) => {
        if (f.kind === "net" || !f.rects.length) return [];
        const key = facetKey(f.path);
        if (!isRevealed(reveal, key)) return [];
        const c = colorOfPath(f.path);
        const active = stepping && isActive(reveal, key);
        const on = lit(f);
        const container = f.kind === "group" || f.kind === "list";
        if (container && !on) return [];
        const quiet = (stepping || !!hover) && !on;
        return f.rects.map((r, i) => (
          <div
            key={`${f.path}#${i}`}
            className={cn(
              "absolute rounded-[3px] border transition-[opacity,background-color] duration-200",
              f.kind === "item" && "border-dashed",
              f.kind === "item" && !on && "opacity-45",
              quiet && "opacity-15",
            )}
            style={{
              left: r[0] * scale, top: r[1] * scale, width: r[2] * scale, height: r[3] * scale,
              borderColor: c.border,
              borderWidth: active ? 2 : 1,
              backgroundColor: active ? c.wash : on ? c.tint : undefined,
            }}
          >
            {f.kind === "field" && key.leaf && on && (
              <span className="absolute -top-px left-[-1px] max-w-[160px] -translate-y-full truncate rounded-t-[3px] px-1 font-mono text-[9px] leading-3.5" style={{ backgroundColor: c.solid, color: c.fg }}>
                {key.leaf}
              </span>
            )}
          </div>
        ));
      })}
    </>
  );
});

const area = (r: number[]) => r[2] * r[3];

/**
 * The browser canvas: letterboxed frame, facet outlines, HUD, hover → code linking, click-through.
 * `children` render in pane coordinates with the frame geometry available via useBrowserRect().
 */
export function BrowserCanvas({ className, children }: { className?: string; children?: React.ReactNode }) {
  const view = useBrowserView();
  const connected = useSession((s) => s.connected);
  const sessionVp = useSession((s) => s.viewport);
  const { key: hover } = useHover();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; label: string; value: string } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [vw, vh] = view.viewport;
  const scale = Math.min(box.w / vw, box.h / vh) || 0;
  const rect: BrowserRect = useMemo(() => ({
    scale, width: vw * scale, height: vh * scale, vw, vh,
    x: (box.w - vw * scale) / 2, y: (box.h - vh * scale) / 2, paneW: box.w, paneH: box.h,
  }), [scale, vw, vh, box.w, box.h]);

  const facets = view.snap?.facets ?? [];
  const hasFacets = facets.some((f) => f.rects.length > 0);

  const hit = (e: React.MouseEvent) => {
    const el = frameRef.current;
    if (!el || !scale) return;
    const b = el.getBoundingClientRect();
    const x = (e.clientX - b.left) / scale, y = (e.clientY - b.top) / scale;
    let best: { f: Facet; i: number } | null = null;
    for (const f of facets) {
      if (f.kind === "net" || f.kind === "group" || f.kind === "list") continue;
      f.rects.forEach((r, i) => {
        if (x < r[0] || y < r[1] || x > r[0] + r[2] || y > r[1] + r[3]) return;
        const better = !best || (f.kind === "field" && best.f.kind !== "field") || (f.kind === best.f.kind && area(r) < area(best.f.rects[best.i]));
        if (better) best = { f, i };
      });
    }
    const h = best as { f: Facet; i: number } | null;
    if (!h) { setHover(null, "page"); setTip(null); return; }
    setHover(facetKey(h.f.path), "page");
    const value = h.f.values[h.i];
    setTip(value ? { x: e.clientX - b.left, y: e.clientY - b.top, label: facetKey(h.f.path).leaf ?? h.f.path, value } : null);
  };

  const click = (e: React.MouseEvent) => {
    const b = frameRef.current?.getBoundingClientRect();
    if (!b) return;
    const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) void sessionApi.post("click", { x, y });
  };

  const hv = sessionVp ?? { width: vw, height: vh };

  return (
    <div ref={boxRef} className={cn("relative flex size-full items-center justify-center overflow-hidden bg-muted/50", className)}>
      {!view.hasImage ? (
        <div className="flex flex-col items-center gap-2.5 text-xs text-muted-foreground">
          {connected ? <Retro name="spinning-globe" size={32} /> : <Retro name="computer" size={32} className="opacity-60 grayscale" />}
          {connected ? "Waiting for the browser" : "Session server not connected"}
        </div>
      ) : (
        <RectContext.Provider value={rect}>
          <div ref={frameRef} className="relative shrink-0 overflow-hidden bg-background" style={{ width: rect.width, height: rect.height }}>
            <FrameCanvas onClick={click} onMouseMove={hit} onMouseLeave={() => { setHover(null, "page"); setTip(null); }} />
            <div className="pointer-events-none absolute inset-0">
              {hasFacets ? (
                <FacetOutlines facets={facets} scale={scale} hover={hover} />
              ) : (
                view.highlights.map((h) => (
                  <div
                    key={h.id}
                    className="absolute rounded-[3px] border border-foreground/70"
                    style={{ left: (h.rect.x / hv.width) * rect.width, top: (h.rect.y / hv.height) * rect.height, width: (h.rect.width / hv.width) * rect.width, height: (h.rect.height / hv.height) * rect.height }}
                  >
                    <span className="absolute -top-px left-[-1px] max-w-full -translate-y-full truncate rounded-t-[3px] bg-foreground px-1 font-mono text-[9px] leading-3.5 text-background">{h.label}</span>
                  </div>
                ))
              )}
            </div>
            <ActionHud scale={scale} />
            {tip && (
              <div
                className="pointer-events-none absolute z-20 flex max-w-60 -translate-y-full items-baseline gap-1.5 truncate rounded-md bg-popover px-2 py-1 text-[11px] text-popover-foreground ring-1 ring-border"
                style={{ left: Math.min(tip.x + 10, Math.max(0, rect.width - 160)), top: tip.y - 10 }}
              >
                <span className="font-mono text-[10px] text-muted-foreground">{tip.label}</span>
                <span className="truncate">{tip.value}</span>
              </div>
            )}
          </div>
          {children}
        </RectContext.Provider>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- chat embed

/** The Web Preview shown inline in the chat: ≤ 80% of the chat area's width and height, rescaling with it. */
export function BrowserEmbed({ className }: { className?: string }) {
  const url = useSessionUrl();
  const [vw, vh] = useBrowserView().viewport;
  // 36px nav + 24px status bar around a frame of the page's own aspect ratio
  const width = `min(80cqw, calc((80cqh - 60px) * ${(vw / vh).toFixed(4)}))`;
  return (
    <WebPreview url={url} onUrlChange={navigateTo} style={{ width }} className={cn("rounded-xl bg-card", className)}>
      <BrowserNav />
      <WebPreviewBody className="flex-none" style={{ aspectRatio: `${vw} / ${vh}` }}>
        <BrowserCanvas />
      </WebPreviewBody>
      <StatusBar />
    </WebPreview>
  );
}
