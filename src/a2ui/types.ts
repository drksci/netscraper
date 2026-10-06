/**
 * A2UI v0.9 protocol types (server→client envelope, client→server action).
 * Mirrors specification/v0_9/json/{server_to_client,client_to_server,common_types}.json.
 */

export const A2UI_VERSION = "v0.9" as const;
export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** `{path}` data binding; relative paths resolve against the current template scope. */
export interface DataBinding { path: string }
export interface FunctionCall { call: string; args?: Record<string, unknown>; returnType?: string }
export type Dynamic<T> = T | DataBinding | FunctionCall;

export type ChildList = string[] | { componentId: string; path: string };

export interface EventAction { event: { name: string; context?: Record<string, Dynamic<JsonValue>> } }
export interface FunctionAction { functionCall: FunctionCall }
export type Action = EventAction | FunctionAction;

/** A component in the flat adjacency list. Catalog props sit alongside id/component. */
export interface Component {
  id: string;
  component: string;
  [prop: string]: unknown;
}

export interface CreateSurface {
  version: typeof A2UI_VERSION;
  createSurface: { surfaceId: string; catalogId: string; theme?: Record<string, unknown>; sendDataModel?: boolean };
}
export interface UpdateComponents {
  version: typeof A2UI_VERSION;
  updateComponents: { surfaceId: string; components: Component[] };
}
export interface UpdateDataModel {
  version: typeof A2UI_VERSION;
  updateDataModel: { surfaceId: string; path?: string; value?: unknown };
}
export interface DeleteSurface {
  version: typeof A2UI_VERSION;
  deleteSurface: { surfaceId: string };
}
export type ServerMessage = CreateSurface | UpdateComponents | UpdateDataModel | DeleteSurface;

/** Client→server user action (client_to_server.json). */
export interface ClientAction {
  version: typeof A2UI_VERSION;
  action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: Record<string, unknown>;
  };
}

export const msg = {
  createSurface: (surfaceId: string, catalogId = BASIC_CATALOG_ID, theme?: Record<string, unknown>): CreateSurface => ({
    version: A2UI_VERSION,
    createSurface: { surfaceId, catalogId, ...(theme ? { theme } : {}) },
  }),
  updateComponents: (surfaceId: string, components: Component[]): UpdateComponents => ({
    version: A2UI_VERSION,
    updateComponents: { surfaceId, components },
  }),
  updateDataModel: (surfaceId: string, path: string, value: unknown): UpdateDataModel => ({
    version: A2UI_VERSION,
    updateDataModel: value === undefined ? { surfaceId, path } : { surfaceId, path, value },
  }),
  deleteSurface: (surfaceId: string): DeleteSurface => ({ version: A2UI_VERSION, deleteSurface: { surfaceId } }),
};

export function isBinding(v: unknown): v is DataBinding {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as DataBinding).path === "string"
    && Object.keys(v as object).length === 1;
}
