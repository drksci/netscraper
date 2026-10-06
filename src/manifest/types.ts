/**
 * a2flow manifest: one JSON file that fully describes a flow —
 *   routes  (output unit types)  ←  views (A2UI surface + DOM projection + action map)  ←  flow (A2UI-level steps)
 * A runtime needs only this file + any BrowserAdapter to execute it.
 */
import type { Component } from "../a2ui/types.js";

export type JSONSchema = Record<string, unknown>;

/** DOM → JSON projection. `sel` is relative to the enclosing scope / list item. */
export interface FieldExtractor {
  sel?: string;
  /** text | src | bg | html | canvas | attr:<name> | prop:<name> | json:<pointer> */
  get?: string;
  /** Regex applied to the raw value; capture group 1 wins. */
  re?: string;
  as?: "string" | "int" | "float" | "count" | "bool" | "url" | "seconds";
  all?: boolean;
  default?: unknown;
}
export interface ObjectExtractor { scope?: string; fields: Record<string, Extractor> }
export interface ListExtractor { each: string; key?: string; limit?: number; fields: Record<string, Extractor> }
/**
 * Network source: the page's OWN responses (passively observed via CDP — never replayed/forged),
 * selected with JSONata. `append` accumulates items across responses (infinite scroll), deduped by key.
 * Reset when a new document loads.
 */
export interface NetSource {
  /** Regex on the response URL; embedded JSON scripts appear as "inline:<script id>". */
  url: string;
  /** Optional HTTP method filter (GET, POST…). */
  method?: string;
  /** Optional JSONata predicate over the parsed body — match by content, not just URL (e.g. GraphQL operations). */
  when?: string;
  /** JSONata transform of the body into the value at this pointer. */
  select: string;
  key?: string;
  mode?: "append" | "replace";
}
/** One source, or several feeding the same pointer (e.g. "inline:<script id>" for page one + the XHR for later pages). */
export interface NetExtractor { net: NetSource | NetSource[] }
export type Extractor = FieldExtractor | ObjectExtractor | ListExtractor | NetExtractor;

/** Where an A2UI component lives on the real page: a model pointer (preferred) or a raw selector. */
export type Anchor = { model: string; sel_within?: string } | { sel: string };

/** How an A2UI event action (by name) is realised on the page. */
export interface ActionMap {
  op: "click" | "scroll" | "type" | "press" | "back" | "navigate";
  /** Component id whose anchor is the target. */
  anchor?: string;
  /** Context key whose value identifies the list item (matched against the list's `key` field). */
  key?: string;
  /** scroll: "page" (one viewport) | "end" | pixels */
  by?: "page" | "end" | number;
  url?: string;
  text?: string;
  /** If the target isn't present, dispatch this action first (e.g. loadMore) up to `revealMax` times. */
  reveal?: string;
  revealMax?: number;
  /** Natural-language intent — what the multimodal lane is asked to do instead of using selectors. */
  intent: string;
}

export interface ViewSpec {
  title?: string;
  /** First matching view wins (declaration order): path regex, required selector, forbidden selector, body-text regex. */
  match: { path?: string; selector?: string; absent?: string; text?: string };
  /** Outcome views (not found, private, unavailable…) are terminal states for a unit, not page data. */
  outcome?: boolean;
  /**
   * Interrupt views (login modal, cookie banner, captcha, "are you still there"): matched independently of
   * the page view and projected as their own A2UI surface layered over it. When one appears the runner sends
   * the machine an `INTERRUPT` event ({ view }); the machine's root handler dismisses it (an action such as
   * `dismiss`), pauses, or fails — then resumes via a history state. Without a root handler, policies.dismiss applies.
   */
  interrupt?: boolean;
  /** domhash fingerprint captured at derive time (structure-only), for drift detection. */
  fingerprint?: { simhash: string; shape: string[]; ax?: string[]; minSimilarity?: number };
  /** A2UI v0.9 adjacency list (basic catalog). Data bindings point into `model`. */
  components: Component[];
  model: Record<string, Extractor>;
  anchors: Record<string, Anchor>;
  actions: Record<string, ActionMap>;
  settle?: { quietMs?: number; timeoutMs?: number };
}

export interface RouteSpec {
  description?: string;
  /** JSON Schema of one emitted item (the "output data unit type"). */
  schema: JSONSchema;
  /** Field in the emitted item that identifies it (dedupe). */
  key?: string;
  /** v0.1: output key (dot paths build nested objects) → "/pointer" | "{{ expr }}"; "a || b" falls back. */
  map?: Record<string, string>;
  /** Dataset (output file / dedupe namespace) this route writes to; defaults to the route name. Lets a fast route and a fallback route fill one dataset. */
  dataset?: string;
  /** v0.2: which A2UI surface yields records, and when ("close" = its final state; "item" = each new list item). */
  from?: { view: string; on?: "close" | "item"; each?: string };
  /** v0.2: JSONata over the surface's data model; bindings $model, $surfaces.<view>, $item, $view. */
  extract?: string;
}

export type Operand = number | string | boolean | { count: string };
export type Cond =
  | { gte: [Operand, Operand] } | { lt: [Operand, Operand] } | { eq: [Operand, Operand] }
  | { not: Cond } | { and: Cond[] } | { or: Cond[] }
  | { exists: string } | { stalled: number } | { view: string } | { empty: string };

export type Step =
  | { navigate: string }
  | { await: { view: string; until?: Cond; timeoutMs?: number } }
  | { action: string; on: string; item?: number | string | Record<string, string> }
  | { input: string; value: string }
  | { emit: string; scope?: string }
  | { repeat: { until: Cond; max?: number; do: Step[] } }
  | { forEach: { in: string; as: string; limit?: number | string; do: Step[] } }
  | { set: Record<string, string> }
  | { log: string };

/**
 * The user-facing control surface (v0.2): an A2UI form whose inputs write to its local data model
 * (A2UI write contract) and whose Button `event`s — with `{path}`-bound context — become machine events.
 */
export interface ControlSurface {
  components: Component[];
  dataModel?: Record<string, unknown>;
}

/**
 * XState v5 machine *config* as plain JSON. Actions/guards are `{ type, params }`, invoked actors
 * `{ src, input }`; implementations come from the runtime library (src/machine/library.ts).
 * Strings in params/input are templates over `{ ...context, context, event, target }`;
 * `{ "$model": "/ptr" }` reads the current A2UI data model, `{ "$count": "/ptr" }` its array length.
 */
export type MachineConfig = Record<string, unknown> & { id: string; initial: string; states: Record<string, unknown> };

export interface FlowManifest {
  $schema?: string;
  a2flow: "0.1" | "0.2";
  id: string;
  title?: string;
  description?: string;
  a2ui: { version: "v0.9"; catalogId: string; theme?: Record<string, unknown> };
  target: {
    baseUrl: string;
    viewport?: { width: number; height: number };
    browser?: { humanize?: boolean; headless?: boolean; locale?: string; timezone?: string };
  };
  inputs: JSONSchema;
  routes: Record<string, RouteSpec>;
  views: Record<string, ViewSpec>;
  /** v0.1 linear plan. */
  flow?: Step[];
  /** v0.2: user input as A2UI + XState machine over the projected views. */
  control?: ControlSurface;
  /** v0.2 fault-tolerance policies (see src/machine/policy.ts). */
  policies?: import("../machine/policy.js").Policies;
  machine?: MachineConfig;
  provenance?: Record<string, unknown>;
}
