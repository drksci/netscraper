/**
 * Stream-native extraction: routes declared as JSONata over A2UI surface state.
 *
 *   route.from    = { view, on: "close" | "item", each? }   which surface + when it yields records
 *   route.extract = JSONata, evaluated with
 *       input       = the triggering surface's data model
 *       $model      = same
 *       $surfaces   = { <view>: last data model of that view, control: the run's control surface }
 *       $item       = the list item (on: "item")
 *       $view       = view id
 *
 * Because it reads only A2UI messages, the same manifest turns a recorded `a2ui.jsonl` back into the
 * dataset with no browser — and the live runtime uses the very same evaluator, so they must agree.
 * Surface ids follow `<prefix><view>-<seq>` (Projector convention).
 */
import jsonata from "jsonata";
import type { ServerMessage } from "../a2ui/types.js";
import { SurfaceStore } from "../a2ui/surface.js";
import type { FlowManifest, RouteSpec } from "../manifest/types.js";

const compiled = new Map<string, ReturnType<typeof jsonata>>();
function expr(src: string) {
  let e = compiled.get(src);
  if (!e) { e = jsonata(src); compiled.set(src, e); }
  return e;
}

export const viewOfSurface = (surfaceId: string) => surfaceId.replace(/-\d+$/, "").replace(/^.*[:/]/, "");

export async function evalRoute(r: RouteSpec, model: unknown, surfaces: Record<string, unknown>, view: string, item?: unknown): Promise<Record<string, unknown> | undefined> {
  if (!r.extract) throw new Error("route has no extract expression");
  const out = await expr(r.extract).evaluate(model, { model, surfaces, item, view });
  return out && typeof out === "object" ? JSON.parse(JSON.stringify(out)) : undefined; // drop JSONata sequence wrappers
}

export async function evalItems(r: RouteSpec, model: unknown, surfaces: Record<string, unknown>, view: string): Promise<unknown[]> {
  if (!r.from?.each) return [];
  const v = await expr(r.from.each).evaluate(model, { model, surfaces, view });
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** Replay an A2UI stream and produce route records (deduped by route key). */
export async function extractStream(m: FlowManifest, messages: Iterable<ServerMessage | Record<string, unknown>>) {
  const store = new SurfaceStore();
  const last: Record<string, unknown> = {};
  const results: Record<string, Record<string, unknown>[]> = {};
  const seen: Record<string, Set<string>> = {};
  const routes = Object.entries(m.routes).filter(([, r]) => r.extract && r.from);
  const ds = (name: string) => m.routes[name].dataset ?? name;
  for (const [name] of routes) { results[ds(name)] = []; seen[ds(name)] = new Set(); }
  const keyOf = (r: RouteSpec, it: Record<string, unknown>) => (r.key ? String(r.key.split(".").reduce((o: any, k) => o?.[k], it)) : JSON.stringify(it));
  const push = (rname: string, r: RouteSpec, rec?: Record<string, unknown>) => {
    if (!rec) return;
    const name = ds(rname);
    const k = keyOf(r, rec);
    if (seen[name].has(k)) return;
    seen[name].add(k);
    results[name].push(rec);
  };
  const close = async (surfaceId: string) => {
    const s = store.surfaces.get(surfaceId);
    const view = viewOfSurface(surfaceId);
    if (!s || !m.views[view]) return;
    for (const [name, r] of routes) {
      if (r.from!.view !== view) continue;
      if ((r.from!.on ?? "close") === "close") push(name, r, await evalRoute(r, s.dataModel, last, view));
      // per-item routes read the surface's final (consistent) state — the same state the live runtime emits from
      else for (const it of await evalItems(r, s.dataModel, last, view)) push(name, r, await evalRoute(r, s.dataModel, last, view, it));
    }
  };
  for (const raw of messages) {
    if (!("version" in raw) || "action" in raw) continue; // client→server messages are interleaved in recordings
    const msg = raw as ServerMessage;
    if ("deleteSurface" in msg) { await close(msg.deleteSurface.surfaceId); store.apply(msg); continue; }
    store.apply(msg);
    const sid = "createSurface" in msg ? msg.createSurface.surfaceId : "updateDataModel" in msg ? msg.updateDataModel.surfaceId : undefined;
    if (!sid) continue;
    const view = viewOfSurface(sid);
    const s = store.surfaces.get(sid);
    if (s && view === "control") last.control = structuredClone(s.dataModel); // run inputs published by the runtime
    if (!s || !m.views[view]) continue;
    last[view] = structuredClone(s.dataModel);
  }
  for (const sid of [...store.surfaces.keys()]) await close(sid); // stream ended with surfaces open
  return results;
}
