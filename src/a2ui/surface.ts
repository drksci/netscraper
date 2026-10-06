/**
 * Client-side A2UI surface state — what a renderer holds after consuming the stream.
 * The A2UI driver operates *only* on this (never the DOM), which is the point:
 * a flow written against surfaces/actions is independent of the page underneath.
 */
import { A2UI_VERSION, type ClientAction, type Component, type ServerMessage, isBinding } from "./types.js";
import { getAt, resolvePath, setAt } from "./pointer.js";

export interface Surface {
  surfaceId: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  components: Map<string, Component>;
  dataModel: unknown;
}

/** A component instantiated in the tree, with its data scope (template instances get `/list/N`). */
export interface RenderNode {
  id: string;
  component: string;
  scope: string;
  props: Record<string, unknown>;
  children: RenderNode[];
}

export class SurfaceStore {
  surfaces = new Map<string, Surface>();
  /** Most recently created surface — flows act on the "current view". */
  active?: string;

  apply(m: ServerMessage): void {
    if ("createSurface" in m) {
      const { surfaceId, catalogId, theme } = m.createSurface;
      if (this.surfaces.has(surfaceId)) throw new Error(`surface ${surfaceId} already exists`);
      this.surfaces.set(surfaceId, { surfaceId, catalogId, theme, components: new Map(), dataModel: {} });
      this.active = surfaceId;
    } else if ("updateComponents" in m) {
      const s = this.need(m.updateComponents.surfaceId);
      for (const c of m.updateComponents.components) s.components.set(c.id, c);
    } else if ("updateDataModel" in m) {
      const s = this.need(m.updateDataModel.surfaceId);
      s.dataModel = setAt(s.dataModel, m.updateDataModel.path ?? "/", m.updateDataModel.value);
    } else if ("deleteSurface" in m) {
      this.surfaces.delete(m.deleteSurface.surfaceId);
      if (this.active === m.deleteSurface.surfaceId) this.active = undefined;
    }
  }

  current(): Surface | undefined {
    return this.active ? this.surfaces.get(this.active) : undefined;
  }

  private need(id: string): Surface {
    const s = this.surfaces.get(id);
    if (!s) throw new Error(`unknown surface ${id}`);
    return s;
  }
}

/** Resolve a Dynamic* value (literal | {path} | {call}) in a scope. */
export function resolveDynamic(v: unknown, model: unknown, scope = "/"): unknown {
  if (isBinding(v)) return getAt(model, resolvePath(v.path, scope));
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).call === "string") {
    return callFunction((v as any).call, (v as any).args ?? {}, model, scope);
  }
  return v;
}

function callFunction(name: string, args: Record<string, unknown>, model: unknown, scope: string): unknown {
  const a = (k: string) => resolveDynamic(args[k], model, scope);
  switch (name) {
    case "formatString":
      return String(a("value") ?? "").replace(/\$\{([^}]+)\}/g, (_, p) => str(getAt(model, resolvePath(p.trim(), scope))));
    case "formatNumber": {
      const n = Number(a("value"));
      return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: Number(a("decimals") ?? 0) }) : "";
    }
    case "not": return !a("value");
    case "required": { const v = a("value"); return v != null && v !== "" && !(Array.isArray(v) && !v.length); }
    default: return undefined;
  }
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const CHILD_PROPS = ["child", "trigger", "content"] as const;

/** Expand the adjacency list from `root`, instantiating templates against the data model. */
export function renderTree(s: Surface, rootId = "root"): RenderNode | undefined {
  const seen = new Set<string>();
  const build = (id: string, scope: string): RenderNode | undefined => {
    const c = s.components.get(id);
    const key = `${id}@${scope}`;
    if (!c || seen.has(key)) return undefined;
    seen.add(key);
    const props: Record<string, unknown> = {};
    const children: RenderNode[] = [];
    for (const [k, v] of Object.entries(c)) {
      if (k === "id" || k === "component") continue;
      if (k === "children") {
        if (Array.isArray(v)) v.forEach((cid) => { const n = build(cid, scope); if (n) children.push(n); });
        else if (v && typeof v === "object") {
          const t = v as { componentId: string; path: string };
          const listPath = resolvePath(t.path, scope);
          const items = getAt(s.dataModel, listPath);
          if (Array.isArray(items)) items.forEach((_, i) => {
            const n = build(t.componentId, `${listPath === "/" ? "" : listPath}/${i}`);
            if (n) children.push(n);
          });
        }
      } else if ((CHILD_PROPS as readonly string[]).includes(k) && typeof v === "string") {
        const n = build(v, scope); if (n) children.push(n);
      } else if (k === "action") {
        props[k] = v; // resolved lazily at dispatch time
      } else {
        props[k] = resolveDynamic(v, s.dataModel, scope);
      }
    }
    return { id, component: c.component, scope, props, children };
  };
  return build(rootId, "/");
}

export function* walk(n: RenderNode | undefined): Generator<RenderNode> {
  if (!n) return;
  yield n;
  for (const c of n.children) yield* walk(c);
}

/** All rendered instances of a component (one per template item for templated components). */
export function instancesOf(s: Surface, componentId: string): RenderNode[] {
  return [...walk(renderTree(s))].filter((n) => n.id === componentId);
}

/** Build the v0.9 client→server `action` message for a rendered Button instance. */
export function buildAction(s: Surface, node: RenderNode): ClientAction {
  const action = s.components.get(node.id)?.action as any;
  if (!action?.event) throw new Error(`component ${node.id} has no event action`);
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action.event.context ?? {})) context[k] = resolveDynamic(v, s.dataModel, node.scope);
  return {
    version: A2UI_VERSION,
    action: {
      name: action.event.name,
      surfaceId: s.surfaceId,
      sourceComponentId: node.id,
      timestamp: new Date().toISOString(),
      context,
    },
  };
}
