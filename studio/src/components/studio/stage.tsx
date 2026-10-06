"use client";

import { useState } from "react";
import { WebPreview } from "@/components/ai-elements/web-preview";
import type { Authoring } from "@/lib/authoring";
import { cn } from "@/lib/utils";
import { BrowserCanvas, BrowserNav, StatusBar, navigateTo, useSessionUrl } from "./browser";
import { CodePane } from "./code-pane";
import { A2UIOverlay, type OverlayMode } from "./dock";
import { InterruptLayer } from "./interrupt-layer";
import { SceneStrip } from "./scene-strip";
import { Segmented } from "./segmented";
import { Retro } from "./retro";

export type StageView = "browser" | "code" | "both";

const VIEWS = [
  { id: "browser" as const, label: <><Retro name="ie" />Browser</>, hint: "Browser" },
  { id: "code" as const, label: <><Retro name="manifest" />Code</>, hint: "Code" },
  { id: "both" as const, label: <><Retro name="both" />Both</>, hint: "Code over browser" },
];
const OVERLAYS = [
  { id: "lofi" as const, label: "Lo-fi", hint: "A2UI components cover their source elements" },
  { id: "stream" as const, label: "Stream", hint: "The raw A2UI stream" },
  { id: "off" as const, label: "Off", hint: "The page as is" },
];

const ROWS: Record<StageView, string> = {
  both: "minmax(0,1fr) minmax(0,1fr)",
  code: "minmax(0,1fr) minmax(0,0fr)",
  browser: "minmax(0,0fr) minmax(0,1fr)",
};

/**
 * The right-hand surface: code on top, browser underneath. `autoView` follows the work (Both while authoring,
 * Browser + Dock while a run plays); a user pick holds until the work moves to the next stage.
 */
export function Stage({ authoring, autoView, className }: { authoring: Authoring; autoView: StageView; className?: string }) {
  const [picked, setPicked] = useState<{ view: StageView; for: StageView } | null>(null);
  const [overlay, setOverlay] = useState<OverlayMode>("lofi");
  const view = picked && picked.for === autoView ? picked.view : autoView;
  const url = useSessionUrl();

  const showCode = view !== "browser";
  const switcher = <Segmented label="View" value={view} onChange={(v) => setPicked({ view: v, for: autoView })} items={VIEWS} />;

  return (
    <div
      className={cn("@container/stage grid size-full min-h-0 overflow-hidden rounded-xl border bg-card transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", className)}
      style={{ gridTemplateRows: ROWS[view] }}
    >
      <section className="min-h-0 overflow-hidden" inert={!showCode}>
        {showCode && <CodePane authoring={authoring} headerEnd={switcher} />}
      </section>
      <section className={cn("min-h-0 overflow-hidden", view === "both" && "border-t")} inert={view === "code"}>
        <WebPreview url={url} onUrlChange={navigateTo} className="rounded-none border-0 bg-transparent">
          <BrowserNav
            end={
              <>
                {view === "browser" && <Segmented label="Overlay" value={overlay} onChange={setOverlay} items={OVERLAYS} className="animate-in fade-in" />}
                {!showCode && switcher}
              </>
            }
          />
          <div className="relative min-h-0 flex-1">
            <BrowserCanvas>
              {/* the A2UI overlay belongs to the full browser view */}
              <A2UIOverlay mode={view === "browser" ? overlay : "off"} />
              {/* interrupts (login modal, cookie banner) are machine events: always shown */}
              <InterruptLayer />
            </BrowserCanvas>
          </div>
          <StatusBar />
          <SceneStrip />
        </WebPreview>
      </section>
    </div>
  );
}
