/**
 * Parity between what the agent *saw* (expected records, read off the page like a human would)
 * and what the manifest/runtime *produced*. Field-level, tolerant of presentation differences:
 * "38.2K" ≈ 38224, whitespace/case, "#fyp" ≈ "fyp", nested objects flattened to dot paths.
 */
import { parseCount } from "../harness/perceive.js";

export interface ExpectedRecord { route: string; record: Record<string, unknown> }
export interface FieldMismatch { route: string; key: string; field: string; expected: unknown; got: unknown }
export interface ParityReport {
  score: number;            // matched fields / expected fields (over matched records)
  coverage: number;         // expected records found in output
  expected: number; found: number;
  mismatches: FieldMismatch[];
  missing: ExpectedRecord[];
}

const flat = (o: unknown, pre = "", out: Record<string, unknown> = {}): Record<string, unknown> => {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flat(v, pre ? `${pre}.${k}` : k, out);
  else if (Array.isArray(o)) out[pre] = o.map((x) => (x && typeof x === "object" ? Object.values(x).join(" ") : x)).join(" ");
  else out[pre] = o;
  return out;
};
const normStr = (s: unknown) => String(s ?? "").toLowerCase().replace(/[#@]/g, "").replace(/\s+/g, " ").trim();

export function valuesMatch(expected: unknown, got: unknown): boolean {
  if (expected == null || expected === "") return true; // agent couldn't see it — not a requirement
  if (got == null) return false;
  const e = typeof expected === "number" ? expected : parseCount(String(expected));
  const g = typeof got === "number" ? got : parseCount(String(got));
  if (e != null && g != null && /^[\d.,\sKMB]+$/i.test(String(expected))) {
    // abbreviated display ("38.2K") vs exact (38224): within the display's precision
    const tol = Math.max(1, Math.abs(e) * (/[KMB]/i.test(String(expected)) ? 0.051 : 0.001));
    return Math.abs(e - g) <= tol;
  }
  const a = normStr(expected), b = normStr(got);
  return a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
}

/** An identifying field to pair on when the route declares no key: id, *Id, webVideoUrl/url. */
const ID_FIELDS = ["id", "videoId", "itemId", "webVideoUrl", "url"];
const idOf = (ef: Record<string, unknown>, key?: string) => (key && ef[key] != null ? key : ID_FIELDS.find((f) => ef[f] != null && ef[f] !== ""));

/**
 * Pair expected → produced one-to-one: by the route key (or an id-like field) when present, else by the
 * best field overlap (≥ half the expected fields). A produced record is never claimed twice.
 */
export function parity(expected: ExpectedRecord[], produced: Record<string, Record<string, unknown>[]>, keys: Record<string, string | undefined> = {}): ParityReport {
  const mismatches: FieldMismatch[] = [], missing: ExpectedRecord[] = [];
  const used = new Set<Record<string, unknown>>();
  let fields = 0, ok = 0, found = 0;
  for (const ex of expected) {
    const pool = (produced[ex.route] ?? []).filter((p) => !used.has(p));
    const ef = flat(ex.record);
    const key = idOf(ef, keys[ex.route]);
    let best: Record<string, unknown> | undefined;
    if (key) best = pool.find((p) => String(flat(p)[key] ?? "") === String(ef[key]));
    else {
      const need = Object.values(ef).filter((v) => v != null && v !== "").length;
      let bestScore = 0;
      for (const p of pool) {
        const pf = flat(p);
        const s = Object.entries(ef).filter(([k, v]) => v != null && v !== "" && valuesMatch(v, pf[k])).length;
        if (s > bestScore) { bestScore = s; best = p; }
      }
      if (bestScore < Math.max(1, need / 2)) best = undefined;
    }
    if (!best) { missing.push(ex); continue; }
    used.add(best);
    found++;
    const pf = flat(best);
    for (const [f, v] of Object.entries(ef)) {
      if (v == null || v === "") continue;
      fields++;
      if (valuesMatch(v, pf[f])) ok++;
      else mismatches.push({ route: ex.route, key: String(key ? pf[key] : "?"), field: f, expected: v, got: pf[f] });
    }
  }
  return { score: fields ? ok / fields : found ? 1 : 0, coverage: expected.length ? found / expected.length : 0, expected: expected.length, found, mismatches, missing };
}
