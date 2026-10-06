/**
 * Fault tolerance, idempotency and stream determinism of the v0.2 runtime against the seeded
 * chaos mock (503s, slow responses, click-blocking login modal, failing feed API) and the
 * outcome accounts (not found / private / empty / unavailable video).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, chaosOf, mockUser } from "../fixtures/tiktok-mock/server.ts";
import { launchAdapter } from "../src/adapters/index.ts";
import { loadManifest } from "../src/manifest/load.ts";
import { MachineRunner } from "../src/machine/runner.ts";
import { extractStream } from "../src/runtime/extract.ts";

const skip = !!process.env.A2FLOW_SKIP_E2E;
const MANIFEST = new URL("../flows/tiktok-profile.a2flow.json", import.meta.url).pathname;
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function runOnce(baseUrl: string, outDir: string, inputs: Record<string, unknown>, opts: { stopAfterVideos?: number; slowPath?: boolean } = {}) {
  const m = loadManifest(MANIFEST);
  m.target.baseUrl = baseUrl;
  // force the detail-page fallback (as if the feed XHR changed shape) to exercise per-video units
  if (opts.slowPath) (m.views.profile.model["/feed"] as any).net.url = "^nomatch$";
  (m as any).policies.rateLimit = { minDelayMs: 0, jitterMs: 0 };
  (m as any).policies.retry = { attempts: 6, baseMs: 200, maxMs: 1500, jitter: 0.2 };
  const spec = { adapter: "playwright" as const, headless: true, viewport: m.target.viewport };
  const a = await launchAdapter(spec);
  let videos = 0;
  const r = new MachineRunner(m, a, inputs, {
    outDir, relaunch: () => launchAdapter(spec),
    afterStep: async (e) => {
      if (e.kind === "emit" && e.emitted?.route === "tiktok.video" && !e.emitted.duplicate && ++videos >= (opts.stopAfterVideos ?? Infinity)) r.abort("simulated crash");
    },
  });
  const messages: unknown[] = [];
  r.on("message", (msg) => messages.push(msg));
  try { return { results: await r.run(), messages, runner: r, error: undefined as unknown }; }
  catch (error) { return { results: r.results, messages, runner: r, error }; }
  finally { await a.close().catch(() => {}); }
}

test("chaos: every unit completes or ends in a declared outcome; stream replay == live dataset", { skip, timeout: 900_000 }, async () => {
  const chaos = chaosOf(0.2, "seed-1");
  const { server, url } = await startMock(0, chaos);
  const out = mkdtempSync(join(tmpdir(), "a2flow-chaos-"));
  try {
    const { results, messages, runner, error } = await runOnce(url, out, { profiles: ["chef.nova", "nobody", "locked", "empty"], resultsPerPage: 8 });
    assert.equal(error, undefined, String(error));
    const injected = Object.values(chaos.injected).reduce((x, y) => x + y, 0);
    assert.ok(injected > 0, "chaos actually injected faults");
    assert.ok(runner.stats.retries + runner.stats.dismissed > 0, `runtime had to recover (${JSON.stringify(runner.stats)}; injected ${JSON.stringify(chaos.injected)})`);
    const units = [...runner.ledger.units.values()];
    const status = (id: string) => units.find((u) => u.id === id)?.status;
    assert.equal(status("profile:nobody"), "skipped");
    assert.equal(status("profile:locked"), "skipped");
    assert.equal(status("profile:empty"), "done");
    assert.equal(status("profile:chef.nova"), "done");
    const all = new Set(mockUser("chef.nova").videos.map((v) => v.id));
    const got = results["tiktok.video"].map((v: any) => v.id);
    assert.ok(got.every((id: string) => all.has(id)), "only real videos");
    assert.equal(new Set(got).size, got.length, "no duplicates");
    assert.deepEqual(got, mockUser("chef.nova").videos.slice(0, 8).map((v) => v.id), "first resultsPerPage videos, in feed order, despite chaos");
    assert.ok(units.every((u) => u.status !== "running"), "no unit left running");
    // stream determinism: the A2UI stream alone reproduces the dataset
    const replay = await extractStream(loadManifest(MANIFEST), messages as any[]);
    assert.deepEqual(new Set(replay["tiktok.video"].map((v) => JSON.stringify(v))), new Set(results["tiktok.video"].map((v) => JSON.stringify(v))));
    assert.deepEqual(replay["tiktok.author"].map((a: any) => a.name).sort(), ["chef.nova", "empty"]);
    // telemetry exists
    assert.ok(existsSync(join(out, "spans.otlp.json")) && existsSync(join(out, "machine.json")));
    for (const d of runner.faults) for (const f of ["reason.json", "dom.html", "screenshot.png", "network.har", "spans.otlp.json"]) assert.ok(existsSync(join(d, f)), `${d}/${f}`);
  } finally { server.close(); }
});

test("idempotent resume: a run killed mid-way and rerun over the same dir yields each record exactly once", { skip, timeout: 900_000 }, async () => {
  const { server, url } = await startMock(0);
  const out = mkdtempSync(join(tmpdir(), "a2flow-resume-"));
  const inputs = { profiles: ["dance.mike"], resultsPerPage: 6 };
  try {
    const first = await runOnce(url, out, inputs, { stopAfterVideos: 3, slowPath: true });
    assert.match(String(first.error), /simulated crash/);
    assert.equal(lines(join(out, "tiktok.video.jsonl")).length, 3);
    const second = await runOnce(url, out, inputs, { slowPath: true });
    assert.equal(second.error, undefined, String(second.error));
    const all = lines(join(out, "tiktok.video.jsonl"));
    assert.equal(all.length, 6, "6 unique records across both runs");
    assert.equal(new Set(all.map((v) => v.id)).size, 6, "no duplicates");
    assert.equal(second.results["tiktok.video"].length, 3, "second run only did the remaining work");
    assert.equal(lines(join(out, "tiktok.author.jsonl")).length, 1, "author not re-emitted");
    assert.ok(readdirSync(join(out, "faults")).some((d) => d.includes("run-failed")), "the crash left a fault bundle");
  } finally { server.close(); }
});
