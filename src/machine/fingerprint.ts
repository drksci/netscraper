/**
 * Structural page fingerprints via @iocium/domhash (SimHash over the canonical structure + a shape
 * vector). Used three ways: frozen per view at derive time (`views.<id>.fingerprint`), checked at
 * runtime for drift on every `view.await`, and recorded in fault bundles for the authoring pass.
 * Repetition counts are normalised ("div*24" → "div*") so a longer feed is not "drift".
 */
import { createRequire } from "node:module";
// the package's ESM build does a dynamic require("crypto") that Node ESM rejects — use the CJS build
const { compareShapeCosine, domhash, getStructuralDiff } = createRequire(import.meta.url)("@iocium/domhash") as typeof import("@iocium/domhash");
import type { BrowserAdapter } from "../adapters/types.js";

/**
 * `shape`: DOM structure tokens (domhash structureTree); `ax`: accessibility-tree role structure
 * (CDP Accessibility.getFullAXTree) — roles/landmarks survive wrapper-div and CSS refactors.
 */
export interface Fingerprint { simhash: string; shape: string[]; ax?: string[]; minSimilarity?: number }

const AX_SKIP = new Set(["generic", "none", "presentation", "InlineTextBox", "StaticText", "LineBreak", "ignored", "LayoutTable", "LayoutTableRow", "LayoutTableCell"]);

/** Preorder `depth:role` tokens of the AX tree; skipped roles don't add depth; repeated sibling subtrees collapse. */
export async function axTokens(a: BrowserAdapter): Promise<string[]> {
  const { nodes } = await a.cdp<{ nodes: any[] }>("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const sig = (n: any, depth: number): string[] => {
    const role = n.role?.value ?? "unknown";
    const keep = !n.ignored && !AX_SKIP.has(role);
    const out: string[] = keep ? [`${depth}:${role}`] : [];
    let prev = "";
    for (const id of n.childIds ?? []) {
      const c = byId.get(id);
      if (!c) continue;
      const sub = sig(c, keep ? depth + 1 : depth);
      const key = sub.join("|");
      if (key && key === prev) continue; // repeated sibling subtree (list items, grid tiles)
      prev = key;
      out.push(...sub);
    }
    return out;
  };
  return root ? sig(root, 0) : [];
}

/** Body HTML minus scripts/styles/svg internals and our own annotation nodes. */
export async function pageStructureHtml(a: BrowserAdapter): Promise<string> {
  const html = await a.evaluate<string>(`(() => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll("script,style,noscript,template,svg *,.__a2flow_ann,[data-a2flow-hit]").forEach((e) => e.tagName === "SVG" ? null : e.remove());
    return c.innerHTML; })()`); // domhash wraps fragments in html/head/body itself
  return html;
}

export function normaliseShape(shape: string[] = []): string[] {
  return shape.map((s) => s.replace(/\*\d+$/, "*"));
}

/** Preorder `depth:tag` tokens of domhash's structureTree; repeated sibling subtrees appear once. */
function treeTokens(n: any, depth = 0, out: string[] = []): string[] {
  if (!n) return out;
  out.push(`${depth}:${n.tag}`);
  for (const c of n.children ?? []) treeTokens(c, depth + 1, out);
  return out;
}

export async function fingerprintHtml(html: string): Promise<Fingerprint> {
  const r: any = await domhash(html, { algorithm: "simhash", includeDataAndAriaAttributes: true, shapeVector: true });
  // structureTree collapses repeated subtrees (a 12-tile grid ≈ a 40-tile grid ≈ structurally one tile)
  return { simhash: r.hash, shape: r.structureTree ? treeTokens(r.structureTree) : normaliseShape(r.shape) };
}

/** Grab the raw inputs now (cheap, must happen while the page is in the state of interest)… */
export async function capturePage(a: BrowserAdapter): Promise<{ html: string; ax?: string[] }> {
  const [html, ax] = await Promise.all([pageStructureHtml(a), axTokens(a).catch(() => undefined)]);
  return { html, ax };
}
/** …and hash them later, off the critical path. */
export async function fingerprintCaptured(c: { html: string; ax?: string[] }): Promise<Fingerprint> {
  const fp = await fingerprintHtml(c.html);
  return c.ax?.length ? { ...fp, ax: c.ax } : fp;
}
export async function fingerprintPage(a: BrowserAdapter): Promise<Fingerprint> {
  return fingerprintCaptured(await capturePage(a));
}

export function similarityParts(expected: Fingerprint, observed: Fingerprint): { dom: number; ax?: number; combined: number } {
  const dom = compareShapeCosine(normaliseShape(expected.shape), normaliseShape(observed.shape));
  const ax = expected.ax?.length && observed.ax?.length ? compareShapeCosine(expected.ax, observed.ax) : undefined;
  return { dom, ax, combined: ax === undefined ? dom : (dom + ax) / 2 };
}

/** Blend of DOM-structure and AX-role-structure similarity (AX omitted when either side lacks it). */
export function similarity(expected: Fingerprint, observed: Fingerprint): number {
  return similarityParts(expected, observed).combined;
}

export function structuralDiff(expected: Fingerprint, observed: Fingerprint, max = 40): string[] {
  return getStructuralDiff(normaliseShape(expected.shape).join("\n"), normaliseShape(observed.shape).join("\n")).slice(0, max);
}
