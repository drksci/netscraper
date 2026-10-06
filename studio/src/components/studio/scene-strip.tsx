"use client";

import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { colorOfSchema, type SceneSummary } from "@/lib/facets";
import { playback, usePlayback, usePlayhead } from "@/lib/playback";
import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";

const SPEEDS = [1, 2, 4];
const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Playhead fill of the scene being played: the only part that re-renders every frame. */
function Fill({ scene }: { scene: SceneSummary }) {
  const t = usePlayhead();
  return <span className="absolute inset-y-0 left-0 bg-foreground/60" style={{ width: `${Math.min(100, (t / Math.max(1, scene.duration)) * 100)}%` }} />;
}

function Segment({ scene, state }: { scene: SceneSummary; state: "played" | "current" | "queued" }) {
  const run = scene.kind === "run";
  const jump = (e: React.MouseEvent<HTMLElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    playback.jump(scene.id, Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)));
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={scene.label} onClick={jump} className="group/seg flex h-full min-w-1.5 items-center outline-none" />}
        style={{ flex: `${Math.max(scene.duration, 800)} 1 0` }}
      >
        <span className={cn("relative w-full overflow-hidden rounded-full bg-foreground/10 transition-[height,background-color] group-hover/seg:bg-foreground/20", run ? "h-1.5" : "h-1", !scene.done && "animate-pulse")}>
          {state === "played" && <span className="absolute inset-0 bg-foreground/30" />}
          {state === "current" && <Fill scene={scene} />}
          {scene.marks.filter((m) => m.kind !== "state").map((m, i) => (
            <span
              key={i}
              className={cn("absolute inset-y-0 w-px", m.kind === "fault" && "w-0.5 bg-destructive")}
              style={{ left: `${(m.t / Math.max(1, scene.duration)) * 100}%`, ...(m.kind === "fault" ? null : { backgroundColor: colorOfSchema(m.route ?? "record").solid }) }}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{scene.label} · {scene.done ? dur(scene.duration) : "recording"}</TooltipContent>
    </Tooltip>
  );
}

/** Slim transport across every buffered scene: prev / play / next, speed, one segment per scene, Live. */
export function SceneStrip({ className }: { className?: string }) {
  const scenes = useSession((s) => s.scenes);
  const cur = usePlayback((s) => s.cur);
  const shown = usePlayback((s) => s.shown);
  const paused = usePlayback((s) => s.paused);
  const speed = usePlayback((s) => s.speed);
  const eff = usePlayback((s) => s.eff);
  const live = usePlayback((s) => s.view.live);
  if (!scenes.length) return null;
  const at = scenes.findIndex((s) => s.id === shown);
  const catchingUp = !live && eff > speed + 0.01;
  const label = scenes[at]?.label;

  return (
    <div className={cn("flex h-8 shrink-0 items-center gap-0.5 border-t px-1.5 text-muted-foreground", className)}>
      <Button variant="ghost" size="icon-xs" aria-label="Previous scene" onClick={playback.prev}><SkipBackIcon /></Button>
      <Button variant="ghost" size="icon-xs" aria-label={paused ? "Play" : "Pause"} onClick={() => (paused ? playback.play() : playback.pause())}>
        {paused ? <PlayIcon /> : <PauseIcon />}
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Next scene" onClick={playback.next}><SkipForwardIcon /></Button>
      <Button variant="ghost" size="xs" className="w-9 px-0 font-mono text-[10px] font-normal tabular-nums" aria-label="Playback speed" onClick={() => playback.speed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
        {catchingUp ? eff.toFixed(1) : speed}×
      </Button>
      {label && <span className="hidden max-w-40 truncate px-1 font-mono text-[10px] @2xl/stage:block">{label}</span>}
      <div className="mx-2 flex h-full min-w-0 flex-1 items-center gap-0.5">
        {scenes.map((s, i) => (
          <Segment key={s.id} scene={s} state={i < at || (i === at && cur !== s.id) ? "played" : i === at ? "current" : "queued"} />
        ))}
      </div>
      <Button variant="ghost" size="xs" className={cn("gap-1.5 text-[11px] font-normal", live && "text-foreground")} onClick={playback.live}>
        <span className={cn("size-1.5 rounded-full", live ? "bg-destructive" : "bg-muted-foreground/40")} />
        Live
      </Button>
    </div>
  );
}
