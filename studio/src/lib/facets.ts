/**
 * Facets: the shared vocabulary between the page, the schema/manifest code and the A2UI mirror.
 *
 * A facet is a model pointer of a view ("/author/nickname", "/videos", "/videos/[*]", "/videos/[*]/playCount")
 * or a dataset schema field ("tiktok.video" → "playCount"). One colour per facet, everywhere:
 *   - family hue  = the top-level group/list ("/author", "/videos") or schema route ("tiktok.video")
 *   - leaf shade  = the field name, hashed to a hue offset within ±70° of the family hue
 * Schema fields and manifest fields with the same leaf name share a colour — the agent is told to
 * reuse field names, so `playCount` reads the same in the schema, the manifest, the page and the mirror.
 */

export type FacetKind = "field" | "group" | "list" | "item" | "net";
export interface Facet {
  path: string;
  kind: FacetKind;
  parent: string | null;
  depth: number;
  /** viewport rects [x, y, w, h] (CSS px of the page viewport) of visible instances */
  rects: number[][];
  /** short extracted value per rect (null for containers) */
  values: (string | null)[];
  /** list item index per rect (for list fields / items) */
  idx?: number[];
  /** list length (lists only) */
  count?: number;
  /** net source URL regex (net facets have no rects) */
  net?: string;
}
export interface FacetSnapshot {
  view: string | null;
  url: string;
  viewport: [number, number];
  scroll: [number, number];
  docHeight: number;
  facets: Facet[];
  /** resolved against a streamed draft (not the written manifest) */
  draft?: boolean;
}
export interface TimelineMark { t: number; kind: "record" | "state" | "fault"; label: string; route?: string; key?: unknown }
/** A buffered scene (agent/UI action or manifest run). GET /session/scenes[/:id], frames at /session/scenes/:id/frame/:i. */
export interface SceneSummary { id: string; label: string; kind: "action" | "run"; t0: number; done: boolean; duration: number; frames: number; marks: TimelineMark[] }

// ---------------------------------------------------------------- keys

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** "/videos/*\/playCount" → { family: "videos", leaf: "playCount" }; "/author" → { family: "author", leaf: null } */
export function facetKey(path: string): { family: string; leaf: string | null } {
  const parts = path.replace(/^\//, "").split("/").filter((p) => p && p !== "*");
  if (parts.length <= 1) return { family: parts[0] ?? path, leaf: null };
  return { family: parts[0], leaf: parts[parts.length - 1] };
}

/** Schema route "tiktok.video" + field "playCount" → same key space as manifest facets. */
export function schemaKey(route: string, field?: string): { family: string; leaf: string | null } {
  return { family: route.split(".").pop() ?? route, leaf: field ?? null };
}

// ---------------------------------------------------------------- colours

/** Family names that denote the same thing (schema route "video" ~ manifest list "videos"). */
const singular = (s: string) => s.toLowerCase().replace(/(ies)$/, "y").replace(/s$/, "");

export interface FacetColor { hue: number; solid: string; fg: string; tint: string; wash: string; border: string }

/** Flat, muted palette (no gradients/glows): one colour per facet, hairline-friendly. */
const PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4",
  "#ec4899", "#84cc16", "#f97316", "#6366f1", "#14b8a6", "#a855f7",
];
const hex = (c: string, a: number) => `${c}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
function make(i: number): FacetColor {
  const c = PALETTE[i % PALETTE.length];
  return { hue: i, solid: c, fg: "#ffffff", tint: hex(c, 0.06), wash: hex(c, 0.16), border: c };
}

export function familyHue(family: string): number {
  return hash(singular(family)) % PALETTE.length;
}

/** Containers get the family colour; each leaf field its own flat colour (stable by name). */
export function colorOf(k: { family: string; leaf: string | null }): FacetColor {
  if (!k.leaf) return make(familyHue(k.family));
  return make(hash(k.leaf.toLowerCase()) % PALETTE.length);
}

export const colorOfPath = (path: string) => colorOf(facetKey(path));
export const colorOfSchema = (route: string, field?: string) => colorOf(schemaKey(route, field));

// ---------------------------------------------------------------- manifest/schema helpers

/** JSON path (array of keys) inside a manifest → the facet path it describes, if any.
 *  ["views","profile","model","/videos","fields","playCount"] → "/videos/*\/playCount" (given lists ∋ "/videos")
 *  ["views","profile","components",3] → resolved by the caller via component bindings. */
export function facetOfManifestPath(keys: (string | number)[], lists: Set<string>): string | null {
  if (keys[0] !== "views" || keys[2] !== "model" || typeof keys[3] !== "string") return null;
  let path = keys[3];
  for (let i = 4; i < keys.length; i++) {
    const k = keys[i];
    if (k === "fields") { if (lists.has(path)) path += "/*"; continue; }
    if (typeof k !== "string" || ["sel", "get", "re", "as", "all", "default", "scope", "key", "limit", "net", "each"].includes(k)) break;
    path += "/" + k;
  }
  return path;
}

/** Pre-compute: which model keys are lists (so "/videos" fields map under "/videos/*"). */
export function listPointers(model: Record<string, any> | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (spec: any, path: string) => {
    if (!spec || typeof spec !== "object") return;
    if (spec.each) { out.add(path); for (const [k, f] of Object.entries(spec.fields ?? {})) walk(f, `${path}/*/${k}`); }
    else if (spec.fields) for (const [k, f] of Object.entries(spec.fields)) walk(f, `${path}/${k}`);
  };
  for (const [ptr, spec] of Object.entries(model ?? {})) walk(spec, ptr);
  return out;
}

/** A2UI component → the model pointer it binds (text/url/value {path}), for colouring components. */
export function componentBinding(c: any): string | null {
  for (const k of ["text", "url", "value", "label", "items", "data"]) {
    const v = c?.[k];
    if (v && typeof v === "object" && typeof v.path === "string") return v.path;
  }
  return null;
}

/** Map a raw bound path (possibly relative in a template, e.g. "playCount" under "/videos") to a facet path. */
export function normaliseBinding(path: string, templateBase?: string): string {
  if (path.startsWith("/")) return path;
  return `${templateBase ?? ""}/*/${path}`;
}
