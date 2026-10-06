/**
 * `a2flow diagnose <bundle>` — the authoring pass's entry point. Re-checks the manifest's
 * expectations against a fault bundle's frozen page (DOM + pixels + fingerprint + HAR + console)
 * and classifies the fault so the author (human, LLM, or the cached vision-patch loop) knows
 * whether to retry, add a state, or re-derive the view:
 *
 *   blocked          policy block selectors/text present (captcha / interstitial)
 *   unhandled-state  the page is a recognisable state the machine didn't expect here, or matches no view at all
 *   site-changed     structure drifted (domhash) and/or the expected view's selectors stopped resolving
 *   transient        page still matches the manifest; network/timeout evidence → retry/backoff/policy
 *   unknown
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import type { BrowserAdapter } from "../adapters/types.js";
import type { Extractor, FlowManifest } from "../manifest/types.js";
import { inpageRuntime } from "../render/projector.js";
import { fingerprintPage, similarity, similarityParts, structuralDiff } from "./fingerprint.js";

interface FieldCheck { pointer: string; sel: string; hits: number; value: unknown; emptyList?: boolean }

function flattenFields(ptr: string, ex: any, out: { pointer: string; sel?: string; scope?: string; list?: string }[] = [], scope?: string, list?: string) {
  if (ex.each) { out.push({ pointer: ptr, sel: ex.each, scope, list }); for (const [k, f] of Object.entries(ex.fields ?? {})) flattenFields(`${ptr}/*/${k}`, f, out, ex.each, ptr); }
  else if (ex.fields) { for (const [k, f] of Object.entries(ex.fields)) flattenFields(`${ptr}/${k}`, f, out, ex.scope ?? scope, list); }
  else if (ex.sel) out.push({ pointer: ptr, sel: ex.sel, scope, list });
  return out;
}

/** A list's own `each` selector with 0 hits = empty list (valid), unless its items' container is gone too. */
function isListRoot(f: FieldCheck, all: FieldCheck[]) { return all.some((g) => g.pointer.startsWith(f.pointer + "/*/")); }

export async function diagnose(m: FlowManifest, bundle: string, a: BrowserAdapter) {
  const read = (f: string) => (existsSync(join(bundle, f)) ? readFileSync(join(bundle, f), "utf8") : undefined);
  const reason = JSON.parse(read("reason.json") ?? "{}");
  const html = read("dom.html") ?? "";
  const har = JSON.parse(read("network.har") ?? '{"log":{"entries":[]}}');
  const consoleLog = JSON.parse(read("console.json") ?? "[]");
  const expectedId: string | undefined = reason.expectedView ?? reason.view;
  const url = new URL(reason.url || "about:blank");

  // Re-host the frozen DOM (scripts stripped so nothing navigates/mutates) at its original path so path matching works.
  const clean = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<meta[^>]+http-equiv[^>]*>/gi, "");
  const server = createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === url.pathname) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(clean); }
    else { res.writeHead(204); res.end(); } // subresources: don't refetch the live site
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try { await a.goto(`http://127.0.0.1:${port}${url.pathname}${url.search}`); } finally { server.close(); }
  await a.evaluate(inpageRuntime());
  await a.evaluate(`window.__a2flow.configure(${JSON.stringify(Object.fromEntries(Object.entries(m.views).map(([k, v]) => [k, { match: v.match, model: v.model }])))})`);
  // note: about:blank origin keeps the original pathname only if replaceState succeeded; match by selector/text otherwise
  const matched = await a.evaluate<string | null>("window.__a2flow.matchView()");
  const perView: Record<string, { matches: boolean; resolved: number; total: number }> = {};
  for (const [id, v] of Object.entries(m.views)) {
    const fields = Object.entries(v.model).flatMap(([p, ex]) => flattenFields(p, ex as Extractor));
    const hits = await a.evaluate<number[]>(`${JSON.stringify(fields)}.map((f) => { try { return document.querySelectorAll(f.scope ? f.scope + " " + f.sel : f.sel).length; } catch { return 0; } })`);
    perView[id] = {
      matches: await a.evaluate<boolean>(`(() => { const m = ${JSON.stringify(v.match)}; if (m.selector && !document.querySelector(m.selector)) return false;
        if (m.absent && document.querySelector(m.absent)) return false; if (m.text && !new RegExp(m.text, "i").test(document.body.innerText.slice(0, 8000))) return false; return true; })()`),
      resolved: hits.filter((h) => h > 0).length, total: hits.length,
    };
  }
  let fields: FieldCheck[] = [];
  if (expectedId && m.views[expectedId]) {
    const v = m.views[expectedId];
    const flat = Object.entries(v.model).flatMap(([p, ex]) => flattenFields(p, ex as Extractor));
    const hits = await a.evaluate<number[]>(`${JSON.stringify(flat)}.map((f) => { try { return document.querySelectorAll(f.scope ? f.scope + " " + f.sel : f.sel).length; } catch { return -1; } })`);
    const model = await a.evaluate<any>(`window.__a2flow.extract(${JSON.stringify(expectedId)})`);
    const listHits = new Map(flat.map((f, i) => [f.pointer, hits[i]]));
    fields = flat.map((f, i) => ({ pointer: f.pointer, sel: f.scope ? `${f.scope} ${f.sel}` : f.sel!, hits: hits[i],
      emptyList: f.list ? listHits.get(f.list) === 0 : undefined,
      value: f.pointer.includes("*") ? undefined : f.pointer.split("/").filter(Boolean).reduce((o: any, k) => o?.[k], model) }));
  }
  const blockedHit = await a.evaluate<string | null>(`(() => {
    const p = ${JSON.stringify((m as any).policies?.blocked ?? {})};
    for (const s of p.selectors ?? []) if (document.querySelector(s)) return s;
    for (const t of p.textPatterns ?? []) if (new RegExp(t, "i").test(document.body.innerText)) return t; return null; })()`);

  const fpExpected = expectedId ? m.views[expectedId]?.fingerprint : undefined;
  const fpObserved = await fingerprintPage(a).catch(() => null);
  const sim = fpExpected && fpObserved ? similarity(fpExpected, fpObserved) : undefined;

  const entries: any[] = har.log?.entries ?? [];
  const failed = entries.filter((e) => e._error || e.response?.status >= 400).map((e) => ({ url: e.request.url, status: e.response?.status, error: e._error }));
  const exceptions = consoleLog.filter((c: any) => c.level === "exception" || c.level === "error");
  // an empty list is a valid state (no videos), not a broken selector — neither are its item fields
  const broken = fields.filter((f) => f.hits === 0 && !f.emptyList && !isListRoot(f, fields));

  let classification: string, rationale: string;
  if (blockedHit) { classification = "blocked"; rationale = `block signal present: ${blockedHit}`; }
  else if (matched && expectedId && matched !== expectedId) { classification = "unhandled-state"; rationale = `page matches view "${matched}" but the machine expected "${expectedId}" here — add a transition for it`; }
  else if (!matched && expectedId && perView[expectedId] && !perView[expectedId].matches && (sim ?? 1) >= (fpExpected?.minSimilarity ?? 0.5)) {
    classification = "site-changed"; rationale = `structure is similar (${sim?.toFixed(2)}) but view "${expectedId}" no longer matches: its match selector/text changed`;
  } else if ((sim !== undefined && sim < (fpExpected?.minSimilarity ?? 0.5)) || (fields.length && broken.length / fields.length > 0.3)) {
    classification = matched ? "site-changed" : "unhandled-state";
    rationale = `${broken.length}/${fields.length} expected selectors resolve to nothing; structure similarity ${sim?.toFixed(2) ?? "n/a"}${matched ? "" : "; no view matches this page"}`;
  } else if (reason.reason === "drift" && matched === expectedId && !broken.length) {
    classification = "false-positive-drift"; rationale = `page matches "${matched}", all selectors resolve, similarity now ${sim?.toFixed(2)} — the fingerprint/threshold is stale, not the manifest`;
  } else if (!matched) { classification = "unhandled-state"; rationale = "no declared view matches this page (new interstitial/outcome?)"; }
  else if (failed.length || /timed? ?out/i.test(reason.error ?? "")) { classification = "transient"; rationale = `page still matches "${matched}"; ${failed.length} failed requests; error: ${reason.error}`; }
  else { classification = "unknown"; rationale = `page matches "${matched}" and selectors resolve; error: ${reason.error}`; }

  const diagnosis = {
    bundle, reason: reason.reason, error: reason.error, url: reason.url, state: reason.state,
    expectedView: expectedId, matchedView: matched, classification, rationale,
    fingerprint: fpExpected && fpObserved ? { ...similarityParts(fpExpected, fpObserved), similarity: sim, minSimilarity: fpExpected.minSimilarity, diff: structuralDiff(fpExpected, fpObserved, 30) } : null,
    views: perView, brokenSelectors: broken, fields,
    network: { requests: entries.length, failed: failed.slice(0, 20) }, consoleErrors: exceptions.slice(0, 20),
    next: {
      "site-changed": `re-derive: a2flow derive --view ${expectedId} --url ${reason.url} (+ a second URL of the same view), review the new annotated capture, then rebuild; compare selectors with this diagnosis`,
      "unhandled-state": `add a view for this page (match by path + text/selector, outcome: true if terminal) and a transition from state "${reason.state}"`,
      blocked: "adjust policies.blocked.action (pause for a human) / proxy & fingerprint settings; do not change the manifest's views",
      transient: "raise policies.retry / timeouts / rateLimit; the manifest's views are still valid",
      "false-positive-drift": `re-fingerprint view "${expectedId}" from more samples (include edge variants like this one) to recalibrate minSimilarity`,
      unknown: "inspect screenshot.png + spans.otlp.json + logs.txt",
    }[classification],
  };
  writeFileSync(join(bundle, "diagnosis.json"), JSON.stringify(diagnosis, null, 1));
  writeFileSync(join(bundle, "review.md"), reviewPack(diagnosis, bundle));
  return diagnosis;
}

function reviewPack(d: any, bundle: string): string {
  const imgs = ["screenshot.png", "canvas0.jpg", "canvas1.jpg"].filter((f) => existsSync(join(bundle, f)));
  return `# a2flow fault review — ${d.classification}

You are the authoring pass for an a2flow manifest. A run faulted; decide whether the site changed and,
if so, produce a RefinePatch (renames/variants/drops/labels/intents) or describe the new view/transition.
Do not invent selectors that you cannot see in dom.html.

- reason: ${d.reason} — ${d.error ?? ""}
- url: ${d.url}
- machine state: ${d.state}
- expected view: ${d.expectedView} · matched view: ${d.matchedView ?? "none"}
- classification: **${d.classification}** — ${d.rationale}
- structure similarity: ${d.fingerprint?.similarity?.toFixed?.(3) ?? "n/a"} (threshold ${d.fingerprint?.minSimilarity ?? "n/a"})

## Look at
${imgs.map((i) => `- ${i}`).join("\n")}
- dom.html (frozen page), visual.json (geometry + stable selectors), expected.view.json (what the manifest expects)
- spans.otlp.json (OpenTelemetry trace), network.har (DevTools HAR), console.json, a2ui.tail.jsonl, machine.json

## Selectors of the expected view that resolve to nothing
${d.brokenSelectors.length ? d.brokenSelectors.map((f: any) => `- \`${f.pointer}\` ← \`${f.sel}\``).join("\n") : "- (none)"}

## Views vs this page
${Object.entries(d.views).map(([k, v]: any) => `- ${k}: match=${v.matches} fields ${v.resolved}/${v.total}`).join("\n")}

## Failed requests
${d.network.failed.length ? d.network.failed.map((f: any) => `- ${f.status ?? ""} ${f.error ?? ""} ${f.url}`).join("\n") : "- (none)"}

## Suggested next step
${d.next}
`;
}
