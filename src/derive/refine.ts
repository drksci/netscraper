/**
 * Optional multimodal refinement: show a vision model the annotated screenshot + canvas frames
 * + the heuristic view, and get back a *patch* (semantic renames, variants, pruning, intents).
 * The model never authors selectors — so the result stays grounded in what the DOM pass proved
 * stable — and the patched view is re-validated against the A2UI catalog before acceptance.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Component } from "../a2ui/types.js";
import type { ViewSpec } from "../manifest/types.js";
import { validateComponents } from "../manifest/load.js";

export interface RefinePatch {
  viewTitle?: string;
  /** Top-level model pointer renames: {"/profile": "/author"} */
  models?: Record<string, string>;
  /** Field renames per (old) model pointer: {"/profile": {"userTitle": "uniqueId"}} */
  fields?: Record<string, Record<string, string>>;
  components?: Record<string, string>;
  actions?: Record<string, string>;
  variants?: Record<string, string>;
  drop?: string[];
  /** Literal text for label Text components: {"likes_count_label": "Likes"} */
  labels?: Record<string, string>;
  intents?: Record<string, string>;
  notes?: string;
}

const PROMPT = (viewId: string, view: ViewSpec, routeHint: string) => `You are refining an automatically derived A2UI v0.9 surface for the "${viewId}" view of a web page.
The first image is a screenshot with red labelled boxes: each label is an A2UI component id anchored to that region.
Any further images are frames captured from <canvas>/<video> elements on the page.

Derived view (components use the A2UI basic catalog; data bindings point into "model"):
${JSON.stringify({ components: view.components, model: view.model, actions: view.actions }, null, 1)}

${routeHint ? `The extracted data will be published in this output format, so prefer these names where they fit:\n${routeHint}\n` : ""}
Return ONLY a JSON object (no prose, no code fence) with any of these optional keys:
- "viewTitle": short human title for the view
- "models": rename top-level model pointers, e.g. {"/profile": "/author"}
- "fields": rename fields inside a model object or list item, keyed by the OLD pointer, e.g. {"/profile": {"userTitle": "uniqueId"}}
- "components": rename component ids to semantic snake_case ids (never rename "root")
- "actions": rename event action names (camelCase), e.g. {"openUserPost": "openVideo"}
- "variants": better Text/Image variants by component id (Text: h1..h5|caption|body; Image: icon|avatar|smallFeature|mediumFeature|largeFeature|header)
- "labels": literal text for static label Text components by component id
- "drop": component ids that are noise/chrome and should not be in the surface
- "intents": natural-language intent per (old) action name, describing how a person would do it by looking at the page
- "notes": one sentence on anything that looks wrong
Do not invent selectors or new fields.`;

function extractJson(text: string): RefinePatch {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`no JSON in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/** Ask Claude (SDK if credentials are configured, else the local `claude` CLI) for a patch. */
export async function requestRefinement(opts: {
  viewId: string; view: ViewSpec; annotated: Buffer; canvases: string[]; routeHint?: string; workDir: string; backend?: "sdk" | "cli";
}): Promise<RefinePatch> {
  const prompt = PROMPT(opts.viewId, opts.view, opts.routeHint ?? "");
  const backend = opts.backend ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "sdk" : "cli");
  if (backend === "sdk") {
    const client = new Anthropic();
    const images: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: opts.annotated.toString("base64") } },
      ...opts.canvases.slice(0, 3).map((d): Anthropic.Beta.BetaContentBlockParam => ({
        type: "image", source: { type: "base64", media_type: "image/jpeg", data: d.replace(/^data:image\/\w+;base64,/, "") },
      })),
    ];
    const msg = await client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
    } as any).finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("refinement request was declined");
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return extractJson(text);
  }
  // Claude Code CLI: write images to disk and let it Read them.
  const shot = join(opts.workDir, `${opts.viewId}.annotated.png`);
  writeFileSync(shot, opts.annotated);
  const frames = opts.canvases.slice(0, 3).map((d, i) => {
    const p = join(opts.workDir, `${opts.viewId}.canvas${i}.jpg`);
    writeFileSync(p, Buffer.from(d.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    return p;
  });
  const cliPrompt = `Read these image files first: ${[shot, ...frames].join(", ")}\n\n${prompt}`;
  const r = spawnSync("claude", ["-p", cliPrompt, "--allowedTools", "Read", "--output-format", "text"], { encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`claude CLI failed: ${r.stderr || r.stdout}`.slice(0, 500));
  return extractJson(r.stdout);
}

/** Apply a patch, rewriting every reference (bindings, templates, anchors, actions). */
export function applyRefinement(view: ViewSpec, p: RefinePatch): { view: ViewSpec; errors: string[] } {
  const v: ViewSpec = structuredClone(view);
  if (p.viewTitle) v.title = p.viewTitle;

  // --- model pointers + fields ---
  const listFieldMap: Record<string, string> = {}; // relative (template) renames
  const ptrMap: [string, string][] = [];
  for (const [oldTop, ex] of Object.entries(view.model)) {
    const newTop = p.models?.[oldTop] ?? oldTop;
    const fr = p.fields?.[oldTop] ?? {};
    const spec: any = structuredClone(ex);
    if (spec.fields) {
      spec.fields = Object.fromEntries(Object.entries(spec.fields).map(([k, f]) => [fr[k] ?? k, f]));
      if (spec.key && fr[spec.key]) spec.key = fr[spec.key];
    }
    if (newTop !== oldTop) { delete (v.model as any)[oldTop]; }
    (v.model as any)[newTop] = spec;
    ptrMap.push([oldTop, newTop]);
    for (const [a, b] of Object.entries(fr)) {
      ptrMap.push([`${oldTop}/${a}`, `${newTop}/${b}`]);
      if (spec.each) listFieldMap[a] = b;
    }
  }
  const mapPtr = (ptr: string) => {
    let best: [string, string] | undefined;
    for (const pair of ptrMap) if ((ptr === pair[0] || ptr.startsWith(pair[0] + "/")) && (!best || pair[0].length > best[0].length)) best = pair;
    return best ? best[1] + ptr.slice(best[0].length) : ptr;
  };
  const mapBinding = (x: any): any => {
    if (Array.isArray(x)) return x.map(mapBinding);
    if (x && typeof x === "object") {
      if (typeof x.path === "string" && Object.keys(x).length <= 2) {
        return { ...x, path: x.path.startsWith("/") ? mapPtr(x.path) : listFieldMap[x.path] ?? x.path };
      }
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, mapBinding(y)]));
    }
    return x;
  };

  // --- components ---
  const drop = new Set(p.drop ?? []);
  drop.delete("root");
  const cmap = (id: string) => (id === "root" ? id : p.components?.[id] ?? id);
  const amap = (n: string) => p.actions?.[n] ?? n;
  v.components = view.components.filter((c) => !drop.has(c.id)).map((c) => {
    const out: Component = { ...mapBinding(c), id: cmap(c.id) };
    if (Array.isArray(c.children)) out.children = (c.children as string[]).filter((x) => !drop.has(x)).map(cmap);
    else if (c.children && typeof c.children === "object") {
      const t = c.children as { path: string; componentId: string };
      out.children = { path: mapPtr(t.path), componentId: cmap(t.componentId) };
    }
    for (const k of ["child", "trigger", "content"]) if (typeof c[k] === "string") out[k] = cmap(c[k] as string);
    const ev = (c.action as any)?.event;
    if (ev) {
      const ctx = Object.fromEntries(Object.entries(ev.context ?? {}).map(([k, x]) => [listFieldMap[k] ?? k, mapBinding(x)]));
      out.action = { event: { name: amap(ev.name), ...(ev.context ? { context: ctx } : {}) } };
    }
    if (p.variants?.[c.id]) out.variant = p.variants[c.id];
    if (p.labels?.[c.id] && c.component === "Text") out.text = p.labels[c.id];
    return out;
  });
  v.anchors = Object.fromEntries(Object.entries(view.anchors).filter(([k]) => !drop.has(k)).map(([k, a]) =>
    [cmap(k), "model" in a ? { ...a, model: mapPtr(a.model) } : a]));
  v.actions = Object.fromEntries(Object.entries(view.actions).map(([k, a]) => [amap(k), {
    ...a,
    ...(a.anchor ? { anchor: cmap(a.anchor) } : {}),
    ...(a.key ? { key: listFieldMap[a.key] ?? a.key } : {}),
    ...(a.reveal ? { reveal: amap(a.reveal) } : {}),
    intent: (p.intents?.[k] ?? a.intent).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => `{{${listFieldMap[n] ?? n}}}`),
  }]));
  // dropped components take their (now unreferenced) model fields with them
  for (const id of drop) {
    const a = view.anchors[id];
    if (!a || !("model" in a)) continue;
    const parts = mapPtr(a.model).split("/").filter(Boolean);
    const top = "/" + parts[0];
    const spec: any = (v.model as any)[top];
    if (parts.length === 1) delete (v.model as any)[top];
    else if (spec?.fields && parts.length === 2) delete spec.fields[parts[1]];
  }
  if (v.match.selector) v.match.selector = view.match.selector;

  const errors = validateComponents(v.components);
  const ids = new Set(v.components.map((c) => c.id));
  for (const c of v.components) for (const r of [c.child, ...(Array.isArray(c.children) ? c.children : [])]) {
    if (typeof r === "string" && !ids.has(r)) errors.push(`${c.id} references missing ${r}`);
  }
  return { view: v, errors };
}
