"use client";
import { useSyncExternalStore } from "react";

/** Client-only UI state shared across the chat and the stage (e.g. the actor window being open). */
type UI = { actorOpen: boolean };
let ui: UI = { actorOpen: false };
const ls = new Set<() => void>();
export const setUI = (p: Partial<UI>) => { ui = { ...ui, ...p }; ls.forEach((l) => l()); };
export const useUI = <T,>(sel: (u: UI) => T): T => useSyncExternalStore((cb) => { ls.add(cb); return () => void ls.delete(cb); }, () => sel(ui), () => sel(ui));
