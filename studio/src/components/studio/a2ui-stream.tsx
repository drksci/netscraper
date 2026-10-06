"use client";

import { useEffect, useRef } from "react";
import { Retro } from "./retro";
import { A2UIClient, A2UI_CSS } from "@/lib/a2ui-renderer";
import { a2uiStore, sessionApi, useSession } from "@/lib/session-store";

// Map the renderer's --a2-* variables onto shadcn tokens.
const THEME_CSS = `
.a2ui-root{--a2-card:var(--card);--a2-line:var(--border);--a2-fg:var(--foreground)}
.a2ui-root [data-a2]{--a2-primary:var(--primary)!important}
.a2ui-root .a2-btn.a2-primary{color:var(--primary-foreground)}
.a2ui-root .a2-surface{font-family:inherit}
`;

const isControl = (id: string) => id.startsWith("control");

/** Vanilla A2UI stream renderer (no chrome). `replay` = buffered messages of a run (null = follow the live stream). */
export function A2UIStream({ replay = null }: { replay?: unknown[] | null }) {
  const scroll = useSession((s) => s.scroll);
  const bodyRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const lastUserScroll = useRef(0);
  const lastProgrammatic = useRef(0);

  useEffect(() => {
    let raf = 0;
    let controlDirty = true;
    const make = () =>
      new A2UIClient({ onAction: (action: unknown) => void sessionApi.post("action", { action }) });
    let client = make();

    const render = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const order: string[] = client.order;
        const page = [...order].reverse().find((id) => !isControl(id));
        const control = order.find(isControl);
        if (surfaceRef.current) {
          if (page) client.mount(surfaceRef.current, page); else surfaceRef.current.innerHTML = "";
        }
        if (controlRef.current) {
          if (control) {
            if (controlDirty) { client.mount(controlRef.current, control); controlDirty = false; }
          } else { controlRef.current.innerHTML = ""; controlDirty = true; }
        }
        if (emptyRef.current) emptyRef.current.hidden = order.length > 0;
      });
    };

    const apply = (msg: any) => {
      if (msg?.__reset) { client = make(); controlDirty = true; render(); return; }
      if (msg?.clientAction) return; // client → server actions, not surface updates
      client.apply(msg);
      const sid = msg.createSurface?.surfaceId ?? msg.updateComponents?.surfaceId ?? msg.updateDataModel?.surfaceId ?? msg.deleteSurface?.surfaceId ?? "";
      // Don't re-mount the control surface while the user types (input-only data model updates)
      if (isControl(sid) && !(msg.updateDataModel && String(msg.updateDataModel.path ?? "").startsWith("/inputs"))) controlDirty = true;
      render();
    };

    if (replay) {
      replay.forEach(apply);
      return () => cancelAnimationFrame(raf);
    }
    a2uiStore.backlog().forEach(apply);
    const unsub = a2uiStore.subscribe(apply);
    return () => { unsub(); cancelAnimationFrame(raf); };
  }, [replay]);

  // Server -> A2UI scroll sync
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || scroll.n === 0 || replay) return;
    if (Date.now() - lastUserScroll.current < 600) return; // we are the source; avoid feedback
    lastProgrammatic.current = Date.now();
    el.scrollTop = scroll.ratio * Math.max(0, el.scrollHeight - el.clientHeight);
  }, [scroll, replay]);

  // A2UI -> server scroll sync (throttled, trailing)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el || replay || Date.now() - lastProgrammatic.current < 150) return;
    lastUserScroll.current = Date.now();
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const max = el.scrollHeight - el.clientHeight;
      void sessionApi.post("scroll", { ratio: max > 0 ? el.scrollTop / max : 0 });
    }, 100);
  };

  return (
    <div ref={bodyRef} onScroll={onScroll} className="a2ui-root size-full overflow-auto p-3 text-xs">
      <style>{A2UI_CSS + THEME_CSS}</style>
      <div data-a2 ref={controlRef} className="mb-3 empty:mb-0" />
      <div data-a2 ref={surfaceRef} />
      <div ref={emptyRef} className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Retro name="view" />
        No surface yet
      </div>
    </div>
  );
}
