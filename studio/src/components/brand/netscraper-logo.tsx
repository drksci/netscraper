"use client";
/**
 * Netscraper brand (Sierra-style: one colour, a horizontally striped sun with the Brisbane skyline cut out).
 *  - <NetscraperSplash/>: the VGA loading screen (320×200 canvas, hard pixels, animated), for the actor TUI.
 *  - <NetscraperMark/>: small monochrome mark (currentColor) for the app chrome.
 *  - <NetscraperLockup/>: mark + wordmark.
 */
import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { drawVgaSplash, H, W } from "./vga-splash";

export function NetscraperSplash({ className, status, progress }: { className?: string; status?: string; progress?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const opts = useRef({ status, progress });
  opts.current = { status, progress };
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const t0 = performance.now();
    let last = 0, raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 100) return; // ~10 fps is plenty for a VGA splash
      last = now;
      drawVgaSplash(ctx, (now - t0) / 1000, opts.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      role="img"
      aria-label="Netscraper"
      className={cn("block aspect-[16/10] w-full bg-black", className)}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

/** Striped sun with the skyline (towers + Infinity spire) cut out, in currentColor. */
export function NetscraperMark({ className, title = "Netscraper" }: { className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={title} className={cn("size-5", className)} shapeRendering="geometricPrecision">
      <defs>
        <clipPath id={`${id}-sun`}><circle cx="12" cy="12" r="10.5" /></clipPath>
        <mask id={`${id}-cut`}>
          <rect width="24" height="24" fill="white" />
          {/* skyline above the waterline (y=14.5): stepped, wedge, spire, flats */}
          <path fill="black" d="M4 14.5V11h1.6v-1h1.6v4.5h0.6V8.2l2.4 1.2v5.1h0.6V9.5h1.4V3.6h0.5v2.4h0.6v8.5h0.6V9h1.8v5.5h0.6v-3.6h1.8v3.6z" />
          {/* waterlines below */}
          <rect y="15.8" width="24" height="0.6" fill="black" />
          <rect y="17.5" width="24" height="0.9" fill="black" />
          <rect y="19.6" width="24" height="1.2" fill="black" />
        </mask>
      </defs>
      <g clipPath={`url(#${id}-sun)`} mask={`url(#${id}-cut)`}>
        <rect width="24" height="24" fill="currentColor" />
      </g>
    </svg>
  );
}

/** Mark + wordmark for headers / start screens. */
export function NetscraperLockup({ className, size = "sm" }: { className?: string; size?: "sm" | "lg" }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground", className)}>
      <NetscraperMark className={size === "lg" ? "size-9" : "size-4"} />
      <span className={cn("font-serif tracking-[0.12em] uppercase", size === "lg" ? "text-2xl" : "text-sm")}>Netscraper</span>
    </span>
  );
}
