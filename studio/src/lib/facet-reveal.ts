"use client";
import { useSyncExternalStore } from "react";
import { hoverId, type HoverKey } from "./facet-hover";

/**
 * Paced reveal: facets register as their code blocks stream in (document order) and are revealed
 * one at a time, STEP_MS apart, so the user can follow each block → page element correspondence.
 * The current step is "active" (tinted + bordered on both sides); unregistered facets are unaffected.
 */
const STEP_MS = 850;
const SETTLE_MS = 1600;

type State = { order: string[]; cursor: number; active: string | null; keys: Record<string, HoverKey> };
let state: State = { order: [], cursor: -1, active: null, keys: {} };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let notifyQueued = false;

const notify = () => {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; listeners.forEach((l) => l()); });
};

function tick() {
  timer = undefined;
  if (state.cursor < state.order.length - 1) {
    const cursor = state.cursor + 1;
    state = { ...state, cursor, active: state.order[cursor] };
    notify();
    timer = setTimeout(tick, STEP_MS);
  } else if (state.active) {
    timer = setTimeout(() => { timer = undefined; if (state.cursor >= state.order.length - 1) { state = { ...state, active: null }; notify(); } else tick(); }, SETTLE_MS);
  }
}

/** Idempotent; safe to call during render (notifies asynchronously). */
export function registerFacet(key: HoverKey) {
  const id = hoverId(key);
  if (id in state.keys) return;
  state = { ...state, order: [...state.order, id], keys: { ...state.keys, [id]: key } };
  if (!timer) timer = setTimeout(tick, state.cursor < 0 ? 0 : 120);
  notify();
}

/** Reveal everything now. */
export function skipReveal() {
  clearTimeout(timer); timer = undefined;
  state = { ...state, cursor: state.order.length - 1, active: null };
  notify();
}

export function useReveal() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => void listeners.delete(cb); }, () => state, () => state);
}

/** Visible yet? Facets never registered by the code panel are always visible. */
export function isRevealed(s: State, key: HoverKey): boolean {
  const i = s.order.indexOf(hoverId(key));
  return i < 0 || i <= s.cursor;
}
export const isActive = (s: State, key: HoverKey) => s.active === hoverId(key);
export const revealPending = (s: State) => s.cursor < s.order.length - 1;
