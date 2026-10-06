/**
 * Everything returned to the model goes through here: no base64 / data-URL payloads, no giant
 * strings or arrays, no fingerprint token vectors. The model gets the *shape* and a size note;
 * the UI and disk keep the real bytes.
 */
const DATA_URL = /^data:([\w/+.-]+)(;[\w=-]+)*;base64,/i;
const BASE64ISH = /^[A-Za-z0-9+/_-]{160,}={0,2}$/;
const HEXISH = /^[0-9a-f]{128,}$/i;

const kb = (n: number) => (n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

export interface SanitizeOptions { maxString?: number; maxArray?: number; maxDepth?: number; dropKeys?: string[] }

export function sanitize(v: unknown, o: SanitizeOptions = {}, depth = 0): unknown {
  const maxString = o.maxString ?? 600, maxArray = o.maxArray ?? 25, maxDepth = o.maxDepth ?? 12;
  if (typeof v === "string") {
    const m = DATA_URL.exec(v);
    if (m) return `<${m[1]} data URL, ${kb(v.length * 0.75)} omitted>`;
    // encoded payloads mix upper/lower case and digits; plain long words/prose don't
    if ((BASE64ISH.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) || HEXISH.test(v)) return `<encoded blob, ${v.length} chars omitted>`;
    return v.length > maxString ? `${v.slice(0, maxString)}… <+${v.length - maxString} chars>` : v;
  }
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => typeof x === "string") && v.length > 60) return `<${v.length} strings, e.g. ${JSON.stringify(v.slice(0, 3))}>`;
    const head = v.slice(0, maxArray).map((x) => sanitize(x, o, depth + 1));
    return v.length > maxArray ? [...head, `<+${v.length - maxArray} more items>`] : head;
  }
  if (v && typeof v === "object") {
    if (depth >= maxDepth) return "<…>";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if ((o.dropKeys ?? DEFAULT_DROP).includes(k)) { out[k] = "<omitted>"; continue; }
      out[k] = sanitize(x, o, depth + 1);
    }
    return out;
  }
  return v;
}

/** Keys that are machine evidence, never useful to the model verbatim. */
export const DEFAULT_DROP = ["fingerprint", "screenshot", "dataUrl", "frame"];

/** Sanitised JSON text, hard-capped. */
export function forModel(v: unknown, cap = 24_000, o?: SanitizeOptions): string {
  const s = typeof v === "string" ? (sanitize(v, { maxString: cap, ...o }) as string) : JSON.stringify(sanitize(v, o), null, 1);
  return s.length > cap ? `${s.slice(0, cap)}\n… <truncated ${s.length - cap} chars>` : s;
}

/**
 * What the model needs from a JSON payload to design a `net` pointer — not the payload itself:
 * where the record list lives, how many records, each field's type + one short example (nested
 * objects flattened to dotted paths), and paging hints (cursor / hasMore / total-like keys).
 */
export function digestJson(json: unknown, o: { maxFields?: number; example?: number } = {}): string {
  const maxFields = o.maxFields ?? 40, ex = o.example ?? 40;
  const lists: { path: string; arr: unknown[] }[] = [];
  const findLists = (v: unknown, path: string, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      if (v.length && v.some((x) => x && typeof x === "object" && !Array.isArray(x))) lists.push({ path: path || "$", arr: v });
      return;
    }
    for (const [k, x] of Object.entries(v)) findLists(x, path ? `${path}.${k}` : k, depth + 1);
  };
  findLists(json, "", 0);
  lists.sort((a, b) => b.arr.length - a.arr.length);
  const short = (v: unknown) => {
    const s = typeof v === "string" ? sanitize(v, { maxString: ex }) as string : JSON.stringify(v);
    return s.length > ex ? `${s.slice(0, ex)}…` : s;
  };
  const fieldsOf = (arr: unknown[]) => {
    const seen = new Map<string, string>();
    const walk = (v: unknown, path: string, depth: number) => {
      if (seen.size >= maxFields) return;
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1); return; }
      if (seen.has(path)) return;
      const t = Array.isArray(v) ? `array[${v.length}]${v.length && typeof v[0] === "object" ? " of objects" : ""}` : v === null ? "null" : typeof v;
      seen.set(path, `${t}${Array.isArray(v) || v === null ? "" : ` = ${short(v)}`}`);
    };
    for (const it of arr.slice(0, 3)) walk(it, "", 0);
    return [...seen].map(([k, d]) => `    ${k}: ${d}`).join("\n");
  };
  const top = json && typeof json === "object" && !Array.isArray(json)
    ? Object.entries(json).filter(([k, v]) => /cursor|hasmore|has_more|next|offset|total|page|count/i.test(k) && (v == null || typeof v !== "object")).map(([k, v]) => `${k}=${short(v)}`)
    : [];
  const out: string[] = [];
  if (!lists.length) out.push(`  (no record list) keys: ${json && typeof json === "object" ? Object.keys(json).slice(0, 20).join(", ") : typeof json}`);
  for (const l of lists.slice(0, 2)) out.push(`  records at \`${l.path}\` (${l.arr.length})\n${fieldsOf(l.arr)}`);
  if (top.length) out.push(`  paging: ${top.join(", ")}`);
  return out.join("\n");
}
