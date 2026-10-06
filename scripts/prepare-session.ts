/**
 * Slim an exported Studio session (src/studio/export.ts) for the published replay player:
 *   - frames: already mosaicked; stored at their block resolution (the player upscales them pixelated, so they
 *     look identical) and near-duplicate frames dropped (the player collapses the static gap instead)
 *   - bundle: only what the player reads (interrupt A2UI surfaces, player event types, rounded facet rects)
 *   - poster.jpg: a mid-run frame for the loading state
 *
 *   npx tsx scripts/prepare-session.ts <export dir> <dest dir>
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) { console.error("usage: prepare-session.ts <export dir> <dest dir>"); process.exit(1); }

// published frames are stored as a 96-block-wide mosaic grid (10-px blocks of the 960-px screencast): layout and UI
// stay legible, people and thumbnails do not. The player scales them up pixelated.
const GRID_W = Math.round(960 / 10);
const DUP = 1.0; // mean abs diff (0..255) below which a frame counts as unchanged
const USE_EV = new Set(["phase", "url", "research", "schema", "expected", "manifest", "parity", "records-reset", "records", "breadcrumb", "machine", "bench", "artifact"]);

const b = JSON.parse(readFileSync(join(src, "bundle.json"), "utf8"));
rmSync(join(dest, "frames"), { recursive: true, force: true });
mkdirSync(join(dest, "frames"), { recursive: true });

async function small(file: string) {
  const img = sharp(file);
  const { width = 960, height = 675 } = await img.metadata();
  const w = Math.min(width, GRID_W), h = Math.max(1, Math.round((w * height) / width));
  const raw = await img.clone().resize(w, h, { kernel: "nearest" }).removeAlpha().raw().toBuffer();
  return { w, h, raw };
}
const diff = (a: Buffer, c: Buffer) => { if (a.length !== c.length) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - c[i]); return s / a.length; };

let kept = 0, dropped = 0;
for (const sc of b.scenes ?? []) {
  const frames: { t: number; f: string }[] = sc.frames ?? [];
  const out: typeof frames = [];
  let prev: Buffer | null = null;
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    const s = await small(join(src, fr.f));
    const last = i === frames.length - 1;
    if (prev && !last && diff(prev, s.raw) < DUP) { dropped++; continue; }
    prev = s.raw;
    const jpg = await sharp(s.raw, { raw: { width: s.w, height: s.h, channels: 3 } }).jpeg({ quality: 85, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
    writeFileSync(join(dest, fr.f), jpg);
    out.push(fr);
    kept++;
  }
  sc.frames = out;
  sc.a2ui = (sc.a2ui ?? []).filter((m: any) => JSON.stringify(m.msg ?? "").includes("interrupt:"));
  sc.facets = (sc.facets ?? []).map((x: any) => ({
    t: x.t,
    snap: { ...x.snap, facets: (x.snap?.facets ?? []).filter((f: any) => f.kind !== "net").map((f: any) => ({ ...f, rects: (f.rects ?? []).map((r: number[]) => r.map((v) => Math.round(v))) })) },
  }));
}
b.events = (b.events ?? []).filter((e: any) => USE_EV.has(e?.ev?.type));

// export.ts's key-based redactor also hits non-identifying strings stored under a "name" key (schema field names,
// tool names, the artifact file name). Its placeholder is creator_<fnv1a(original) base36[0..5]>, so map those back
// when the original is a known vocabulary word: any object key in the bundle, a Studio tool, or the artifact name.
{
  const short = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 5); };
  const vocab = new Map<string, string>();
  const addWord = (w: string) => { if (w && w.length < 80) vocab.set(`creator_${short(w)}`, w); };
  const keys = (v: unknown) => { if (Array.isArray(v)) v.forEach(keys); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { addWord(k); keys(x); } };
  keys(b);
  try { for (const m of readFileSync("src/studio/server.ts", "utf8").matchAll(/registerTool\("([a-z_]+)"/g)) addWord(m[1]); } catch { /* not in the a2ui repo */ }
  const mid = b.manifest?.id;
  if (typeof mid === "string") addWord(`${mid}.a2flow.json`);
  let fixed = 0;
  const back = (v: unknown) => { if (typeof v === "string" && vocab.has(v)) { fixed++; return vocab.get(v)!; } return v; };
  for (const e of b.events ?? []) {
    const ev = e.ev;
    if (ev?.type === "schema" && ev.schema) {
      for (const i of ev.schema.inputs ?? []) i.name = back(i.name);
      for (const o of Object.values(ev.schema.outputs ?? {}) as any[]) for (const f of o?.fields ?? []) f.name = back(f.name);
    }
    if (ev?.type === "artifact") ev.name = back(ev.name);
  }
  for (const c of b.chat ?? []) if (c.kind === "tool") c.name = back(c.name);
  if (fixed) console.log(`restored ${fixed} vocabulary strings (schema fields, tool names, artifact name) from redaction placeholders`);
}

// chat: export.ts runs the transcript through the record redactor, which turns every `text` into "‹caption›" and
// every tool `name` into "creator_…". If that happened, rebuild it from the agent transcript with a text-level
// scrub instead (URLs, @handles, long ids, and every creator name / caption seen in local run outputs).
const clobbered = (b.chat ?? []).some((c: any) => c.text === "‹caption›" || /^creator_/.test(c.name ?? ""));
if (clobbered || !(b.chat ?? []).length) {
  const times = [...(b.events ?? []).map((e: any) => e.t), ...(b.scenes ?? []).map((s: any) => s.t0)].filter(Number.isFinite);
  const chat = transcriptChat(Math.min(...times), Math.max(...times));
  if (chat?.length) { b.chat = chat; console.log(`chat: rebuilt ${chat.length} items from the agent transcript (export redaction had clobbered it)`); }
  else console.log("chat: export redaction clobbered the chat and no matching transcript was found; leaving it as is");
}

function denyList(): { names: Set<string>; captions: Set<string> } {
  const names = new Set<string>(), captions = new Set<string>();
  const root = "out/studio";
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory() && f.name !== "exports") walk(p);
      else if (f.name.endsWith(".jsonl") && !/ledger/.test(f.name)) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          let r: any; try { r = JSON.parse(line); } catch { continue; }
          const a = r?.authorMeta ?? r?.author ?? {};
          for (const v of [a.name, a.nickName, a.nickname, a.uniqueId, typeof r?.author === "string" ? r.author : null]) if (typeof v === "string" && v.length >= 3) names.add(v);
          for (const v of [r?.text, r?.desc]) if (typeof v === "string" && v.trim().length >= 12) captions.add(v.trim().slice(0, 40));
        }
      }
    }
  };
  try { walk(root); } catch { /* no local runs */ }
  return { names, captions };
}

function transcriptChat(t0: number, t1: number) {
  const root = join(homedir(), ".claude/projects");
  if (!existsSync(root)) return null;
  // the Studio agent runs with cwd = os.tmpdir(); skip research sub-agents and anything with a different time span
  let best: { f: string; overlap: number } | null = null;
  for (const d of readdirSync(root).filter((x) => /var-folders/i.test(x) && !/research/i.test(x))) {
    for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith(".jsonl"))) {
      const p = join(root, d, f);
      if (statSync(p).mtimeMs < t0 - 60_000) continue;
      const ts = readFileSync(p, "utf8").split("\n").map((l) => { try { return Date.parse(JSON.parse(l).timestamp ?? ""); } catch { return NaN; } }).filter(Number.isFinite);
      if (!ts.length) continue;
      const overlap = Math.min(t1, Math.max(...ts)) - Math.max(t0, Math.min(...ts));
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { f: p, overlap };
    }
  }
  if (!best) return null;
  const { names, captions } = denyList();
  const tag = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 5); };
  const sortedNames = [...names].sort((a, z) => z.length - a.length);
  const scrub = (s: string) => {
    let t = s.replace(/https?:\/\/[^\s)\]"'<>`]+/g, (u) => (/tiktok\.com\/?($|explore|foryou)/.test(u) ? u : `https://example.invalid/${tag(u)}`))
      .replace(/@[\w.]{2,}/g, (m) => `@creator_${tag(m)}`)
      .replace(/\b\d{15,}\b/g, (m) => `7${tag(m).padEnd(5, "0")}…${m.slice(-3)}`);
    for (const c of captions) if (t.includes(c)) t = t.split(c).join("‹caption›");
    for (const n of sortedNames) if (t.includes(n)) t = t.replace(new RegExp(`(?<![\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"), `creator_${tag(n)}`);
    return t;
  };
  const out: any[] = [];
  for (const line of readFileSync(best.f, "utf8").split("\n")) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.timestamp ?? "") || 0;
    if (e.type === "user" && typeof e.message?.content === "string") out.push({ t, role: "user", kind: "text", text: scrub(e.message.content) });
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) out.push({ t, role: "assistant", kind: "text", text: scrub(c.text) });
      else if (c.type === "thinking" && c.thinking?.trim()) out.push({ t, role: "assistant", kind: "thinking", text: scrub(c.thinking.slice(0, 600)) });
      else if (c.type === "tool_use") {
        const name = String(c.name).replace(/^mcp__\w+__/, "");
        const i = c.input ?? {};
        const summary = i.url ?? i.urlContains ?? i.site ?? i.viewId ?? (i.times ? `×${i.times}` : i.inputs ? JSON.stringify(i.inputs) : "");
        out.push({ t, role: "assistant", kind: "tool", name, summary: scrub(String(summary)).slice(0, 80) });
      }
    }
  }
  return out;
}

// poster: middle of the first run scene (or of any scene)
const run = (b.scenes ?? []).find((s: any) => s.kind === "run" && s.frames.length) ?? (b.scenes ?? []).find((s: any) => s.frames.length);
if (run) {
  const f = run.frames[Math.floor(run.frames.length / 2)].f;
  writeFileSync(join(dest, "poster.jpg"), readFileSync(join(dest, f)));
}
writeFileSync(join(dest, "bundle.json"), JSON.stringify(b));

const size = (p: string) => statSync(p).size;
const framesBytes = readdirSync(join(dest, "frames")).reduce((a, f) => a + size(join(dest, "frames", f)), 0);
console.log(`frames kept ${kept}, dropped ${dropped} near-duplicates · frames ${(framesBytes / 1e6).toFixed(2)} MB · bundle.json ${(size(join(dest, "bundle.json")) / 1e6).toFixed(2)} MB`);
