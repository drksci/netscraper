/** Small, consistent formatters for records, benchmarks and money. */

export const compactNum = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const shortId = (v: string) => (v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v);
export const ID_LIKE = /^[0-9a-f-]{12,}$|^\d{12,}$/i;

export const usd = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "—" : x === 0 ? "$0" : x < 0.01 ? `$${x.toPrecision(2)}` : x < 100 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString("en")}`;

export const bytes = (b: number) => (b < 1024 ? `${Math.round(b)} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export const ms = (x: number) => (x < 1 ? `${x.toFixed(2)} ms` : x < 1000 ? `${x.toFixed(x < 10 ? 1 : 0)} ms` : `${(x / 1000).toFixed(1)} s`);

export const clock = (msTotal: number) => {
  const s = Math.max(0, Math.floor(msTotal / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A record value, compacted for a table cell. */
export function cell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) >= 10000 ? compactNum(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") {
    if (ID_LIKE.test(v)) return shortId(v);
    if (/^https?:\/\//.test(v)) return v.replace(/^https?:\/\/(www\.)?/, "");
    return v;
  }
  if (Array.isArray(v)) return v.length === 0 ? "[]" : v.every((x) => typeof x !== "object") ? v.join(", ") : `[${v.length}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "nickName", "title", "uniqueId", "id"]) if (typeof o[k] === "string" && o[k]) return cell(o[k]);
    return `{${Object.keys(o).length}}`;
  }
  return String(v);
}
