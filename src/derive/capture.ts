/**
 * Multimodal capture of one page state: DOM structure (visual element list, repeated groups,
 * salient fields with stable selectors) + pixels (viewport screenshot, canvas/video frames).
 */
import type { BrowserAdapter } from "../adapters/types.js";

export interface RepeatField { kind: "text" | "image" | "link"; sel: string; hits: number; samples: string[]; font: number }
export interface RepeatCand { parentSel: string; itemSel: string; sig: string; count: number; area: number; rect: number[]; fields: RepeatField[] }
export interface SingleCand {
  sel: string; all: boolean; tag: string; kind: "text" | "image" | "canvas";
  text: string | string[]; src: string | null; href: string | null; font: number; round: boolean; rect: number[]; attr: string | null;
}
export interface Capture {
  url: string;
  title: string;
  screenshot: Buffer;
  canvases: { tag: string; sel: string; rect: number[]; dataUrl: string | null }[];
  repeats: RepeatCand[];
  singletons: SingleCand[];
  elementCount: number;
}

/** Wait until the visible element count stops changing (SPA hydration, lazy content). */
export async function settleDom(a: BrowserAdapter, quietMs = 800, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  let last = -1, since = Date.now();
  while (Date.now() < end) {
    const n = await a.evaluate<number>("document.readyState === 'complete' ? document.querySelectorAll('body *').length : -1").catch(() => -1);
    if (n !== last) { last = n; since = Date.now(); }
    else if (n > 0 && Date.now() - since >= quietMs) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function capture(a: BrowserAdapter, url: string | null, opts: { minRepeat?: number } = {}): Promise<Capture> {
  if (url) await a.goto(url);
  await settleDom(a);
  const repeats = (await a.evaluate<RepeatCand[]>(`window.__a2flow.repeats(${opts.minRepeat ?? 3})`))
    .filter((r) => r.fields.some((f) => f.kind === "image" || f.kind === "link"));
  // A list is "primary" if it is not contained in another primary list's items.
  const lists = repeats.filter((r, i) => !repeats.slice(0, i).some((o) => r.itemSel !== o.itemSel && r.parentSel.includes(o.itemSel)));
  const singletons = await a.evaluate<SingleCand[]>(`window.__a2flow.singletons(${JSON.stringify(lists.map((l) => l.itemSel))})`);
  const vis = await a.evaluate<any>("window.__a2flow.visual({ selectors: false })");
  return {
    url: vis.url, title: vis.title,
    screenshot: await a.screenshot(),
    canvases: vis.canvases,
    repeats: lists,
    singletons,
    elementCount: vis.elements.length,
  };
}
