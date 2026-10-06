import { componentBinding, normaliseBinding } from "./facets";

/** A2UI components of a view → the facet path each one binds (templates under a List resolve relative paths). */
export function componentFacets(components: unknown): { index: number; component: any; path: string | null }[] {
  if (!Array.isArray(components)) return [];
  const byId = new Map<string, any>(components.map((c: any) => [c?.id, c]));
  const base = new Map<string, string>();
  const descend = (id: string, b: string, seen = new Set<string>()) => {
    if (seen.has(id)) return;
    seen.add(id);
    base.set(id, b);
    const c = byId.get(id);
    if (!c) return;
    for (const k of [c.child, ...(Array.isArray(c.children) ? c.children : [])]) if (typeof k === "string") descend(k, b, seen);
  };
  for (const c of components as any[]) {
    const ch = c?.children;
    if (c?.component === "List" && ch && typeof ch === "object" && !Array.isArray(ch) && typeof ch.componentId === "string") descend(ch.componentId, ch.path);
  }
  return (components as any[]).map((c, index) => {
    const b = componentBinding(c);
    return { index, component: c, path: b ? normaliseBinding(b, base.get(c.id)) : null };
  });
}
