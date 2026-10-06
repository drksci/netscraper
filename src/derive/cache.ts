/**
 * Inference cache for the multimodal (screenshot + canvas) interpretation step.
 *
 * Key   = sha256 of the derived view's *structure* (component ids/types, bindings, selectors,
 *         actions) — never sample values — so the same layout with new data is a hit.
 * Check = 64-bit dHash of the annotated screenshot and each canvas frame. Same structure but a
 *         large perceptual distance → "visual-drift": the patch is reused (it only binds to
 *         structure) but the drift is reported so a human/agent can re-review the images.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { ViewSpec } from "../manifest/types.js";
import type { RefinePatch } from "./refine.js";

export const DEFAULT_CACHE_DIR = ".a2flow-cache/inference";
const DRIFT_BITS = 12; // of 64

export interface InferenceEntry {
  key: string;
  viewId: string;
  source: "agent" | "sdk" | "cli";
  createdAt: string;
  patch: RefinePatch;
  fingerprints: { annotated: string; canvases: string[] };
}
export type Lookup =
  | { status: "hit"; entry: InferenceEntry; distance: number }
  | { status: "visual-drift"; entry: InferenceEntry; distance: number }
  | { status: "miss"; key: string };

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`
  : JSON.stringify(v);

/** Structure-only key: match/model/anchors/actions/components minus titles and intents. */
export function structureKey(viewId: string, v: ViewSpec): string {
  const actions = Object.fromEntries(Object.entries(v.actions).map(([k, a]) => [k, { ...a, intent: undefined }]));
  // fingerprint excluded: it is evidence about the page, not part of the derived structure
  return createHash("sha256").update(stable({ viewId, match: v.match, model: v.model, anchors: v.anchors, actions, components: v.components })).digest("hex").slice(0, 32);
}

/** dHash: 9x8 grayscale downsample, compare horizontal neighbours → 64 bits (hex). */
export function dhash(img: Buffer): string {
  let w: number, h: number, data: Uint8Array;
  if (img[0] === 0x89 && img[1] === 0x50) ({ width: w, height: h, data } = PNG.sync.read(img));
  else ({ width: w, height: h, data } = jpeg.decode(img, { useTArray: true, maxMemoryUsageInMB: 1024 }));
  const gray = (x: number, y: number) => { const i = (y * w + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  const cell = (cx: number, cy: number) => { // box-average one cell of the 9x8 grid
    const x0 = Math.floor((cx * w) / 9), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / 9));
    const y0 = Math.floor((cy * h) / 8), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / 8));
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += Math.max(1, (y1 - y0) >> 3)) for (let x = x0; x < x1; x += Math.max(1, (x1 - x0) >> 3)) { s += gray(x, y); n++; }
    return s / n;
  };
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (cell(x, y) < cell(x + 1, y) ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}
export function hamming(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export class InferenceCache {
  constructor(readonly dir = DEFAULT_CACHE_DIR) { mkdirSync(dir, { recursive: true }); }
  private file(key: string) { return join(this.dir, `${key}.json`); }

  lookup(viewId: string, view: ViewSpec, annotated: Buffer, canvases: Buffer[] = []): Lookup {
    const key = structureKey(viewId, view);
    if (!existsSync(this.file(key))) return { status: "miss", key };
    const entry = JSON.parse(readFileSync(this.file(key), "utf8")) as InferenceEntry;
    const fps = [dhash(annotated), ...canvases.map(dhash)];
    const prev = [entry.fingerprints.annotated, ...entry.fingerprints.canvases];
    const distance = Math.max(...fps.map((f, i) => (prev[i] ? hamming(f, prev[i]) : 0)));
    return { status: distance > DRIFT_BITS ? "visual-drift" : "hit", entry, distance };
  }

  put(viewId: string, view: ViewSpec, patch: RefinePatch, source: InferenceEntry["source"], annotated: Buffer, canvases: Buffer[] = []): InferenceEntry {
    const entry: InferenceEntry = {
      key: structureKey(viewId, view), viewId, source, createdAt: new Date().toISOString(), patch,
      fingerprints: { annotated: dhash(annotated), canvases: canvases.map(dhash) },
    };
    writeFileSync(this.file(entry.key), JSON.stringify(entry, null, 2));
    return entry;
  }
}
