/**
 * Side-by-side streaming UI test.
 *
 *   Lane A  FlowRunner: A2UI surface + A2UI actions only (the thing under test)
 *   Lane M  MultimodalLane: perception (geometry/text/pixels) + raw pointer input (the baseline)
 *
 * Both lanes run in their own CloakBrowser in lockstep: after every primitive step of lane A
 * (the runner's afterStep barrier) lane M performs the *same intent* from perception, both settle,
 * and the checks below are evaluated and streamed. The run passes when the A2UI rendering is
 * grounded in what lane M can see, the lanes stay on the same page, and lists agree.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAdapter, startScreencast, type BrowserAdapter, type LaunchSpec } from "../adapters/index.js";
import type { FlowManifest } from "../manifest/types.js";
import type { StepEvent } from "../runtime/runner.js";
import { createRunner } from "../runtime/index.js";
import { renderTree, resolveDynamic, walk, type Surface } from "../a2ui/surface.js";
import { getAt } from "../a2ui/pointer.js";
import { validateClientMessage, validateServerMessage } from "../manifest/load.js";
import { MultimodalLane, type Percept } from "./perceive.js";
import { createViewerServer, type ViewerServer } from "./server.js";
import { settleDom } from "../derive/capture.js";

export interface Check { step: string; kind: string; check: string; pass: boolean; score?: number; detail: string }
export interface TestReport {
  flow: string; passed: boolean; startedAt: string; durationMs: number;
  summary: Record<string, unknown>;
  checks: Check[];
  steps: { path: string; kind: string; view: string | null; aMs: number; mMs: number; mDid?: string; shot?: string; surface?: string }[];
  items: Record<string, number>;
}

/** Bound (data-driven) leaves of the rendered surface with their raw values. */
export function boundLeaves(s: Surface): { id: string; scope: string; value: unknown }[] {
  const out: { id: string; scope: string; value: unknown }[] = [];
  for (const n of walk(renderTree(s))) {
    const c = s.components.get(n.id)!;
    const prop = c.component === "Text" ? c.text : c.component === "Image" ? c.url : undefined;
    if (prop == null || typeof prop === "string") continue; // literals aren't page data
    const raw = (prop as any).call === "formatNumber" ? resolveDynamic((prop as any).args?.value, s.dataModel, n.scope) : resolveDynamic(prop, s.dataModel, n.scope);
    out.push({ id: n.id, scope: n.scope, value: raw });
  }
  return out;
}

export async function sideBySide(m: FlowManifest, inputs: Record<string, unknown>, opts: {
  launch: LaunchSpec; outDir: string; serve?: number; minCoverage?: number;
}): Promise<TestReport> {
  const minCov = opts.minCoverage ?? 0.9;
  mkdirSync(join(opts.outDir, "steps"), { recursive: true });
  const t0 = Date.now();
  const [aA, aM] = await Promise.all([launchAdapter(opts.launch), launchAdapter(opts.launch)]);
  const viewer: ViewerServer | undefined = opts.serve ? createViewerServer(opts.serve, { lanes: ["M", "A"], flow: m.id, title: `${m.title ?? m.id} — side by side` }) : undefined;
  if (viewer) process.stderr.write(`viewer: ${viewer.url}\n`);
  const emit = (ev: Record<string, unknown>) => {
    viewer?.broadcast(ev);
    if (ev.type !== "frame") appendFileSync(join(opts.outDir, "events.jsonl"), JSON.stringify(ev) + "\n");
  };
  const stops = viewer ? await Promise.all([
    startScreencast(aA, (d) => emit({ type: "frame", lane: "A", data: d }), 560),
    startScreencast(aM, (d) => emit({ type: "frame", lane: "M", data: d }), 560),
  ]) : [];

  const report: TestReport = { flow: m.id, passed: false, startedAt: new Date().toISOString(), durationMs: 0, summary: {}, checks: [], steps: [], items: {} };
  const record = (c: Check) => { report.checks.push(c); emit({ type: "check", ...c }); };
  const lane = new MultimodalLane(aM);
  await lane.init();

  let lastBarrier = Date.now();
  let shotN = 0;
  const runner = createRunner(m, aA, inputs, {
    afterStep: async (e: StepEvent) => {
      const aMs = Date.now() - lastBarrier;
      const tM = Date.now();
      let mDid: string | undefined;
      const aUrl = new URL(await aA.url());
      try {
        mDid = await mirror(e, aUrl);
      } catch (err) {
        record({ step: e.path, kind: e.kind, check: "lane-m-action", pass: false, detail: String((err as Error).message) });
      }
      const mMs = Date.now() - tM;
      const step = { path: e.path, kind: e.kind, view: e.view, aMs, mMs, mDid } as TestReport["steps"][number];
      if (e.kind !== "log") await evaluate(e, aUrl, step);
      report.steps.push(step);
      emit({ type: "step", lane: "A", path: e.path, kind: e.kind, view: e.view, mUrl: (await aM.url()).replace(/^https?:\/\/[^/]+/, ""), mDid });
      lastBarrier = Date.now();
    },
  });

  /** Lane M performs the same intent as lane A's step, from perception only. */
  async function mirror(e: StepEvent, aUrl: URL): Promise<string | undefined> {
    if (e.kind === "navigate") { await lane.goto(aUrl.href); return `goto ${aUrl.pathname}`; }
    if (e.kind === "action" && e.action) {
      // e.view is the view *after* the action; the surface it was raised on is `<view>-<seq>`
      const raisedOn = e.action.action.surfaceId.replace(/-\d+$/, "");
      const am = m.views[raisedOn]?.actions[e.action.action.name];
      if (!am) return undefined;
      const did = await lane.perform(am, e.action.action.context);
      await settleDom(aM, 400, 8000);
      return did;
    }
    if (e.kind === "await") { await lane.waitPath(aUrl.pathname); return `wait ${aUrl.pathname}`; }
    return undefined;
  }

  async function evaluate(e: StepEvent, aUrl: URL, step: TestReport["steps"][number]) {
    const s = runner.projector.store.current();
    const mPath = await lane.path().catch(() => "?");
    // sync points only: after an action both lanes may still be mid-navigation; the following
    // `await` is where they must agree.
    if (e.kind === "navigate" || e.kind === "await") {
      const aPath = new URL(await aA.url()).pathname;
      record({ step: e.path, kind: e.kind, check: "url-sync", pass: mPath === aPath, detail: `A=${aPath} M=${mPath}` });
    }
    if (!s || !(e.kind === "await" || e.kind === "emit")) return;
    const p: Percept = await lane.look();

    if (e.kind === "await") {
      const loadedInM = new Map<string, number>();
      // M→A: keyed lists — what lane M sees as item links vs what the surface holds
      const v = m.views[e.view ?? ""];
      for (const [ptr, ex] of Object.entries(v?.model ?? {}) as [string, any][]) {
        if (!ex.each || !ex.key) continue;
        const items = (getAt(s.dataModel, ptr) as any[]) ?? [];
        const urlField = Object.keys(ex.fields).find((k) => ex.fields[k].as === "url" && /href/.test(ex.fields[k].get ?? ""));
        if (!urlField || !items.length) continue;
        const sample = String(items[0][urlField]), key = String(items[0][ex.key]);
        const re = new RegExp("^" + sample.split(key).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/?#]+") + "$");
        // Both lists in DOM order. Lanes may legitimately have loaded different amounts (lane M
        // scrolls while hunting visually), so the invariant is: the shorter is a prefix of the longer.
        const mList = [...p.hrefs].filter((h) => re.test(h));
        loadedInM.set(ptr, mList.length);
        const aList = items.map((it) => String(it[urlField]));
        const n = Math.min(mList.length, aList.length);
        const mismatch = aList.slice(0, n).filter((h, i) => h !== mList[i]).length;
        const unseen = aList.filter((h) => !mList.includes(h)).length;
        record({ step: e.path, kind: e.kind, check: "list-parity", pass: mismatch === 0 && n > 0 && (unseen === 0 || aList.length > mList.length),
          score: n ? 1 - mismatch / n : 0,
          detail: `${ptr}: A2UI=${aList.length} M=${mList.length}, first ${n} in identical order${mismatch ? `; ${mismatch} out of order/different` : ""}${aList.length !== mList.length ? ` (${aList.length > mList.length ? "A" : "M"} loaded further)` : ""}` });
      }
      // A→M: every data-bound leaf the A2UI surface renders must be visible to lane M
      const all = boundLeaves(s).filter((l) => l.value != null && l.value !== "");
      // judge list items only within the window lane M has loaded too (see list-parity)
      const beyond = (scope: string) => [...loadedInM].some(([ptr, n]) => { const m = new RegExp(`^${ptr}/(\\d+)`).exec(scope); return !!m && Number(m[1]) >= n; });
      const leaves = all.filter((l) => !beyond(l.scope));
      const excluded = all.length - leaves.length;
      const miss = leaves.filter((l) => !p.sees(l.value));
      const score = leaves.length ? 1 - miss.length / leaves.length : 1;
      record({ step: e.path, kind: e.kind, check: "render-equivalence", pass: score >= minCov, score,
        detail: `${leaves.length - miss.length}/${leaves.length} bound values visible to lane M${excluded ? ` (${excluded} beyond the window lane M loaded)` : ""}${miss.length ? `; missing ${miss.slice(0, 4).map((x) => `${x.id}${x.scope !== "/" ? x.scope : ""}=${JSON.stringify(x.value).slice(0, 40)}`).join(", ")}` : ""}` });

      // artefacts for (human/agent) visual review: lane M pixels + the A2UI surface it should match
      const n = String(++shotN).padStart(3, "0");
      step.shot = `steps/${n}-M.jpg`;
      step.surface = `steps/${n}-A.json`;
      writeFileSync(join(opts.outDir, step.shot), await aM.screenshot({ type: "jpeg" }));
      writeFileSync(join(opts.outDir, step.surface), JSON.stringify({ surfaceId: s.surfaceId, theme: s.theme, components: [...s.components.values()], dataModel: s.dataModel }));
    }
    if (e.kind === "emit" && e.emitted) {
      // every scalar of the emitted record should be grounded in what lane M perceives
      const scalars: [string, unknown][] = [];
      const flat = (o: any, pre: string) => { for (const [k, x] of Object.entries(o ?? {})) {
        if (x && typeof x === "object" && !Array.isArray(x)) flat(x, `${pre}${k}.`);
        else if (Array.isArray(x)) x.forEach((y, i) => (y && typeof y === "object" ? flat(y, `${pre}${k}[${i}].`) : scalars.push([`${pre}${k}[${i}]`, y])));
        else scalars.push([pre + k, x]);
      } };
      flat(e.emitted.item, "");
      // Only fields the route reads from the *current* view are judged here; fields carried in
      // from flow scope (e.g. the grid tile's playCount) were grounded when that view was checked.
      const map = m.routes[e.emitted.route].map;
      // v0.1 maps say which fields read the current view; for JSONata routes, a field reads the
      // current view iff its value occurs in the current surface's data model.
      const inModel = new Set<string>();
      const collect = (x: unknown) => { if (x && typeof x === "object") Object.values(x).forEach(collect); else if (x != null) inModel.add(JSON.stringify(x)); };
      collect(s.dataModel);
      const fromView = (k: string, x: unknown) => map
        ? Object.entries(map).some(([mk, expr]) => expr.trim().startsWith("/") && (k === mk || k.startsWith(mk + "[") || k.startsWith(mk + ".")))
        : inModel.has(JSON.stringify(x));
      const present = scalars.filter(([k, x]) => x != null && x !== "" && fromView(k, x));
      const miss = present.filter(([, x]) => !p.sees(x));
      const score = present.length ? 1 - miss.length / present.length : 1;
      record({ step: e.path, kind: e.kind, check: "emit-grounding", pass: score >= 0.75, score,
        detail: `${e.emitted.route}: ${present.length - miss.length}/${present.length} fields visible${miss.length ? `; not visible: ${miss.map(([k]) => k).join(", ")}` : ""}` });
    }
  }

  let protocolErrors = 0;
  runner.on("message", (msg) => {
    emit({ type: "a2ui", lane: "A", msg });
    const errs = validateServerMessage(msg);
    if (errs.length && protocolErrors++ < 5) record({ step: "stream", kind: "protocol", check: "a2ui-schema", pass: false, detail: errs.join("; ") });
  });
  runner.on("action", (a) => {
    emit({ type: "client", lane: "A", msg: a });
    const errs = validateClientMessage(a);
    if (errs.length && protocolErrors++ < 5) record({ step: "stream", kind: "protocol", check: "a2ui-schema", pass: false, detail: errs.join("; ") });
  });
  runner.on("item", (it) => { report.items[it.route] = (report.items[it.route] ?? 0) + 1; emit({ type: "item", ...it }); });
  runner.on("log", (l) => process.stderr.write(`· ${l}\n`));

  let failure: string | undefined;
  try {
    await runner.run();
  } catch (e) {
    failure = String((e as Error).message);
    record({ step: "flow", kind: "run", check: "flow-completed", pass: false, detail: failure });
  }
  const by = (name: string) => report.checks.filter((c) => c.check === name);
  const rate = (cs: Check[]) => (cs.length ? cs.filter((c) => c.pass).length / cs.length : 1);
  const mean = (cs: Check[]) => (cs.length ? cs.reduce((a, c) => a + (c.score ?? (c.pass ? 1 : 0)), 0) / cs.length : 1);
  report.durationMs = Date.now() - t0;
  report.summary = {
    steps: report.steps.length,
    checks: report.checks.length,
    failed: report.checks.filter((c) => !c.pass).length,
    urlSync: rate(by("url-sync")),
    renderEquivalence: +mean(by("render-equivalence")).toFixed(3),
    listParity: rate(by("list-parity")),
    emitGrounding: +mean(by("emit-grounding")).toFixed(3),
    a2uiMessages: runner.projector.log.length,
    protocolErrors,
    laneTimeMs: { A: report.steps.reduce((a, s) => a + s.aMs, 0), M: report.steps.reduce((a, s) => a + s.mMs, 0) },
    items: report.items,
  };
  report.passed = !failure && protocolErrors === 0 && by("render-equivalence").every((c) => c.pass)
    && rate(by("url-sync")) === 1 && rate(by("list-parity")) >= 0.9 && mean(by("emit-grounding")) >= 0.75;
  writeFileSync(join(opts.outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(opts.outDir, "results.json"), JSON.stringify(runner.results, null, 2));
  writeReportHtml(report, opts.outDir);
  emit({ type: "done", report: { passed: report.passed, summary: report.summary } });
  process.stderr.write(`${report.passed ? "PASS" : "FAIL"} ${JSON.stringify(report.summary)}\n→ ${opts.outDir}/report.html\n`);
  for (const s of stops) await s();
  await viewer?.close();
  await Promise.all([aA.close(), aM.close()]);
  return report;
}

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), "../../viewer");

/** Static report: per await-step, lane M's pixels next to the A2UI surface rendered by the same renderer. */
function writeReportHtml(r: TestReport, outDir: string) {
  writeFileSync(join(outDir, "a2ui-renderer.js"), readFileSync(join(VIEWER, "a2ui-renderer.js")));
  const surfaces: Record<string, unknown> = {};
  for (const s of r.steps) if (s.surface) surfaces[s.surface] = JSON.parse(readFileSync(join(outDir, s.surface), "utf8"));
  const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const rows = r.steps.filter((s) => s.shot).map((s) => {
    const cs = r.checks.filter((c) => c.step === s.path);
    return `<article><h3>${esc(s.path)} · ${esc(s.view ?? "")} <small>A ${s.aMs}ms · M ${s.mMs}ms</small></h3>
<ul>${cs.map((c) => `<li class="${c.pass ? "ok" : "bad"}"><b>${c.pass ? "✓" : "✗"} ${esc(c.check)}</b> ${esc(c.detail)}</li>`).join("")}</ul>
<div class="pair"><figure><figcaption>Lane M · page pixels</figcaption><img src="${s.shot}" alt="lane M screenshot"></figure>
<figure><figcaption>Lane A · A2UI surface</figcaption><div class="surface" data-surface="${s.surface}"></div></figure></div></article>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>a2flow side-by-side</title><style>
:root{--bg:#f6f7f9;--panel:#fff;--fg:#14161a;--muted:#6b7280;--line:#e3e6ea;--ok:#15803d;--bad:#b91c1c;--a2-card:#fff;--a2-line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a20;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2f37;--ok:#4ade80;--bad:#f87171;--a2-card:#1d2128;--a2-line:#2f353e}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;padding:16px}
header,article{max-width:1200px;margin:0 auto 16px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
h1{margin:0 0 6px;font-size:18px}h3{margin:0 0 6px;font-size:14px}small{color:var(--muted);font-weight:400}
ul{margin:0 0 10px;padding-left:18px;font-size:12.5px}.ok b{color:var(--ok)}.bad b{color:var(--bad)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0;min-width:0}figcaption{font-size:11px;color:var(--muted);text-transform:uppercase;margin-bottom:4px}
.pair img{width:100%;border-radius:6px;border:1px solid var(--line)}.surface{max-height:620px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px}
code{font-size:12px}@media (max-width:760px){.pair{grid-template-columns:1fr}}
</style><style id="a2css"></style></head><body>
<header><h1>${r.passed ? "PASS" : "FAIL"} · ${esc(r.flow)}</h1><code>${esc(JSON.stringify(r.summary))}</code></header>
${rows}
<script type="module">
import { A2UIClient, A2UI_CSS } from "./a2ui-renderer.js";
document.getElementById("a2css").textContent = A2UI_CSS;
const surfaces = ${JSON.stringify(surfaces).replace(/</g, "\\u003c")};
for (const el of document.querySelectorAll(".surface")) {
  const s = surfaces[el.dataset.surface]; const c = new A2UIClient();
  c.apply({ createSurface: { surfaceId: s.surfaceId, catalogId: "basic", theme: s.theme } });
  c.apply({ updateComponents: { surfaceId: s.surfaceId, components: s.components } });
  c.apply({ updateDataModel: { surfaceId: s.surfaceId, path: "/", value: s.dataModel } });
  c.mount(el);
}
</script></body></html>`;
  writeFileSync(join(outDir, "report.html"), html);
}
