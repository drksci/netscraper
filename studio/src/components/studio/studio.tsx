"use client";

import { useEffect, useMemo, useState } from "react";
import { applyPatch, deriveAuthoring, isStreaming, toolName, toolParts, useDraftFacets } from "@/lib/authoring";
import { useUI } from "@/lib/ui-store";
import { usePlayback, usePlaybackDriver } from "@/lib/playback";
import { useSession, useSessionEvents } from "@/lib/session-store";
import { useStudioChat } from "@/lib/use-studio-chat";
import { cn } from "@/lib/utils";
import { ChatPanel } from "./chat";
import { Stage, type StageView } from "./stage";
import { ProductionStage } from "./production";
import { ActorTerminal } from "./actor-terminal";

type Mode = "chat" | "split" | "half";

// Panes are absolutely positioned so left/width animate smoothly between modes.
const POS: Record<Mode, { chat: React.CSSProperties; stage: React.CSSProperties }> = {
  chat: { chat: { left: "0%", width: "100%" }, stage: { left: "100%", width: "75%" } },
  split: { chat: { left: "0%", width: "25%" }, stage: { left: "25%", width: "75%" } },
  half: { chat: { left: "0%", width: "50%" }, stage: { left: "50%", width: "50%" } },
};
const EASE = "duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]";

export function Studio() {
  useSessionEvents();
  usePlaybackDriver();
  const chat = useStudioChat();
  const phase = useSession((s) => s.phase);
  const hasSchema = useSession((s) => !!s.schema);
  const manifest = useSession((s) => s.manifest);
  const hasRun = useSession((s) => s.scenes.some((x) => x.kind === "run"));
  const openRun = useSession((s) => s.scenes.some((x) => x.kind === "run" && !x.done));
  const curScene = usePlayback((s) => s.cur);
  const playingRun = useSession((s) => !!curScene && s.scenes.some((x) => x.id === curScene && x.kind === "run"));

  const authoring = useMemo(() => deriveAuthoring(toolParts(chat.messages)), [chat.messages]);

  // production: the scale run takes the stage (machine + live records); once its artifact lands, chat and stage go 50/50
  const production = phase === "production";
  const finished = useSession((s) => !!s.production.artifact);
  const actorOpen = useUI((u) => u.actorOpen);

  // chat alone until there is something to author; the user can flip it until the next automatic change
  const auto: Mode = finished ? "half" : authoring.started || hasSchema || manifest || production ? "split" : "chat";
  const [override, setOverride] = useState<{ mode: Mode; for: Mode } | null>(null);
  const mode = override && override.for === auto ? override.mode : auto;

  // stage view follows the work: Both while a document streams, full Browser (+ Dock) once a mapped manifest runs
  const runSignal = (authoring.running && !!manifest?.valid) || openRun || playingRun;
  const writing = authoring.active !== null;
  const [autoView, setAutoView] = useState<StageView>("both");
  const tuned = phase === "tune" && hasRun;
  useEffect(() => { if (tuned) setAutoView("browser"); }, [tuned]);
  useEffect(() => {
    if (runSignal) setAutoView("browser");
    else if (writing) setAutoView("both");
  }, [runSignal, writing]);

  // while the manifest is being written, show its draft facets on the live page
  const m = authoring.manifest;
  const streamingManifest = isStreaming(m);
  const draftViews = useMemo(() => {
    if (!streamingManifest || !m) return undefined;
    const doc = m.toolName.endsWith("patch_manifest") ? applyPatch(manifest?.doc, m.input?.patch) : m.input?.manifest;
    return doc?.views as Record<string, unknown> | undefined;
  }, [streamingManifest, m, manifest?.doc]);
  useDraftFacets(streamingManifest, draftViews);

  const split = mode !== "chat";
  const scaleInputs = useMemo(() => {
    const p = toolParts(chat.messages).findLast((x) => toolName(x) === "run_at_scale");
    const i = p?.input?.inputs;
    return i && typeof i === "object" ? (i as Record<string, unknown>) : {};
  }, [chat.messages]);
  const machine = manifest?.doc?.machine;
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background">
      <section className={cn("absolute inset-y-0 transition-[left,width]", EASE)} style={POS[mode].chat}>
        <ChatPanel
          chat={chat}
          wide={!split}
          stageOpen={split}
          onToggleStage={() => setOverride({ mode: split ? "chat" : "split", for: auto })}
        />
      </section>
      <section
        className={cn("absolute inset-y-0 py-3 pr-3 transition-[left,width,opacity]", EASE, !split && "pointer-events-none opacity-0")}
        style={POS[mode].stage}
        inert={!split}
      >
        {actorOpen && finished ? (
          <ActorTerminal key="actor" defaults={scaleInputs} />
        ) : production || finished ? (
          <ProductionStage key="production" machine={machine} />
        ) : (
          <Stage authoring={authoring} autoView={autoView} />
        )}
      </section>
    </main>
  );
}
