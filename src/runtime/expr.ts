/** Tiny, side-effect-free templating + condition language used by flow steps. */
import type { Cond, Operand } from "../manifest/types.js";
import { getAt } from "../a2ui/pointer.js";

export type Scope = Record<string, unknown>;

const FILTERS: Record<string, (v: any) => unknown> = {
  url: (v) => encodeURIComponent(String(v ?? "")),
  lower: (v) => String(v ?? "").toLowerCase(),
  trimAt: (v) => String(v ?? "").replace(/^@/, ""),
  int: (v) => parseInt(String(v), 10),
  json: (v) => JSON.stringify(v),
  csv: (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean),
  len: (v) => (Array.isArray(v) || typeof v === "string" ? v.length : 0),
};

export function lookup(expr: string, scope: Scope): unknown {
  const [path, ...filters] = expr.split("|").map((s) => s.trim());
  let v: any = path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), scope);
  for (const f of filters) {
    if (!FILTERS[f]) throw new Error(`unknown filter ${f}`);
    v = FILTERS[f](v);
  }
  return v;
}

/** "{{ a.b }}" alone → raw value; otherwise string interpolation. */
export function tmpl(s: string, scope: Scope): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(s);
  if (whole) return lookup(whole[1], scope);
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => {
    const v = lookup(e, scope);
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export interface CondCtx { model: unknown; scope: Scope; view: string | null; stalled: number }

function operand(o: Operand, c: CondCtx): unknown {
  if (typeof o === "object" && o && "count" in o) {
    const v = getAt(c.model, o.count);
    return Array.isArray(v) ? v.length : 0;
  }
  if (typeof o === "string") {
    if (o.startsWith("/")) return getAt(c.model, o);
    const v = tmpl(o, c.scope);
    return typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : v;
  }
  return o;
}

export function evalCond(cond: Cond, c: CondCtx): boolean {
  if ("gte" in cond) return Number(operand(cond.gte[0], c)) >= Number(operand(cond.gte[1], c));
  if ("lt" in cond) return Number(operand(cond.lt[0], c)) < Number(operand(cond.lt[1], c));
  if ("eq" in cond) return String(operand(cond.eq[0], c)) === String(operand(cond.eq[1], c));
  if ("not" in cond) return !evalCond(cond.not, c);
  if ("and" in cond) return cond.and.every((x) => evalCond(x, c));
  if ("or" in cond) return cond.or.some((x) => evalCond(x, c));
  if ("exists" in cond) { const v = getAt(c.model, cond.exists); return v != null && v !== ""; }
  if ("stalled" in cond) return c.stalled >= cond.stalled;
  if ("view" in cond) return c.view === cond.view;
  if ("empty" in cond) { const v = tmpl(cond.empty, c.scope); return v == null || (Array.isArray(v) ? !v.length : v === ""); }
  throw new Error(`bad condition ${JSON.stringify(cond)}`);
}
