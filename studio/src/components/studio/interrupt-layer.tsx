"use client";

import { useEffect, useRef, useState } from "react";
import { useInterrupts, type Interrupt } from "@/lib/interrupts";
import { useBrowserView } from "@/lib/playback";
import { cn } from "@/lib/utils";
import { useBrowserRect } from "./browser";
import { Retro } from "./retro";

/**
 * Active interrupt surfaces as a lo-fi modal card centred over the page. When the machine acts while one is up
 * (its dismiss: a click or key), the button flashes; the surface's deleteSurface then removes the card.
 */
export function InterruptLayer() {
  const rect = useBrowserRect();
  const list = useInterrupts();
  const act = useBrowserView().act;
  const [flash, setFlash] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Interrupt[]>([]);
  const prev = useRef<Interrupt[]>([]);

  useEffect(() => {
    if (!act || !list.length || (act.act.kind !== "click" && act.act.kind !== "key")) return;
    setFlash(act.key);
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act]);

  // a dismissed surface fades out instead of vanishing
  useEffect(() => {
    const gone = prev.current.filter((p) => !list.some((x) => x.surfaceId === p.surfaceId));
    prev.current = list;
    if (!gone.length) return;
    setLeaving(gone);
    const t = setTimeout(() => setLeaving([]), 350);
    return () => clearTimeout(t);
  }, [list]);

  if (!rect || (!list.length && !leaving.length)) return null;
  const all = [...list.map((i) => ({ i, out: false })), ...leaving.map((i) => ({ i, out: true }))];
  return (
    <div className="pointer-events-none absolute z-20 flex items-center justify-center" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <div className={cn("absolute inset-0 bg-background/45 transition-opacity duration-300", !list.length && "opacity-0")} />
      {all.map(({ i, out }, k) => (
        <div
          key={i.surfaceId}
          className={cn(
            "relative flex w-[min(62%,280px)] flex-col items-center gap-2.5 rounded-lg border bg-card px-4 py-3.5 text-center ring-1 ring-foreground/5",
            out ? "animate-out fade-out zoom-out-95 duration-300 fill-mode-forwards" : "animate-in fade-in zoom-in-95 duration-200",
          )}
          style={{ transform: k ? `translate(${k * 10}px, ${k * 10}px)` : undefined }}
        >
          <div className="flex items-center gap-1.5 text-[10px] tracking-wide text-muted-foreground uppercase">
            <Retro name="highlight" />
            interrupt · {i.view}
          </div>
          <p className="text-[13px] font-medium">{i.title}</p>
          <span className="flex w-full flex-col gap-1">
            <span className="mx-auto h-1 w-3/4 rounded-full bg-muted" />
            <span className="mx-auto h-1 w-1/2 rounded-full bg-muted" />
          </span>
          {i.button && (
            <span
              className={cn(
                "rounded-md border px-3 py-0.5 text-[11px] transition-colors duration-150",
                (flash || out) ? "border-foreground bg-foreground text-background" : "bg-background",
              )}
            >
              {i.button}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
