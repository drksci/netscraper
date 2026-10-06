"use client";

import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, CornerUpLeftIcon, GlobeIcon, KeyboardIcon, MousePointerClickIcon, type LucideIcon } from "lucide-react";
import { useBrowserView } from "@/lib/playback";
import type { Act } from "@/lib/session-store";
import { useInterrupts } from "@/lib/interrupts";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const SHOW_MS = 900;
const STEPS = 8;

function describe(a: Act): { icon: LucideIcon; label: string } {
  switch (a.kind) {
    case "scroll": return { icon: a.dir === "up" ? ArrowUpIcon : ArrowDownIcon, label: a.dir === "up" ? "Scroll up" : "Scroll down" };
    case "click": return { icon: MousePointerClickIcon, label: a.target ? String(a.target) : "Click" };
    case "navigate": {
      let label = "Navigate";
      try { const u = new URL(String(a.url)); label = `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`; } catch { /* keep */ }
      return { icon: GlobeIcon, label };
    }
    case "back": return { icon: CornerUpLeftIcon, label: "Back" };
    default: return { icon: KeyboardIcon, label: a.kind === "type" ? "Type" : String(a.key ?? "Key") };
  }
}

/** macOS-style HUD (volume/brightness) for each act at its timecode; clicks also ripple at the point. */
export function ActionHud({ scale }: { scale: number }) {
  const act = useBrowserView().act;
  const interrupts = useInterrupts();
  const [shown, setShown] = useState<{ act: Act; key: string; dismiss?: boolean } | null>(null);

  useEffect(() => {
    if (!act) return;
    // a click / key while an interrupt surface is up is the machine dismissing it
    setShown({ ...act, dismiss: interrupts.length > 0 && (act.act.kind === "click" || act.act.kind === "key") });
    const t = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act]);

  if (!shown) return null;
  const a = shown.act;
  const { icon: Icon, label } = shown.dismiss ? { icon: XIcon, label: "Dismiss" } : describe(a);
  const steps = a.kind === "scroll" ? Math.max(1, Math.min(STEPS, Math.round(Number(a.amount ?? 600) / 120))) : 0;
  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {a.kind === "click" && a.x != null && a.y != null && (
        <span key={`r-${shown.key}`} className="absolute" style={{ left: Number(a.x) * scale, top: Number(a.y) * scale }}>
          <span className="absolute size-7 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border border-foreground/60" />
          <span className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/70" />
        </span>
      )}
      <div
        key={`h-${shown.key}`}
        className="absolute top-1/2 left-1/2 flex size-28 -translate-x-1/2 -translate-y-1/2 animate-in flex-col items-center justify-center gap-2 rounded-2xl bg-popover/80 px-3 text-popover-foreground ring-1 ring-border backdrop-blur-xl duration-150 fade-in zoom-in-95"
      >
        <Icon className="size-8" strokeWidth={1.25} />
        <span className="max-w-full truncate text-[11px] text-muted-foreground">{label}</span>
        {steps > 0 && (
          <div className="flex w-full gap-[3px] px-1">
            {Array.from({ length: STEPS }, (_, i) => {
              const on = a.dir === "up" ? i >= STEPS - steps : i < steps;
              return <span key={i} className={cn("h-1 flex-1 rounded-[1px]", on ? "bg-foreground/80" : "bg-foreground/10")} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
