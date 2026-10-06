"use client";
import { useSyncExternalStore } from "react";

/** Shared hover state between the code panel and the browser overlays. */
export type HoverKey = { family: string; leaf: string | null };
type State = { key: HoverKey | null; source: "code" | "page" | null };

let state: State = { key: null, source: null };
const listeners = new Set<() => void>();

/** "videos" / "video" / "Videos" → one comparable family id. */
export const norm = (s: string) => s.toLowerCase().replace(/(ies)$/, "y").replace(/s$/, "");
export const hoverId = (k: { family: string; leaf: string | null }) => `${norm(k.family)}|${k.leaf?.toLowerCase() ?? ""}`;

export function setHover(key: HoverKey | null, source: "code" | "page") {
  if (!key) {
    if (state.key && state.source === source) { state = { key: null, source: null }; listeners.forEach((l) => l()); }
    return;
  }
  if (state.source === source && state.key?.family === key.family && state.key?.leaf === key.leaf) return;
  state = { key, source };
  listeners.forEach((l) => l());
}

export function useHover(): State {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => void listeners.delete(cb); },
    () => state,
    () => state,
  );
}

/** Does an element with key `k` belong to the hovered facet? */
export function matchesHover(k: { family: string; leaf: string | null }, h: HoverKey | null): boolean {
  if (!h) return true;
  if (norm(k.family) !== norm(h.family)) return false;
  if (!k.leaf || !h.leaf) return true;
  return k.leaf.toLowerCase() === h.leaf.toLowerCase();
}
