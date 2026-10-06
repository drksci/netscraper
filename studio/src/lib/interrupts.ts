"use client";
import { useEffect, useMemo, useState } from "react";
import { useBrowserView } from "./playback";
import { a2uiStore, useSession } from "./session-store";

/**
 * Interrupt surfaces (login modal, cookie banner…): the runtime projects each detected interrupt view as its own
 * A2UI surface ("…interrupt:<view>-<n>"), created when it appears and deleted when it is gone. Derived from the
 * scene's buffered a2ui during playback, or the live stream when caught up.
 */
export interface Interrupt { surfaceId: string; view: string; title: string; button: string | null }

type Raw = { surfaceId: string; components: any[]; model: unknown };
const isInterrupt = (id: unknown): id is string => typeof id === "string" && id.includes("interrupt:");
const viewOf = (sid: string) => sid.slice(sid.indexOf("interrupt:") + 10).replace(/-\d+$/, "");

function apply(map: Map<string, Raw>, msg: any) {
  if (!msg || typeof msg !== "object") return;
  if (msg.__reset) { map.clear(); return; }
  const c = msg.createSurface, u = msg.updateComponents, d = msg.updateDataModel, x = msg.deleteSurface;
  if (c && isInterrupt(c.surfaceId)) map.set(c.surfaceId, { surfaceId: c.surfaceId, components: [], model: {} });
  else if (u && isInterrupt(u.surfaceId)) { const r = map.get(u.surfaceId); if (r) r.components = Array.isArray(u.components) ? u.components : []; }
  else if (d && isInterrupt(d.surfaceId)) { const r = map.get(d.surfaceId); if (r && (d.path === "/" || !d.path)) r.model = d.value ?? d.contents ?? {}; }
  else if (x && isInterrupt(x.surfaceId)) map.delete(x.surfaceId);
}

const read = (v: unknown, model: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as any).path === "string") {
    let cur: any = model;
    for (const k of (v as any).path.split("/").filter(Boolean)) cur = cur?.[k];
    return cur == null ? null : String(cur);
  }
  if (v && typeof v === "object" && typeof (v as any).literalString === "string") return (v as any).literalString;
  return null;
};
const humanise = (s: string) => { const w = s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); };

function describe(r: Raw, titles: Record<string, string>): Interrupt {
  const view = viewOf(r.surfaceId);
  const byId = new Map(r.components.map((c: any) => [c?.id, c]));
  const btn = r.components.find((c: any) => c?.component === "Button");
  const label = btn ? read(byId.get(btn.child)?.text, r.model) ?? read(btn.label, r.model) ?? "Close" : null;
  const heading = r.components.find((c: any) => c?.component === "Text" && c.id !== btn?.child);
  return { surfaceId: r.surfaceId, view, title: (heading && read(heading.text, r.model)) || titles[view] || humanise(view), button: label };
}

export function useInterrupts(): Interrupt[] {
  const replay = useBrowserView().a2ui;
  const views = useSession((s) => s.manifest?.doc?.views);
  const titles = useMemo(() => Object.fromEntries(Object.entries((views ?? {}) as Record<string, any>).map(([k, v]) => [k, typeof v?.title === "string" ? v.title : ""])), [views]);

  // live: follow the stream (only used when no scene is playing)
  const [live, setLive] = useState<Raw[]>([]);
  useEffect(() => {
    if (replay) return;
    const map = new Map<string, Raw>();
    a2uiStore.backlog().forEach((m) => apply(map, m));
    setLive([...map.values()]);
    return a2uiStore.subscribe((m) => {
      const before = map.size;
      apply(map, m);
      if (map.size !== before || isInterrupt(m?.updateComponents?.surfaceId) || isInterrupt(m?.updateDataModel?.surfaceId)) setLive([...map.values()]);
    });
  }, [replay]);

  const fromReplay = useMemo(() => {
    if (!replay) return null;
    const map = new Map<string, Raw>();
    for (const m of replay) apply(map, m);
    return [...map.values()];
  }, [replay]);

  const raws = fromReplay ?? live;
  const sig = raws.map((r) => `${r.surfaceId}:${r.components.length}:${JSON.stringify(r.model)}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => raws.map((r) => describe(r, titles)), [sig, titles]);
}
