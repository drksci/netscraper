/**
 * derive: page URL(s) → stable A2UI view (+ artefacts). Multiple URLs of the same view type
 * (e.g. two profiles) are what make the schema *stable*: selectors must hold on all of them and
 * only varying values become data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserAdapter } from "../adapters/types.js";
import type { FlowManifest, RouteSpec, ViewSpec } from "../manifest/types.js";
import { BASIC_CATALOG_ID } from "../a2ui/types.js";
import { inpageRuntime } from "../render/projector.js";
import { capture, settleDom, type Capture } from "./capture.js";
import { deriveView, type DeriveReport } from "./heuristic.js";
import { applyRefinement, requestRefinement, type RefinePatch } from "./refine.js";
import { InferenceCache } from "./cache.js";
import { fingerprintPage, similarity, type Fingerprint } from "../machine/fingerprint.js";

export interface DeriveResult { view: ViewSpec; report: DeriveReport & { anchorsResolved?: string; refine?: unknown }; captures: Capture[]; patch?: RefinePatch }

export async function annotatedScreenshot(a: BrowserAdapter, viewId: string, view: ViewSpec): Promise<{ png: Buffer; resolved: string[]; missing: string[] }> {
  await a.evaluate(`window.__a2flow.configure(${JSON.stringify({ [viewId]: { match: view.match, model: view.model } })})`);
  const boxes: { label: string; rect: number[]; color: string }[] = [];
  const resolved: string[] = [], missing: string[] = [];
  for (const [cid, anchor] of Object.entries(view.anchors)) {
    const r = await a.evaluate<any>(`window.__a2flow.locate(${JSON.stringify(viewId)}, ${JSON.stringify(anchor)}, null, 0)`);
    if (!r) { missing.push(cid); continue; }
    resolved.push(cid);
    const sy = await a.evaluate<number>("scrollY");
    boxes.push({ label: cid, rect: [r.rect.x, r.rect.y + sy, r.rect.width, r.rect.height], color: cid.includes("item") ? "#2563eb" : "#e11d48" });
  }
  await a.evaluate("window.scrollTo(0, 0)");
  await a.evaluate(`window.__a2flow.annotate(${JSON.stringify(boxes)})`);
  const png = await a.screenshot({ fullPage: true });
  await a.evaluate("window.__a2flow.clearAnnotations()");
  return { png, resolved, missing };
}

export async function derive(a: BrowserAdapter, opts: {
  viewId: string; urls: string[]; outDir: string; refine?: false | "sdk" | "cli" | "auto"; routeHint?: string;
  /** A refinement patch authored out-of-band (e.g. by an agent reviewing the saved captures). */
  patch?: RefinePatch;
  /** Inference cache dir (default .a2flow-cache/inference); false disables. */
  cache?: string | false;
  prepare?: (a: BrowserAdapter) => Promise<void>;
}): Promise<DeriveResult> {
  mkdirSync(opts.outDir, { recursive: true });
  await a.addInitScript(inpageRuntime());
  const caps: Capture[] = [];
  const fps: Fingerprint[] = [];
  for (const url of opts.urls) {
    await a.goto(url);
    await opts.prepare?.(a);
    caps.push(await capture(a, null));
    fps.push(await fingerprintPage(a));
  }
  const { view, report } = deriveView(opts.viewId, caps);
  // structural fingerprint; threshold calibrated from how much the samples already differ
  let minPair = 1;
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) minPair = Math.min(minPair, similarity(fps[i], fps[j]));
  view.fingerprint = { simhash: fps[0].simhash, shape: fps[0].shape, ...(fps[0].ax ? { ax: fps[0].ax } : {}), minSimilarity: +Math.max(0.4, minPair * 0.85).toFixed(3) };
  caps.forEach((c, i) => writeFileSync(join(opts.outDir, `${opts.viewId}.sample${i}.png`), c.screenshot));
  caps.flatMap((c) => c.canvases).forEach((cv, i) => cv.dataUrl &&
    writeFileSync(join(opts.outDir, `${opts.viewId}.canvas${i}.jpg`), Buffer.from(cv.dataUrl.split(",")[1], "base64")));

  await settleDom(a, 400, 4000);
  const ann = await annotatedScreenshot(a, opts.viewId, view);
  writeFileSync(join(opts.outDir, `${opts.viewId}.annotated.png`), ann.png);
  const out: DeriveResult = { view, report: { ...report, anchorsResolved: `${ann.resolved.length}/${ann.resolved.length + ann.missing.length}` }, captures: caps };

  // ---- multimodal inference (cached) ----
  const canvasBufs = caps.flatMap((c) => c.canvases.map((x) => x.dataUrl).filter(Boolean) as string[])
    .map((d) => Buffer.from(d.split(",")[1], "base64"));
  const cache = opts.cache === false ? undefined : new InferenceCache(opts.cache);
  let patch: RefinePatch | undefined;
  let inference: Record<string, unknown> = {};
  if (opts.patch) {
    patch = opts.patch;
    if (cache) cache.put(opts.viewId, view, patch, "agent", ann.png, canvasBufs);
    inference = { source: "provided", cached: !!cache };
  } else if (cache) {
    const hit = cache.lookup(opts.viewId, view, ann.png, canvasBufs);
    if (hit.status !== "miss") {
      patch = hit.entry.patch;
      inference = { source: `cache:${hit.entry.source}`, status: hit.status, distance: hit.distance, key: hit.entry.key };
    } else inference = { status: "miss", key: hit.key };
  }
  if (!patch && opts.refine) {
    try {
      patch = await requestRefinement({
        viewId: opts.viewId, view, annotated: ann.png,
        canvases: canvasBufs.map((b) => `data:image/jpeg;base64,${b.toString("base64")}`),
        routeHint: opts.routeHint, workDir: opts.outDir,
        backend: opts.refine === "auto" ? undefined : opts.refine,
      });
      const backend = opts.refine === "auto" ? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "sdk" : "cli") : opts.refine;
      cache?.put(opts.viewId, view, patch, backend, ann.png, canvasBufs);
      inference = { ...inference, source: backend, stored: !!cache };
    } catch (e) {
      inference = { ...inference, error: String((e as Error).message ?? e) };
    }
  }
  if (!patch && !opts.refine && inference.status === "miss") {
    // agent-in-the-loop: leave a request next to the captures for whoever interprets them
    writeFileSync(join(opts.outDir, `${opts.viewId}.inference-request.json`), JSON.stringify({
      viewId: opts.viewId, key: inference.key,
      images: [`${opts.viewId}.annotated.png`, ...canvasBufs.map((_, i) => `${opts.viewId}.canvas${i}.jpg`)],
      view: `${opts.viewId}.view.json`, answerWith: "a RefinePatch JSON passed back via --patch (it is then cached)",
    }, null, 2));
  }
  if (patch) {
    const applied = applyRefinement(view, patch);
    writeFileSync(join(opts.outDir, `${opts.viewId}.refine.json`), JSON.stringify({ patch, errors: applied.errors }, null, 2));
    if (!applied.errors.length) {
      const check = await annotatedScreenshot(a, opts.viewId, applied.view);
      if (!check.missing.length || check.missing.length <= ann.missing.length) {
        out.view = applied.view;
        out.patch = patch;
        writeFileSync(join(opts.outDir, `${opts.viewId}.refined.annotated.png`), check.png);
      }
      out.report.refine = { applied: out.view === applied.view, missing: check.missing, notes: patch.notes, inference };
    } else out.report.refine = { applied: false, errors: applied.errors, inference };
  } else out.report.refine = { applied: false, inference };
  out.view.fingerprint ??= view.fingerprint;
  writeFileSync(join(opts.outDir, `${opts.viewId}.view.json`), JSON.stringify(out.view, null, 2));
  writeFileSync(join(opts.outDir, `${opts.viewId}.report.json`), JSON.stringify(out.report, null, 2));
  return out;
}

/** Infer a JSON Schema for a list extractor's items (used to scaffold routes). */
function itemSchema(fields: Record<string, any>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields)) {
    props[k] = f.each ? { type: "array" } : f.fields ? { type: "object" } : { type: f.as === "count" || f.as === "int" ? ["integer", "null"] : ["string", "null"] };
  }
  return { type: "object", properties: props };
}

/** A runnable manifest skeleton from derived views: one route per list, a scroll-and-emit flow. */
export function scaffoldManifest(id: string, baseUrl: string, views: Record<string, ViewSpec>, startPath: string): FlowManifest {
  const routes: Record<string, RouteSpec> = {};
  const flow: FlowManifest["flow"] = [{ navigate: startPath }];
  const [firstId, first] = Object.entries(views)[0];
  flow.push({ await: { view: firstId } });
  for (const [ptr, ex] of Object.entries(first.model) as [string, any][]) {
    if (!ex.each) continue;
    const name = `${id}.${ptr.slice(1)}`;
    routes[name] = {
      description: `One item of ${ptr} on ${firstId}`,
      schema: itemSchema(ex.fields), key: ex.key,
      map: Object.fromEntries(Object.keys(ex.fields).map((k) => [k, `{{ it.${k} }}`])),
    };
    const more = Object.entries(first.actions).find(([, a]) => a.op === "scroll")?.[0];
    if (more) {
      const btn = Object.entries(first.anchors).find(([cid, a]) => "model" in a && a.model === ptr && first.components.find((c) => c.id === cid && (c.action as any)?.event?.name === more))?.[0];
      if (btn) flow.push({ repeat: { until: { or: [{ gte: [{ count: ptr }, "{{ inputs.limit }}"] }, { stalled: 3 }] }, max: 30, do: [{ action: more, on: btn }] } });
    }
    flow.push({ forEach: { in: ptr, as: "it", limit: "{{ inputs.limit }}", do: [{ emit: name }] } });
  }
  return {
    a2flow: "0.1", id, title: `${id} (derived)`,
    a2ui: { version: "v0.9", catalogId: BASIC_CATALOG_ID },
    target: { baseUrl, viewport: { width: 1280, height: 900 } },
    inputs: { type: "object", properties: { limit: { type: "integer", default: 24 } } },
    routes: Object.keys(routes).length ? routes : { [`${id}.page`]: { schema: { type: "object" }, map: {} } },
    views, flow,
    provenance: { derivedAt: new Date().toISOString(), tool: "a2flow derive" },
  };
}
