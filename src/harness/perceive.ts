/**
 * Lane M — the "multimodal browser-use" baseline. It never uses manifest selectors or the
 * projector: it perceives the page as geometry + visible text + image sources + pixels, and acts
 * with raw pointer/wheel input at coordinates, guided only by the action's intent and context
 * values. Agreement between this lane and the A2UI lane is what the side-by-side test measures.
 */
import type { BrowserAdapter } from "../adapters/types.js";
import type { ActionMap } from "../manifest/types.js";
import { inpageRuntime } from "../render/projector.js";
import { settleDom } from "../derive/capture.js";

export interface VisEl { i: number; tag: string; parent: number; rect: [number, number, number, number]; text: string; attrs: Record<string, string> }
export interface Visual { url: string; viewport: [number, number]; scroll: [number, number]; elements: VisEl[] }

const COUNT = /^([\d.,]+)\s*([KMB])?$/i;
export function parseCount(s: string): number | null {
  const m = COUNT.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[(m[2] ?? "").toUpperCase()] || n);
}
export const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Everything a vision+DOM agent can "see": text corpus, numbers, image sources, link targets. */
export class Percept {
  readonly corpus: string;
  readonly numbers = new Set<number>();
  readonly images = new Set<string>();
  readonly hrefs = new Set<string>();
  constructor(readonly v: Visual) {
    const texts: string[] = [];
    for (const e of v.elements) {
      if (e.text) {
        texts.push(e.text);
        const n = parseCount(e.text);
        if (n != null) this.numbers.add(n);
      }
      const src = e.attrs.currentSrc ?? e.attrs.src;
      if (src) this.images.add(pathKey(src, v.url));
      if (e.attrs.href) this.hrefs.add(new URL(e.attrs.href, v.url).href);
    }
    this.corpus = norm(texts.join(" "));
  }
  /** Is `value` visibly present on the page (in any modality)? */
  sees(value: unknown): boolean {
    if (value == null || value === "") return true;
    if (typeof value === "number") return this.numbers.has(value) || this.corpus.includes(String(value));
    const s = String(value);
    if (/^(https?:|\/)/.test(s)) {
      const k = pathKey(s, this.v.url);
      return this.images.has(k) || [...this.hrefs].some((h) => pathKey(h, this.v.url) === k);
    }
    if (/^data:image\//.test(s)) return true; // canvas frames are pixels — compared visually, not textually
    return this.corpus.includes(norm(s));
  }
}
const pathKey = (u: string, base: string) => { try { const x = new URL(u, base); return x.pathname + x.search; } catch { return u; } };

export class MultimodalLane {
  constructor(readonly adapter: BrowserAdapter) {}

  async init() { await this.adapter.addInitScript(inpageRuntime()); }

  async look(): Promise<Percept> {
    const v = await this.adapter.evaluate<Visual>("window.__a2flow.visual({ selectors: false, canvas: false, max: 4000 })");
    return new Percept(v);
  }

  async goto(url: string) { await this.adapter.goto(url); await settleDom(this.adapter, 400, 10_000); }

  async path(): Promise<string> { return this.adapter.evaluate<string>("location.pathname"); }

  async waitPath(pathname: string, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if ((await this.path().catch(() => "")) === pathname) { await settleDom(this.adapter, 400, 8000); return true; }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * Do what the A2UI lane did, from perception alone. Click targets are found by looking for a
   * visible link/element that carries one of the action's context values (e.g. the video id in
   * an href, a label text); if absent we scroll (as a person would) and look again.
   */
  async perform(am: ActionMap, ctx: Record<string, unknown>): Promise<string> {
    const a = this.adapter;
    if (am.op === "back") { await a.back(); return "history back"; }
    if (am.op === "press") { await a.press(am.text ?? "Enter"); return `press ${am.text}`; }
    if (am.op === "scroll") {
      const [vw, vh] = await a.evaluate<[number, number]>("[innerWidth, innerHeight]");
      await a.wheel(typeof am.by === "number" ? am.by : Math.round(vh * 0.9), { x: Math.round(vw / 2), y: Math.round(vh * 0.6) });
      await new Promise((r) => setTimeout(r, 250));
      return "wheel one viewport";
    }
    if (am.op === "click") {
      const tokens = Object.values(ctx).filter((x) => (typeof x === "string" || typeof x === "number") && String(x).length >= 3).map(String);
      const words = tokens.length ? [] : (am.intent.toLowerCase().match(/\b(close|exit|back|next|more|search|submit|open)\b/g) ?? []);
      for (let attempt = 0; attempt <= (am.revealMax ?? 8); attempt++) {
        const p = await this.look();
        const target = findTarget(p.v, tokens, words);
        if (target) {
          const [x, y, w, h] = target.rect;
          const [sx, sy] = p.v.scroll;
          const [, vh] = p.v.viewport;
          let cy = y - sy + h / 2;
          if (cy < 0 || cy > vh) { // bring into view with the wheel, then re-perceive
            await a.wheel(Math.round(cy - vh / 2), { x: Math.round(p.v.viewport[0] / 2), y: Math.round(vh / 2) });
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          await a.mouseClick(Math.round(x - sx + w / 2), Math.round(cy));
          return `click <${target.tag}> at (${Math.round(x - sx + w / 2)},${Math.round(cy)}) matching ${tokens.join(",") || words.join(",")}`;
        }
        const vh = p.v.viewport[1];
        await a.wheel(Math.round(vh * 0.9), { x: Math.round(p.v.viewport[0] / 2), y: Math.round(vh * 0.6) });
        await settleDom(a, 400, 4000);
      }
      throw new Error(`lane M could not perceive a target for "${am.intent}" (${tokens.join(",")})`);
    }
    if (am.op === "navigate" && am.url) { await a.goto(new URL(am.url, await a.url()).href); return `goto ${am.url}`; }
    return `noop ${am.op}`;
  }
}

/** Smallest visible clickable element whose href/label/text carries a token. */
export function findTarget(v: Visual, tokens: string[], words: string[]): VisEl | undefined {
  const hit = (e: VisEl) => {
    const hay = [e.attrs.href, e.attrs["aria-label"], e.attrs.title, e.text].filter(Boolean).join(" ").toLowerCase();
    return tokens.length ? tokens.some((t) => hay.includes(t.toLowerCase())) : words.some((w) => hay.includes(w));
  };
  const clickable = (e: VisEl) => ["a", "button"].includes(e.tag) || e.attrs.role === "button";
  return v.elements.filter((e) => clickable(e) && hit(e) && e.rect[2] > 4 && e.rect[3] > 4)
    .sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3])[0];
}
