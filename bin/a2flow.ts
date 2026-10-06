#!/usr/bin/env -S npx tsx
/**
 * a2flow — derive A2UI flows from live pages, run them anywhere, test them side by side.
 *
 *   a2flow mock [port]
 *   a2flow derive --view <id> --url <u> [--url <u2>] [--out dir] [--patch p.json] [--refine auto|sdk|cli] [--manifest out.json]
 *   a2flow lint <manifest>
 *   a2flow run  <manifest> --input '{"profiles":["x"]}' [--adapter playwright|puppeteer|cdp] [--endpoint ws://…]
 *                          [--base-url u] [--out dir] [--stream file|-] [--serve port] [--headful] [--no-humanize]
 *   a2flow extract <manifest> <a2ui.jsonl> [--out dir]      rebuild route datasets from a recorded A2UI stream (no browser)
 *   a2flow diagnose <manifest> <fault-bundle-dir>            classify a fault (site changed / unhandled state / blocked / transient) for the authoring pass
 *   a2flow replay <manifest> <fault-bundle> [--serve port] [--headful]   recreate a faulted run from its bundle (snapshot + URL), run forward, diagnose
 *   a2flow test <manifest> --input '{…}' [--adapter …] [--base-url u] [--out dir] [--serve port] [--min-coverage 0.9]
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchAdapter, type LaunchSpec } from "../src/adapters/index.js";
import { checkManifest, loadManifest } from "../src/manifest/load.js";
import type { FlowManifest } from "../src/manifest/types.js";

const [cmd, ...rest] = process.argv.slice(2);
const { values: o, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    view: { type: "string" }, url: { type: "string", multiple: true }, out: { type: "string" }, patch: { type: "string" },
    refine: { type: "string" }, manifest: { type: "string" }, input: { type: "string" }, "input-file": { type: "string" },
    adapter: { type: "string", default: "playwright" }, endpoint: { type: "string" }, "base-url": { type: "string" },
    stream: { type: "string" }, serve: { type: "string" }, headful: { type: "boolean" }, "no-humanize": { type: "boolean" },
    "min-coverage": { type: "string" }, id: { type: "string" },
  },
});

function launchSpec(m?: FlowManifest): LaunchSpec {
  return {
    adapter: o.adapter as LaunchSpec["adapter"],
    endpoint: o.endpoint,
    headless: o.headful ? false : (m?.target.browser?.headless ?? true),
    humanize: o["no-humanize"] ? false : (m?.target.browser?.humanize ?? false),
    viewport: m?.target.viewport,
    locale: m?.target.browser?.locale,
    timezone: m?.target.browser?.timezone,
  };
}

function manifestArg(): FlowManifest {
  if (!positionals[0]) throw new Error("manifest path required");
  const m = loadManifest(resolve(positionals[0]));
  if (o["base-url"]) m.target.baseUrl = o["base-url"];
  return m;
}

function inputs(): Record<string, unknown> {
  if (o["input-file"]) return JSON.parse(readFileSync(o["input-file"], "utf8"));
  return o.input ? JSON.parse(o.input) : {};
}

async function main() {
  switch (cmd) {
    case "mock": {
      const { startMock } = await import("../fixtures/tiktok-mock/server.js");
      const { url } = await startMock(Number(positionals[0] ?? 4545));
      console.log(`tiktok mock on ${url}  (try ${url}/@chef.nova)`);
      return;
    }
    case "lint": {
      const errs = checkManifest(JSON.parse(readFileSync(positionals[0], "utf8")));
      console.log(errs.length ? errs.join("\n") : "ok");
      process.exitCode = errs.length ? 1 : 0;
      return;
    }
    case "derive": {
      const { derive, scaffoldManifest } = await import("../src/derive/derive.js");
      if (!o.view || !o.url?.length) throw new Error("--view and --url required");
      const a = await launchAdapter(launchSpec());
      try {
        const r = await derive(a, {
          viewId: o.view, urls: o.url, outDir: o.out ?? "out/derive",
          refine: (o.refine as any) ?? false,
          patch: o.patch ? JSON.parse(readFileSync(o.patch, "utf8")) : undefined,
        });
        console.log(JSON.stringify({ lists: r.report.lists, fields: r.report.fields.filter((f) => f.kept).map((f) => `${f.name} ← ${f.sel}`), anchors: r.report.anchorsResolved, refine: r.report.refine }, null, 2));
        console.log(`artefacts in ${o.out ?? "out/derive"}: ${o.view}.{sample*.png,annotated.png,canvas*.jpg,view.json,report.json}`);
        if (o.manifest) {
          const u = new URL(o.url[0]);
          const m = scaffoldManifest(o.id ?? "derived.flow", u.origin, { [o.view]: r.view }, u.pathname);
          writeFileSync(o.manifest, JSON.stringify(m, null, 2));
          const errs = checkManifest(m);
          console.log(`manifest → ${o.manifest} ${errs.length ? "(INVALID)\n" + errs.join("\n") : "(valid)"}`);
        }
      } finally { await a.close(); }
      return;
    }
    case "run": {
      const { createRunner } = await import("../src/runtime/index.js");
      const m = manifestArg();
      const outDir = o.out ?? `out/run-${m.id}`;
      mkdirSync(outDir, { recursive: true });
      const a = await launchAdapter(launchSpec(m));
      // v0.2 without --input: wait for the A2UI control surface's `start` (use --serve to fill it in)
      const runner = createRunner(m, a, o.input || o["input-file"] ? inputs() : undefined, { outDir } as any);
      const stream = o.stream === "-" ? process.stdout : createWriteStream(o.stream ?? join(outDir, "a2ui.jsonl"));
      runner.on("message", (msg) => stream.write(JSON.stringify(msg) + "\n"));
      runner.on("action", (act) => stream.write(JSON.stringify(act) + "\n"));
      runner.on("log", (l) => process.stderr.write(`· ${l}\n`));
      runner.on("unit", (u: any) => u.status !== "running" && process.stderr.write(`  unit ${u.type}:${u.key} ${u.status}${u.reason ? ` (${u.reason})` : u.error ? ` (${String(u.error).slice(0, 80)})` : ""}\n`));
      runner.on("fault", (f: any) => process.stderr.write(`! fault bundle ${f.dir}\n`));
      runner.on("item", ({ route, item }) => {
        if (!m.machine) appendFileSync(join(outDir, `${route}.jsonl`), JSON.stringify(item) + "\n"); // v0.2 runner persists itself
        process.stderr.write(`+ ${route} ${JSON.stringify(item).slice(0, 110)}\n`);
      });
      let stopViewer: (() => Promise<void>) | undefined;
      if (o.serve) stopViewer = (await import("../src/harness/server.js")).serveRun(runner, a, Number(o.serve));
      try {
        const t = Date.now();
        const res = await runner.run();
        writeFileSync(join(outDir, "results.json"), JSON.stringify(res, null, 2));
        process.stderr.write(`done in ${((Date.now() - t) / 1000).toFixed(1)}s: ${Object.entries(res).map(([k, v]) => `${k}=${v.length}`).join(" ")} → ${outDir}\n`);
      } finally {
        await stopViewer?.();
        await a.close();
      }
      return;
    }
    case "replay": {
      const { MachineRunner } = await import("../src/machine/runner.js");
      const { diagnose } = await import("../src/machine/diagnose.js");
      const m = manifestArg();
      const bundle = positionals[1];
      const reason = JSON.parse(readFileSync(join(bundle, "reason.json"), "utf8"));
      const machine = JSON.parse(readFileSync(join(bundle, "machine.json"), "utf8"));
      const outDir = o.out ?? join(bundle, "replay");
      const a = await launchAdapter(launchSpec(m));
      const r = new MachineRunner(m, a, undefined, { outDir, restore: machine.snapshot ?? machine, restorePublished: machine.published, startUrl: reason.url });
      r.on("log", (l) => process.stderr.write(`· ${l}\n`));
      r.on("state", (s: any) => process.stderr.write(`  state ${typeof s.value === "string" ? s.value : JSON.stringify(s.value)}\n`));
      r.on("fault", (f: any) => process.stderr.write(`! fault ${f.reason}: ${f.error ?? ""} → ${f.dir}\n`));
      let stop: (() => Promise<void>) | undefined;
      if (o.serve) stop = (await import("../src/harness/server.js")).serveRun(r, a, Number(o.serve));
      process.stderr.write(`replaying ${reason.reason} from state "${reason.state}" at ${reason.url}\n`);
      let error: string | undefined;
      try { await r.run(); } catch (e) { error = String((e as Error).message ?? e); }
      const verdict = r.faults.length ? `reproduced: ${r.faults.length} fault(s)` : error ? `failed differently: ${error}` : "did not reproduce (transient?)";
      console.log(JSON.stringify({ original: { reason: reason.reason, error: reason.error, state: reason.state }, replay: { verdict, error, faults: r.faults, results: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.length])) } }, null, 2));
      for (const f of r.faults.slice(0, 1)) {
        const d = await diagnose(m, f, a).catch(() => null);
        if (d) console.log(JSON.stringify({ firstFault: f, classification: d.classification, rationale: d.rationale, next: d.next }, null, 2));
      }
      await stop?.();
      await a.close();
      return;
    }
    case "diagnose": {
      const { diagnose } = await import("../src/machine/diagnose.js");
      const m = manifestArg();
      const a = await launchAdapter({ ...launchSpec(m), humanize: false });
      try {
        const d = await diagnose(m, positionals[1], a);
        console.log(JSON.stringify({ classification: d.classification, rationale: d.rationale, matchedView: d.matchedView, expectedView: d.expectedView,
          similarity: d.fingerprint?.similarity, broken: d.brokenSelectors.length, next: d.next }, null, 2));
        console.log(`→ ${positionals[1]}/diagnosis.json, review.md`);
      } finally { await a.close(); }
      return;
    }
    case "extract": {
      const { extractStream } = await import("../src/runtime/extract.js");
      const m = manifestArg();
      const lines = readFileSync(positionals[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const res = await extractStream(m, lines);
      if (o.out) {
        mkdirSync(o.out, { recursive: true });
        for (const [r, items] of Object.entries(res)) writeFileSync(join(o.out, `${r}.jsonl`), items.map((x) => JSON.stringify(x)).join("\n") + "\n");
      }
      console.log(JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.length]))));
      return;
    }
    case "test": {
      const { sideBySide } = await import("../src/harness/sidebyside.js");
      const m = manifestArg();
      const report = await sideBySide(m, inputs(), {
        launch: launchSpec(m), outDir: o.out ?? `out/test-${m.id}`,
        serve: o.serve ? Number(o.serve) : undefined, minCoverage: o["min-coverage"] ? Number(o["min-coverage"]) : 0.9,
      });
      process.exitCode = report.passed ? 0 : 1;
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
