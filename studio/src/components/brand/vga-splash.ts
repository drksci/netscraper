/**
 * Netscraper splash, Sierra-style: black, one warm yellow, a horizontally striped circle with the Brisbane
 * skyline (Infinity, 1 William St, Riparian Plaza, the Story Bridge) cut out of it, and a serif wordmark.
 * Drawn pixel-by-pixel into a 320×200 buffer (mode 13h) with hard edges — no antialiasing.
 * Pure: `drawVgaSplash(ctx, t, opts)` paints one frame at time t (seconds).
 */
export const W = 320, H = 200;

type RGB = [number, number, number];
const INK: RGB = [255, 221, 51];   // the one colour (≈ VGA DAC 63,54,12)
const DIM: RGB = [120, 100, 20];
const BLACK: RGB = [0, 0, 0];

// emblem geometry
const CX = 66, CY = 88, R = 36;

/** Skyline cut out of the emblem, in emblem-local coords (x from CX-R, y = height above the waterline). */
function skylineHeight(x: number): number {
  const u = x - (CX - R); // 0..2R
  const towers: [number, number, number, string][] = [
    // [start, width, height, style]
    [8, 5, 16, "flat"], [14, 6, 24, "step"],     // Riparian Plaza (stepped crown)
    [21, 5, 20, "flat"], [27, 7, 34, "wedge"],   // 1 William St (slanted)
    [35, 5, 27, "flat"], [41, 6, 40, "spire"],   // Infinity (spire)
    [48, 5, 28, "flat"], [54, 5, 22, "step"],
  ];
  let h = 0;
  for (const [s, w, th, style] of towers) {
    if (u <= s || u >= s + w) continue; // 1px gap between towers keeps them legible
    const f = (u - s) / Math.max(1, w - 1);
    const v = style === "wedge" ? th - Math.round(f * 7)
      : style === "step" ? th - (f < 0.2 || f > 0.8 ? 4 : 0)
      : style === "spire" ? (Math.abs(f - 0.5) < 0.15 ? th + 10 : th)
      : th;
    h = Math.max(h, v);
  }
  return h;
}

export function drawVgaSplash(ctx: CanvasRenderingContext2D, t = 0, opts: { status?: string; progress?: number; showStatus?: boolean } = {}) {
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const put = (x: number, y: number, c: RGB) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; };
  for (let i = 0; i < W * H; i++) px[i * 4 + 3] = 255; // black

  // emblem: horizontal stripes inside the circle, getting thicker toward the bottom (Sierra's sunset lines)
  const water = CY + 12; // waterline inside the emblem
  for (let y = CY - R; y <= CY + R; y++) {
    const v = (y - (CY - R)) / (2 * R);           // 0 top → 1 bottom
    const period = 5;
    const thick = Math.max(1, Math.round(1 + v * 3.2));
    const on = ((y - (CY - R)) % period) < thick || v < 0.42; // solid sky-cap, then lines
    if (!on) continue;
    for (let x = CX - R; x <= CX + R; x++) {
      if ((x - CX) ** 2 + (y - CY) ** 2 > R * R) continue;
      // skyline + bridge cut out above the waterline
      const above = water - y;
      if (above >= 0 && above < skylineHeight(x)) continue;
      if (storyBridge(x, y, water)) continue;
      put(x, y, INK);
    }
  }

  // wordmark: serif caps, hard-edged, + ®
  stamp(textMask("NETSCRAPER", "27px 'Times New Roman', Georgia, 'Book Antiqua', serif", 112, 98), put, INK);
  stamp(textMask("®", "9px 'Times New Roman', Georgia, serif", 296, 80), put, INK);

  if (opts.showStatus !== false) {
    bitmapText((opts.status ?? "LOADING ACTOR") + (Math.floor(t * 2) % 2 ? "_" : " "), 160, 166, DIM, put);
    const p = opts.progress ?? (t * 0.35) % 1, bx = 120, by = 178, bw = 80;
    for (let x = 0; x < bw; x++) put(bx + x, by, DIM);
    for (let x = 0; x < Math.floor(bw * p); x++) { put(bx + x, by, INK); put(bx + x, by + 1, INK); }
  }
  ctx.putImageData(img, 0, 0);
}

/** Story Bridge as a cut: deck line + cantilever top chord + two towers, in the emblem's lower right. */
function storyBridge(x: number, y: number, water: number): boolean {
  // lower-right of the emblem: two towers, a cantilever top chord dipping between them, deck, hangers
  const x0 = CX + 2, x1 = CX + R;
  if (x < x0 || x > x1 || y > water) return false;
  const deck = water - 5;
  const towers = [CX + 12, CX + 27];
  if (y === deck || y === deck + 1) return true;
  if (towers.some((tx) => (x === tx || x === tx + 1) && y >= deck - 13)) return true;
  const d = Math.min(...towers.map((tx) => Math.abs(x - tx)));
  const chord = deck - 13 + Math.round(Math.min(10, d * 0.75));
  if (y === chord) return true;
  return x % 3 === 0 && y > chord && y < deck; // truss hangers
}

interface Mask { on: Uint8Array; top: number; bottom: number }

/** Render text (left at x, baseline y) and threshold alpha into a hard 1-bit mask. */
function textMask(text: string, font: string, x: number, baseline: number): Mask {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.font = font; g.textBaseline = "alphabetic"; g.fillStyle = "#fff";
  try { (g as any).letterSpacing = "1px"; } catch { /* older canvas */ }
  g.fillText(text, x, baseline);
  const a = g.getImageData(0, 0, W, H).data;
  const on = new Uint8Array(W * H);
  let top = H, bottom = 0;
  for (let i = 0; i < W * H; i++) if (a[i * 4 + 3] > 120) { on[i] = 1; const y = (i / W) | 0; top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { on, top, bottom };
}
function stamp(m: Mask, put: (x: number, y: number, c: RGB) => void, c: RGB) {
  for (let i = 0; i < W * H; i++) if (m.on[i]) put(i % W, (i / W) | 0, c);
}

// --- 5×7 bitmap font (uppercase, digits, a little punctuation), like a DOS/BIOS ROM font ---
const FONT: Record<string, string> = {
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110", C: "01110100011000010000100001000101110",
  D: "11100100101000110001100011001011100", E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001", I: "01110001000010000100001000010001110",
  J: "00111000100001000010000101001001100", K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001", N: "10001100011100110101100111000110001", O: "01110100011000110001100011000101110",
  P: "11110100011000111110100001000010000", Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100", U: "10001100011000110001100011000101110",
  V: "10001100011000110001100010101000100", W: "10001100011000110101101011010101010", X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111",
  "0": "01110100011001110101110011000101110", "1": "00100011000010000100001000010001110", "2": "01110100010000100010001000100011111",
  "3": "11111000100010000010000011000101110", "4": "00010001100101010010111110001000010", "5": "11111100001111000001000011000101110",
  "6": "00110010001000011110100011000101110", "7": "11111000010001000100010000100001000", "8": "01110100011000101110100011000101110",
  "9": "01110100011000101111000010001001100", ".": "00000000000000000000000000110001100", "_": "00000000000000000000000000000011111",
  "-": "00000000000000011111000000000000000", ":": "00000011000110000000011000110000000", "/": "00001000010001000100010001000010000",
  "%": "11000110010001000100010001001100011", "(": "00010001000100001000010000010000010", ")": "01000001000001000010000100010001000",
  "+": "00000001000010011111001000010000000", " ": "00000000000000000000000000000000000",
};
/** Draw `text` centred at (cx, top) in the 5×7 font with 1px spacing. */
export function bitmapText(text: string, cx: number, top: number, color: RGB, put: (x: number, y: number, c: RGB) => void) {
  const chars = [...text.toUpperCase()];
  let x = Math.round(cx - (chars.length * 6 - 1) / 2);
  for (const ch of chars) {
    const g = FONT[ch] ?? FONT[" "];
    for (let i = 0; i < 35; i++) if (g[i] === "1") put(x + (i % 5), top + Math.floor(i / 5), color);
    x += 6;
  }
}
