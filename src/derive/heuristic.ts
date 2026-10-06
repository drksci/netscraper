/**
 * Captures → stable A2UI view. Only selectors present in *every* sample survive (stability), and
 * only values that *vary* across samples become data (labels that never change become literals).
 */
import type { Component } from "../a2ui/types.js";
import type { ActionMap, Anchor, Extractor, FieldExtractor, ListExtractor, ViewSpec } from "../manifest/types.js";
import type { Capture, RepeatCand, SingleCand } from "./capture.js";

export interface DeriveReport {
  view: string;
  samples: string[];
  lists: { name: string; itemSel: string; count: number[]; fields: string[]; dropped: string[] }[];
  fields: { name: string; sel: string; kind: string; varies: boolean; kept: boolean; reason?: string }[];
  unstable: string[];
}

const camel = (s: string) => s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());
const COUNT_RE = /^[\d.,]+\s*[KMB]?$/i;
const isCountish = (xs: unknown[]) => xs.length > 0 && xs.every((x) => typeof x === "string" && COUNT_RE.test(x.trim()));

function nameFromSel(sel: string, attr: string | null, fallback: string): string {
  if (attr) return camel(attr);
  const a = /\[(?:data-e2e|data-testid|data-test|aria-label|name|role)="([^"]+)"\]/.exec(sel);
  if (a) return camel(a[1]);
  const c = /class\*="-([A-Za-z]+)"/.exec(sel);
  if (c) return camel(c[1].replace(/^(Div|Span|Strong|Img|A|H\d|P|Picture|Video|Button|Ul|Li)(?=[A-Z])/, ""));
  return fallback;
}

function uniq(name: string, used: Set<string>): string {
  let n = name || "field", i = 2;
  while (used.has(n)) n = `${name}${i++}`;
  used.add(n);
  return n;
}

const textVariant = (font: number) => (font >= 28 ? "h1" : font >= 22 ? "h2" : font >= 18 ? "h3" : font >= 15 ? "body" : "caption");

/** Path regex for the view: generalise handles, numeric ids and slugs across all sample URLs. */
export function pathPattern(urls: string[]): string {
  const segs = urls.map((u) => new URL(u).pathname.replace(/\/$/, "").split("/").slice(1));
  const n = segs[0].length;
  const parts = Array.from({ length: n }, (_, i) => {
    const vals = segs.map((s) => s[i] ?? "");
    if (vals.every((v) => v === vals[0]) && !/\d{5,}/.test(vals[0]) && urls.length > 1) return escapeRe(vals[0]);
    if (vals.every((v) => /^@/.test(v))) return "@[^/]+";
    if (vals.every((v) => /^\d+$/.test(v))) return "\\d+";
    return urls.length > 1 ? "[^/]+" : /^@/.test(vals[0]) ? "@[^/]+" : /^\d+$/.test(vals[0]) ? "\\d+" : escapeRe(vals[0]);
  });
  return `^/${parts.join("/")}/?$`;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function deriveView(viewId: string, caps: Capture[]): { view: ViewSpec; report: DeriveReport } {
  const report: DeriveReport = { view: viewId, samples: caps.map((c) => c.url), lists: [], fields: [], unstable: [] };
  const model: Record<string, Extractor> = {};
  const components: Component[] = [];
  const anchors: Record<string, Anchor> = {};
  const actions: Record<string, ActionMap> = {};
  const rootChildren: string[] = [];
  const usedIds = new Set<string>(["root"]);
  const cid = (s: string) => uniq(camel(s).replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()), usedIds);

  // ---------- singletons ----------
  const single = new Map<string, SingleCand[]>();
  for (const c of caps) for (const s of c.singletons) (single.get(s.sel) ?? single.set(s.sel, []).get(s.sel)!).push(s);
  const usedFields = new Set<string>();
  const fields: Record<string, Extractor> = {};
  const labelBy: Record<string, string> = {};
  const singletonDefs: { name: string; c: SingleCand; varies: boolean }[] = [];
  for (const [sel, hits] of single) {
    const c = hits[0];
    const stable = hits.length === caps.length;
    const vals = hits.map((h) => JSON.stringify(h.kind === "image" ? h.src : h.text));
    const varies = caps.length === 1 || new Set(vals).size > 1;
    const name = nameFromSel(sel, c.attr, c.kind);
    if (!stable) { report.unstable.push(sel); report.fields.push({ name, sel, kind: c.kind, varies, kept: false, reason: "not present in every sample" }); continue; }
    if (!varies && c.kind === "text") {
      labelBy[c.attr ?? sel] = String(c.text);
      report.fields.push({ name, sel, kind: c.kind, varies, kept: false, reason: "static label" });
      continue;
    }
    report.fields.push({ name, sel, kind: c.kind, varies, kept: true });
    singletonDefs.push({ name: uniq(name, usedFields), c, varies });
  }
  // keep document order (top→bottom, left→right)
  singletonDefs.sort((a, b) => a.c.rect[1] - b.c.rect[1] || a.c.rect[0] - b.c.rect[0]);
  const objPtr = `/${camel(viewId)}`;
  const header: string[] = [], stats: string[] = [], body: string[] = [];
  for (const { name, c } of singletonDefs) {
    if (c.all) {
      fields[name] = { each: c.sel, fields: { text: { get: "text" } } } satisfies ListExtractor;
      const listId = cid(name), itemId = cid(`${name}_item`);
      components.push({ id: listId, component: "List", direction: "horizontal", children: { path: `${objPtr}/${name}`, componentId: itemId } });
      components.push({ id: itemId, component: "Text", text: { path: "text" }, variant: "caption" });
      anchors[listId] = { model: `${objPtr}/${name}` };
      body.push(listId);
    } else if (c.kind === "image") {
      fields[name] = { sel: c.sel, get: "src", as: "url" };
      const id = cid(name);
      components.push({ id, component: "Image", url: { path: `${objPtr}/${name}` }, variant: c.round ? "avatar" : c.rect[2] > 300 ? "largeFeature" : "smallFeature", fit: "cover" });
      anchors[id] = { model: `${objPtr}/${name}` };
      header.push(id);
    } else if (c.kind === "canvas") {
      fields[name] = { sel: c.sel, get: "canvas" };
      const id = cid(name);
      components.push({ id, component: "Image", url: { path: `${objPtr}/${name}` }, variant: "mediumFeature", fit: "contain" });
      anchors[id] = { model: `${objPtr}/${name}` };
      body.push(id);
    } else {
      const sampleVals = single.get(c.sel)!.map((h) => String(h.text));
      const count = isCountish(sampleVals);
      fields[name] = count ? { sel: c.sel, get: "text", as: "count" } : { sel: c.sel, get: "text" };
      const id = cid(name);
      if (count) {
        // pair with a static sibling label, e.g. followers-count ↔ followers
        const label = c.attr ? labelBy[c.attr.replace(/-count$/, "")] : undefined;
        const groupId = cid(`${name}_group`), labelId = cid(`${name}_label`);
        components.push({ id: groupId, component: "Column", align: "center", children: [id, labelId] });
        components.push({ id, component: "Text", text: { call: "formatNumber", args: { value: { path: `${objPtr}/${name}` } }, returnType: "string" }, variant: "h4" });
        components.push({ id: labelId, component: "Text", text: label ?? name.replace(/Count$/, ""), variant: "caption" });
        anchors[id] = { model: `${objPtr}/${name}` };
        stats.push(groupId);
      } else {
        components.push({ id, component: "Text", text: { path: `${objPtr}/${name}` }, variant: textVariant(c.font) });
        anchors[id] = { model: `${objPtr}/${name}` };
        (c.font >= 18 && header.length < 4 ? header : body).push(id);
      }
    }
  }
  if (Object.keys(fields).length) {
    model[objPtr] = { fields };
    const col: string[] = [];
    if (header.length) { const id = cid("header_row"); components.push({ id, component: "Row", align: "center", children: header }); col.push(id); }
    if (stats.length) { const id = cid("stats_row"); components.push({ id, component: "Row", justify: "spaceEvenly", children: stats }); col.push(id); }
    col.push(...body);
    const colId = cid(`${viewId}_details`), cardId = cid(`${viewId}_card`);
    components.push({ id: colId, component: "Column", children: col });
    components.push({ id: cardId, component: "Card", child: colId });
    rootChildren.push(cardId);
  }

  // ---------- repeated groups → templated lists ----------
  const byItem = new Map<string, RepeatCand[]>();
  for (const c of caps) for (const r of c.repeats) (byItem.get(r.itemSel) ?? byItem.set(r.itemSel, []).get(r.itemSel)!).push(r);
  for (const [itemSel, hits] of byItem) {
    if (hits.length !== caps.length) { report.unstable.push(itemSel); continue; }
    const r0 = hits[0];
    const fieldKeys = r0.fields.map((f) => `${f.kind}|${f.sel}`).filter((k) => hits.every((h) => h.fields.some((f) => `${f.kind}|${f.sel}` === k)));
    const dropped = r0.fields.map((f) => `${f.kind}|${f.sel}`).filter((k) => !fieldKeys.includes(k));
    const attrName = /\[(?:data-e2e|data-testid)="([^"]+)"\]/.exec(itemSel)?.[1];
    const base = camel((attrName ?? nameFromSel(itemSel, null, "item")).replace(/[-_]?item$/i, "")) || "item";
    const listName = uniq(base.endsWith("s") ? base : base + "s", usedFields);
    const lf: Record<string, Extractor> = {};
    const used = new Set<string>();
    let key: string | undefined;
    const card: string[] = [];
    const tpl = (s: string) => cid(`${listName}_${s}`);
    for (const k of fieldKeys) {
      const f = r0.fields.find((x) => `${x.kind}|${x.sel}` === k)!;
      const sel = f.sel || undefined;
      if (f.kind === "link") {
        const samples = hits.flatMap((h) => h.fields.find((x) => `${x.kind}|${x.sel}` === k)!.samples);
        if (samples.every((s) => /\d{6,}/.test(s ?? ""))) { key = uniq("id", used); lf[key] = { sel, get: "attr:href", re: "(\\d{6,})" }; }
        lf[uniq("url", used)] = { sel, get: "attr:href", as: "url" } satisfies FieldExtractor;
      } else if (f.kind === "image") {
        const n = uniq(f.sel.match(/Poster|Cover|Thumb/i) ? "cover" : "image", used);
        lf[n] = { sel, get: "src", as: "url" };
        const id = tpl(n);
        components.push({ id, component: "Image", url: { path: n }, variant: "mediumFeature", fit: "cover" });
        card.push(id);
      } else {
        const samples = hits.flatMap((h) => h.fields.find((x) => `${x.kind}|${x.sel}` === k)!.samples);
        const n = uniq(nameFromSel(f.sel, null, "text"), used);
        const count = isCountish(samples);
        lf[n] = count ? { sel, get: "text", as: "count" } : { sel, get: "text" };
        const id = tpl(n);
        components.push({ id, component: "Text", text: count ? { call: "formatNumber", args: { value: { path: n } }, returnType: "string" } : { path: n }, variant: f.font >= 16 ? "body" : "caption" });
        card.push(id);
      }
    }
    if (!key) key = Object.keys(lf).find((k) => k === "url");
    model[`/${listName}`] = { each: itemSel, ...(key ? { key } : {}), fields: lf };
    const singular = listName.replace(/s$/, "");
    const openName = `open${singular[0].toUpperCase()}${singular.slice(1)}`;
    const itemId = tpl("item"), cardId = tpl("card"), colId = tpl("card_col"), listId = tpl("list"), moreId = cid(`${listName}_load_more`), moreLabel = cid(`${listName}_load_more_label`);
    components.push(
      { id: listId, component: "List", direction: "vertical", children: { path: `/${listName}`, componentId: itemId } },
      { id: itemId, component: "Button", variant: "borderless", child: cardId, action: { event: { name: openName, context: key ? { [key]: { path: key } } : {} } } },
      { id: cardId, component: "Card", child: colId },
      { id: colId, component: "Column", children: card },
      { id: moreId, component: "Button", child: moreLabel, action: { event: { name: "loadMore" } } },
      { id: moreLabel, component: "Text", text: "Load more" },
    );
    anchors[itemId] = { model: `/${listName}` };
    anchors[moreId] = { model: `/${listName}` };
    actions[openName] = { op: "click", anchor: itemId, ...(key ? { key } : {}), reveal: "loadMore", intent: `Open the ${singular} tile whose link contains {{${key ?? "url"}}}` };
    actions.loadMore = { op: "scroll", by: "page", intent: `Scroll down so more ${listName} load` };
    const secId = cid(`${listName}_section`);
    components.push({ id: secId, component: "Column", children: [listId, moreId] });
    rootChildren.push(secId);
    report.lists.push({ name: listName, itemSel, count: hits.map((h) => h.count), fields: Object.keys(lf), dropped });
  }

  // ---------- navigation affordance ----------
  const backId = cid("back"), backLabel = cid("back_label");
  components.push({ id: backId, component: "Button", child: backLabel, action: { event: { name: "back" } } }, { id: backLabel, component: "Text", text: "Back" });
  actions.back = { op: "back", intent: "Go back to the previous page" };
  rootChildren.unshift(backId);

  components.unshift({ id: "root", component: "Column", children: rootChildren });
  const firstSel = Object.values(model).map((m: any) => m.each ?? Object.values(m.fields ?? {}).map((f: any) => f.sel).find(Boolean)).find(Boolean);
  const view: ViewSpec = {
    title: caps[0].title,
    match: { path: pathPattern(caps.map((c) => c.url)), ...(firstSel ? { selector: firstSel } : {}) },
    components, model, anchors, actions,
    settle: { quietMs: 300, timeoutMs: 30_000 },
  };
  return { view, report };
}
