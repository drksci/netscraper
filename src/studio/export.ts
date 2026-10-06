/**
 * Session export for publishing: a self-contained replay bundle (bundle.json + frames/*.jpg).
 *
 * Privacy: the recorded pages show other people's content, so frames are mosaicked (page imagery and text
 * unrecognisable, layout kept) and every creator-identifying string in records, facet values, A2UI data and
 * chat text is replaced by a stable placeholder. Numbers (counts, timings) are kept.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { StudioSession, Timeline } from "./session.js";

const SENSITIVE_KEY = /author|creator|user|name|nick|unique|handle|text|desc|caption|signature|title|url|cover|avatar|music|sound|hashtag|challenge|comment|bio|link|href|src|image|video(Url|Id)?$/i;
const SAFE_KEY = /count|stats|plays|likes|digg|share|collect|duration|width|height|time|at$|^t$|ms$|ratio|score|coverage|records|total|n$|^id$|key|route|kind|type|view|path|state|phase|status/i;

const short = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 5); };

/** Replace identifying strings, keep structure and numbers. */
export function redact(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    if (/^https?:\/\//.test(v)) return /tiktok\.com\/?($|explore|foryou)/.test(v) ? v : `https://example.invalid/${short(v)}`;
    if (/^\d{15,}$/.test(v)) return `7${short(v).padEnd(5, "0")}…${v.slice(-3)}`; // video/user ids: shape kept
    if (SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key)) return /cover|avatar|image|thumb/i.test(key) ? "‹image›" : /text|desc|caption|bio|signature/i.test(key) ? "‹caption›" : `creator_${short(v)}`;
    return v.replace(/@[\w.]{2,}/g, (m) => `@creator_${short(m)}`);
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
}

/** Facet values are short display strings: keep counts, redact the rest. */
const redactValues = (vals: (string | null)[], path: string) => vals.map((x) => (x == null || /^[\d.,KMB%]+$/i.test(x) || /count|plays|digg|likes/i.test(path) ? x : SENSITIVE_KEY.test(path.split("/").pop() ?? "") ? "‹›" : x.replace(/@[\w.]{2,}/g, "@creator")));

/** Mosaic a JPEG frame: layout survives, faces/text don't. */
export async function mosaic(jpeg: Buffer, block = 6): Promise<{ jpg: Buffer; sig: string }> {
  const img = sharp(jpeg);
  const { width = 960, height = 675 } = await img.metadata();
  const sw = Math.max(1, Math.round(width / block)), sh = Math.max(1, Math.round(height / block));
  const small = await img.resize(sw, sh, { kernel: "nearest" }).raw().toBuffer();
  // coarse signature for near-duplicate detection (8×8 luma-ish)
  const sig = (await sharp(small, { raw: { width: sw, height: sh, channels: 3 } }).resize(8, 8).greyscale().raw().toBuffer()).toString("base64");
  const out = Math.min(640, width), oh = Math.round(height * out / width);
  const jpg = await sharp(small, { raw: { width: sw, height: sh, channels: 3 } }).resize(out, oh, { kernel: "nearest" }).jpeg({ quality: 50, mozjpeg: true }).toBuffer();
  return { jpg, sig };
}
export const sigDiff = (a: string, b: string) => { const x = Buffer.from(a, "base64"), y = Buffer.from(b, "base64"); let d = 0; for (let i = 0; i < x.length; i++) d += Math.abs(x[i] - y[i]); return d / x.length; };

/** The newest claude CLI transcript for the Studio agent (spawned with cwd = os.tmpdir()). */
export function latestTranscript(since: number): string | null {
  const root = join(homedir(), ".claude/projects");
  if (!existsSync(root)) return null;
  let best: { f: string; m: number } | null = null;
  for (const d of readdirSync(root).filter((x) => /var-folders|tmp/i.test(x))) {
    for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith(".jsonl"))) {
      const p = join(root, d, f), m = statSync(p).mtimeMs;
      if (m < since || (best && m <= best.m)) continue;
      if (!readFileSync(p, "utf8").includes("mcp__a2flow__")) continue; // the Studio agent, not the research sub-agent
      best = { f: p, m };
    }
  }
  return best?.f ?? null;
}

export interface ChatItem { t: number; role: "user" | "assistant"; kind: "text" | "thinking" | "tool"; text?: string; name?: string; summary?: string }

export function chatOf(file: string | null): ChatItem[] {
  if (!file) return [];
  const out: ChatItem[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.timestamp ?? "") || 0;
    if (e.type === "user" && typeof e.message?.content === "string") out.push({ t, role: "user", kind: "text", text: e.message.content });
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) out.push({ t, role: "assistant", kind: "text", text: c.text });
      else if (c.type === "thinking" && c.thinking?.trim()) out.push({ t, role: "assistant", kind: "thinking", text: c.thinking.slice(0, 600) });
      else if (c.type === "tool_use") {
        const name = String(c.name).replace(/^mcp__a2flow__/, "");
        const i = c.input ?? {};
        const summary = i.url ?? i.urlContains ?? i.site ?? i.viewId ?? (i.times ? `×${i.times}` : i.inputs ? JSON.stringify(i.inputs) : "");
        out.push({ t, role: "assistant", kind: "tool", name, summary: String(summary).slice(0, 80) });
      }
    }
  }
  const scrub = (t?: string) => t?.replace(/@[\w.]{2,}/g, (m) => `@creator_${short(m)}`).replace(/\b\d{15,}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-3)}`).replace(/https?:\/\/(?!www\.tiktok\.com\/(explore|foryou)?\b)[^\s)]+/g, "https://example.invalid/…");
  return out.map((c) => ({ ...c, text: scrub(c.text), summary: scrub(c.summary) }));
}

const STRUCTURAL = new Set(["schema", "artifact", "bench", "phase", "parity", "breadcrumb", "machine", "timeline", "scene", "records-reset", "a2ui-reset", "research"]);

export async function exportSession(session: StudioSession, dir: string) {
  const frames = join(dir, "frames");
  mkdirSync(frames, { recursive: true });
  const scenes = [];
  for (const sc of session.scenes as Timeline[]) {
    const files: { t: number; f: string }[] = [];
    // keep ≤ 6 fps of frames per scene (the player crossfades), mosaicked
    let lastT = -1e9, lastSig = "";
    for (let i = 0; i < sc.frames.length; i++) {
      const fr = sc.frames[i], last = i === sc.frames.length - 1;
      if (fr.t - lastT < 250 && !last) continue; // ≤ 4 fps
      const { jpg, sig } = await mosaic(fr.data);
      if (lastSig && !last && sigDiff(sig, lastSig) < 1.5) continue; // visually unchanged: the player holds the previous frame
      lastT = fr.t; lastSig = sig;
      const name = `${sc.id}-${i}.jpg`;
      writeFileSync(join(frames, name), jpg);
      files.push({ t: fr.t, f: `frames/${name}` });
    }
    scenes.push({
      id: sc.id, label: redact(sc.label, "label"), kind: sc.kind, t0: sc.t0, duration: sc.frames.at(-1)?.t ?? 0, marks: redact(sc.marks),
      frames: files,
      facets: sc.facets.map((f) => ({ t: f.t, snap: { ...f.snap, url: "https://www.tiktok.com/explore", facets: f.snap.facets.map((x) => ({ ...x, values: redactValues(x.values, x.path) })) } })),
      acts: sc.acts.map((a) => ({ t: a.t, act: { ...a.act, url: undefined } })),
      a2ui: sc.a2ui.map((m) => ({ t: m.t, msg: redact(m.msg) })),
    });
  }
  const t0 = Math.min(...session.eventLog.map((e) => e.t), ...scenes.map((s) => s.t0), Date.now());
  const bundle = {
    version: 1,
    recordedAt: new Date(t0).toISOString(),
    note: "Recorded Netscraper Studio session on the live site. Page imagery mosaicked and creator identifiers replaced for publication.",
    scenes,
    // structural events (schema field names, file names, bench, machine) carry no creator data: keep them verbatim
    events: session.eventLog.filter((e) => e.ev.type !== "a2ui").map((e) => (STRUCTURAL.has(String(e.ev.type)) ? e : { t: e.t, ev: redact(e.ev) as Record<string, unknown> })),
    chat: chatOf(latestTranscript(t0 - 60_000)),
    manifest: redact(session.manifest ?? null),
  };
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle));
  return { dir, scenes: scenes.length, frames: scenes.reduce((a, s) => a + s.frames.length, 0), events: bundle.events.length, chat: bundle.chat.length };
}
