/**
 * Terse one-line rendering of actor log lines for a ~50-column console: a 2-char glyph gutter, a short verb,
 * the object; ids shortened (7691…2872), URLs to host+path. Unknown shapes fall back to a stripped generic line.
 */
import type { ActorLine } from "./session-store";

export type Tone = "dim" | "text" | "accent" | "ok" | "warn" | "fault" | "info";
export interface LogRow { key: number; glyph: string; text: string; full: string; tone: Tone; count: number }

const shortId = (s: string) => s.replace(/\b(\d{4})\d{6,}(\d{4})\b/g, "$1…$2");
const shortUrl = (s: string) => s.replace(/https?:\/\/(www\.)?([^\s/]+)(\/[^\s?#]*)?[^\s]*/g, (_, _w, host, path) => `${host.replace(/\.(com|net|org|io)$/, ".$1")}${path && path !== "/" ? path.replace(/\/$/, "") : ""}`);
const secs = (ms: string) => { const n = Number(ms); return n >= 1000 ? `${Math.round(n / 1000)}s` : `${n}ms`; };
const tidy = (s: string) => shortId(shortUrl(s)).replace(/\s+/g, " ").trim();

type Rule = [RegExp, (m: RegExpExecArray) => [string, string, Tone]];
const RULES: Rule[] = [
  [/^▶\s*(\S+)/, (m) => ["▶", `start ${m[1].replace(/\.a2flow\.json$/, "")}`, "text"]],
  [/^■\s*(?:exited|stopped)\s*(-?\d+)?/, (m) => ["■", m[1] ? `exit ${m[1]}` : "stopped", m[1] && m[1] !== "0" ? "fault" : "dim"]],
  [/engine:?\s*(quickjs|worker)\D*(\d+\s*ms)?/i, (m) => ["◆", `${m[1].toLowerCase() === "quickjs" ? "quickjs·wasm" : "worker·js"}${m[2] ? `  ${m[2].replace(/\s/g, "")}` : ""}`, "accent"]],
  [/^state\s+(.+)$/, (m) => ["→", m[1], "dim"]],
  [/^navigate\s+(\S+)/, (m) => ["▸", `nav  ${tidy(m[1])}`, "text"]],
  [/await attempt (\d+)\/(\d+) failed \[(\w+)\][^\d]*(\d+)ms/, (m) => ["⏳", `await  ${m[3]} ${secs(m[4])}  (${m[1]}/${m[2]})`, "warn"]],
  [/await attempt (\d+)\/(\d+) failed \[(\w+)\]/, (m) => ["⏳", `await  ${m[3]}  (${m[1]}/${m[2]})`, "warn"]],
  [/^recover:\s*(\w+)\s*(\S+)?/, (m) => ["↻", `${m[1]}${m[2] ? `  ${tidy(m[2]).split("/").filter(Boolean).pop() ?? ""}` : ""}`, "warn"]],
  [/action attempt (\d+)\/(\d+) failed \[(\w+)\]:?\s*(?:component\s+)?(\w+)?/, (m) => ["!", `${m[4] ?? "action"}  ${m[3]}  (${m[1]}/${m[2]})`, "warn"]],
  [/(?:warn:\s*)?([\w.]+) item (\S+) fails schema:?\s*(?:data\/)?([\w/]+) must be (\w+)/, (m) => ["!", `schema  ${m[3].split("/").pop()}≠${m[4]}  ${shortId(m[2])}`, "warn"]],
  [/^done in ([\d.]+)s:?\s*(.*)$/, (m) => {
    const counts = [...m[2].matchAll(/([\w.]+)=(\d+)/g)].map(([, r, n]) => `${n} ${(r.split(".").pop() ?? r)}${n === "1" ? "" : "s"}`).join(" ");
    return ["✓", `done  ${counts || "0 items"}  ${m[1]}s`, "ok"];
  }],
  [/^unit\s+(\S+?):(\S+)\s+(\w+)(?:\s*\((.*)\))?/, (m) => ["·", `unit ${m[1]} ${shortId(m[2])} ${m[3]}${m[4] ? `  ${m[4].slice(0, 24)}` : ""}`, m[3] === "failed" ? "fault" : m[3] === "skipped" ? "warn" : "info"]],
  [/interrupt[:\s]+(\w+)\s*(present|gone|dismiss\w*)?/i, (m) => ["⚑", `interrupt ${m[1]}${m[2] ? ` → ${m[2].toLowerCase().startsWith("gone") ? "gone" : m[2].toLowerCase()}` : ""}`, "warn"]],
  [/^fault\s+(\S+?):?\s+(.*)$/, (m) => ["!", `fault ${m[1]}  ${tidy(m[2]).slice(0, 30)}`, "fault"]],
];

export function formatLine(l: ActorLine): Omit<LogRow, "key" | "count"> {
  const raw = l.line;
  const body = raw.replace(/^\s*[·!+]\s*/, "").replace(/^\s+/, "").replace(/^(log|info|warn):\s*/i, (p) => (/warn/i.test(p) ? "warn: " : ""));
  for (const [re, f] of RULES) {
    const m = re.exec(body);
    if (m) { const [glyph, text, tone] = f(m); return { glyph, text, full: raw, tone: l.kind === "fault" ? "fault" : tone }; }
  }
  const tone: Tone = l.kind === "fault" ? "fault" : l.kind === "done" ? "ok" : l.kind === "unit" ? "info" : /^warn/i.test(body) ? "warn" : "dim";
  const glyph = l.kind === "fault" ? "!" : l.kind === "done" ? "✓" : l.kind === "unit" ? "·" : /^warn/i.test(body) ? "!" : "·";
  return { glyph, text: tidy(body.replace(/^warn:\s*/i, "")), full: raw, tone };
}

/** Format and fold consecutive repeats into one row with ×N. */
export function formatLog(lines: ActorLine[], max = 400): LogRow[] {
  const out: LogRow[] = [];
  for (const l of lines.slice(-max * 2)) {
    if (/^\s*state\s/.test(l.line)) continue; // states go to the machine strip
    const f = formatLine(l);
    const prev = out[out.length - 1];
    if (prev && prev.text === f.text && prev.glyph === f.glyph) { prev.count++; prev.key = l.n; continue; }
    out.push({ key: l.n, count: 1, ...f });
  }
  return out.slice(-max);
}

/** State path from "state X" lines: visited set, re-entry counts, current state. */
export function statePath(lines: ActorLine[]) {
  const counts = new Map<string, number>();
  let current: string | null = null;
  for (const l of lines) {
    const m = /^\s*state\s+(.+)$/.exec(l.line);
    if (!m) continue;
    const s = m[1].trim().replace(/^"|"$/g, "");
    const leaf = s.startsWith("{") ? (s.match(/"(\w+)"\s*}*$/)?.[1] ?? s) : s.split(".").pop()!;
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
    current = leaf;
  }
  return { counts, current };
}
