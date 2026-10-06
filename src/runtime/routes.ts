/** Route emission shared by both runtimes: map the A2UI data model + scope into a typed record. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FlowManifest } from "../manifest/types.js";
import { getAt } from "../a2ui/pointer.js";
import { tmpl, type Scope } from "./expr.js";
import { evalItems, evalRoute } from "./extract.js";

export interface Emitted { route: string; item: Record<string, unknown>; duplicate: boolean; warning?: string }

export class RouteSink {
  readonly results: Record<string, Record<string, unknown>[]> = {};
  private seen: Record<string, Set<string>> = {};
  private ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

  /** With `dir`, each route is an append-only `<dir>/<route>.jsonl`; keys already there are never re-emitted (idempotent reruns). */
  constructor(private manifest: FlowManifest, private dir?: string) {
    if (dir) mkdirSync(dir, { recursive: true });
    for (const [rname, r] of Object.entries(manifest.routes)) {
      const name = r.dataset ?? rname;
      if (this.results[name]) continue;
      this.results[name] = []; this.seen[name] = new Set();
      const f = dir && join(dir, `${name}.jsonl`);
      if (f && existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const it = JSON.parse(line); this.seen[name].add(this.keyOf(r.key, it)); } catch { /* torn line */ }
      }
    }
  }
  private keyOf(key: string | undefined, item: unknown) { return key ? String(getAt(item, "/" + key.split(".").join("/"))) : JSON.stringify(item); }
  /** Keys already persisted from earlier runs. */
  persisted(route: string) { return this.seen[route]?.size ?? 0; }

  /** v0.2 JSONata routes: evaluate `extract` over A2UI state (same evaluator as `extractStream`). */
  async emitExtract(route: string, model: unknown, surfaces: Record<string, unknown>, view: string): Promise<Emitted> {
    const r = this.manifest.routes[route];
    if (!r) throw new Error(`unknown route ${route}`);
    const item = (await evalRoute(r, model, surfaces, view)) ?? {};
    return this.record(route, item);
  }

  /** v0.2 per-item routes (`from.on: "item"`): one record per item of `from.each`, deduped by key. */
  async emitItems(route: string, model: unknown, surfaces: Record<string, unknown>, view: string): Promise<Emitted[]> {
    const r = this.manifest.routes[route];
    if (!r) throw new Error(`unknown route ${route}`);
    const out: Emitted[] = [];
    for (const it of await evalItems(r, model, surfaces, view)) {
      const rec = await evalRoute(r, model, surfaces, view, it);
      if (rec) out.push(this.record(route, rec));
    }
    return out;
  }

  /** `map` values: "/pointer" into the model | "{{ expr }}" over scope | "a || b" fallbacks. */
  emit(route: string, model: unknown, scope: Scope): Emitted {
    const r = this.manifest.routes[route];
    if (!r) throw new Error(`unknown route ${route}`);
    const item: Record<string, unknown> = {};
    for (const [out, expr] of Object.entries(r.map ?? {})) {
      let v: unknown;
      for (const alt of expr.split("||").map((x) => x.trim())) {
        v = alt.startsWith("/") ? getAt(model, alt) : tmpl(alt, scope);
        if (v != null && v !== "") break;
      }
      if (v === undefined) continue;
      out.split(".").reduce((o: any, k, i, a) => (i === a.length - 1 ? (o[k] = v) : (o[k] ??= {})), item);
    }
    return this.record(route, item);
  }

  private record(rname: string, item: Record<string, unknown>): Emitted {
    const r = this.manifest.routes[rname];
    const route = r.dataset ?? rname;
    const key = this.keyOf(r.key, item);
    const duplicate = this.seen[route].has(key);
    let warning: string | undefined;
    if (!duplicate) {
      this.seen[route].add(key);
      if (!this.ajv.validate(r.schema, item)) warning = `${route} item ${key} fails schema: ${this.ajv.errorsText(this.ajv.errors)}`;
      this.results[route].push(item);
      if (this.dir) appendFileSync(join(this.dir, `${route}.jsonl`), JSON.stringify(item) + "\n");
    }
    return { route, item, duplicate, warning };
  }
}
