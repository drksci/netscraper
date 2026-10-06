/**
 * The A2UI driver: a "user" of the rendered surface. It sees only the SurfaceStore (components +
 * data model) and speaks only A2UI client→server `action` messages. It never touches the DOM —
 * the ActionBridge (the A2UI "server") turns those messages into browser operations.
 */
import type { ClientAction } from "../a2ui/types.js";
import { buildAction, instancesOf, type RenderNode, type Surface, type SurfaceStore } from "../a2ui/surface.js";
import { getAt } from "../a2ui/pointer.js";

export type ActionSink = (a: ClientAction) => Promise<void>;

export class A2UIDriver {
  constructor(private store: SurfaceStore, private sink: ActionSink) {}

  surface(componentId?: string): Surface {
    const s = this.store.current();
    // components of an interrupt surface (modal, banner) are addressable too
    if (componentId && !s?.components.has(componentId)) {
      for (const o of this.store.surfaces.values()) if (o.surfaceId.includes("interrupt:") && o.components.has(componentId)) return o;
    }
    if (!s) throw new Error("no active A2UI surface");
    return s;
  }

  /** Pick a rendered instance: by index among template instances, or by matching item data. */
  instance(componentId: string, item?: number | Record<string, unknown>): RenderNode {
    const s = this.surface(componentId);
    const all = instancesOf(s, componentId);
    if (!all.length) throw new Error(`component ${componentId} not rendered on ${s.surfaceId}`);
    if (item == null) return all[0];
    if (typeof item === "number") {
      if (!all[item]) throw new Error(`${componentId}[${item}] not rendered (have ${all.length})`);
      return all[item];
    }
    const hit = all.find((n) => {
      const data = getAt(s.dataModel, n.scope) as Record<string, unknown> | undefined;
      return data && Object.entries(item).every(([k, v]) => String(data[k]) === String(v));
    });
    if (hit) return hit;
    // Not rendered (e.g. list virtualised away) — synthesise the action from the item data alone.
    return { ...all[0], scope: "/__virtual" };
  }

  /** Trigger the event action of a Button (or template instance) — exactly what a human tap does. */
  async act(componentId: string, item?: number | Record<string, unknown>): Promise<ClientAction> {
    const s = this.surface(componentId);
    const node = this.instance(componentId, item);
    const a = buildAction(s, node);
    if (node.scope === "/__virtual" && item && typeof item === "object") Object.assign(a.action.context, item);
    await this.sink(a);
    return a;
  }

  /**
   * Two-way binding write (TextField/CheckBox…): update the local data model then report it as an
   * `input` action so the bridge can mirror it into the page.
   */
  async input(componentId: string, value: unknown): Promise<ClientAction> {
    const s = this.surface();
    const c = s.components.get(componentId);
    const path = (c?.value as any)?.path;
    if (!path) throw new Error(`${componentId} has no bound value`);
    this.store.apply({ version: "v0.9", updateDataModel: { surfaceId: s.surfaceId, path, value } });
    const a: ClientAction = {
      version: "v0.9",
      action: { name: "input", surfaceId: s.surfaceId, sourceComponentId: componentId, timestamp: new Date().toISOString(), context: { value } },
    };
    await this.sink(a);
    return a;
  }
}
