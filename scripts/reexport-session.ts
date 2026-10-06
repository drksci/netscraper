/**
 * Rebuild a publishable replay bundle from a running Studio server (scenes + frames over HTTP) plus a previous
 * export's redacted timeline — used when the server's export module changed after it started.
 *   npx tsx scripts/reexport-session.ts <previous-export-dir> <out-dir> [server]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatOf, latestTranscript, mosaic, redact, sigDiff } from "../src/studio/export.js";

const [prev, out, server = "http://127.0.0.1:7801"] = process.argv.slice(2);
const old = JSON.parse(readFileSync(join(prev, "bundle.json"), "utf8"));
mkdirSync(join(out, "frames"), { recursive: true });
const summaries: any[] = await (await fetch(`${server}/scenes`)).json();
const scenes = [];
for (const s of summaries) {
  const d: any = await (await fetch(`${server}/scenes/${s.id}`)).json();
  const files: { t: number; f: string }[] = [];
  let lastT = -1e9, lastSig = "";
  for (let i = 0; i < d.frameTimes.length; i++) {
    const t = d.frameTimes[i], last = i === d.frameTimes.length - 1;
    if (t - lastT < 250 && !last) continue;
    const buf = Buffer.from(await (await fetch(`${server}/scenes/${s.id}/frame/${i}`)).arrayBuffer());
    const { jpg, sig } = await mosaic(buf);
    if (lastSig && !last && sigDiff(sig, lastSig) < 1.5) continue;
    lastT = t; lastSig = sig;
    const name = `${s.id}-${i}.jpg`;
    writeFileSync(join(out, "frames", name), jpg);
    files.push({ t, f: `frames/${name}` });
  }
  const prevScene = old.scenes.find((x: any) => x.id === s.id);
  scenes.push({ ...(prevScene ?? {}), id: s.id, label: redact(s.label, "label"), kind: s.kind, t0: s.t0, duration: d.duration, frames: files });
  process.stdout.write(`${s.label}: ${files.length}/${d.frameTimes.length} frames\n`);
}
const chat = chatOf(latestTranscript(Date.parse(old.recordedAt) - 120_000));
writeFileSync(join(out, "bundle.json"), JSON.stringify({ ...old, scenes, chat }));
console.log({ scenes: scenes.length, frames: scenes.reduce((a, s) => a + s.frames.length, 0), chat: chat.length, kinds: chat.map((c) => c.kind[0]).join("") });
