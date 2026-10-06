/**
 * Per-item cost estimates for running a manifest on serverless platforms, from a measured benchmark.
 *
 * List prices below are from public pricing pages as last known (see `source`); they change — verify before
 * relying on them. Browser-based platforms bill wall-clock time of a browser-sized instance; Workers/WASM
 * hosts bill CPU time and can only run the browser-free part (JSONata extraction over captured responses):
 * a headless browser cannot run inside WasmEdge/Spin/Workers isolates.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface Bench {
  records: number;
  wallMs: number;
  /** orchestration + extraction (Node: projector, JSONata routes, machine) */
  nodeCpuMs: number;
  /** browser renderer main-thread task time (CDP Performance.TaskDuration) */
  browserCpuMs: number;
  /** bytes received by the page (CDP encodedDataLength) */
  bytes: number;
  /** CPU clock used to convert CPU time to cycles */
  cpuMHz: number;
}

export interface PerItem { wallMs: number; cpuMs: number; extractCpuMs: number; cycles: number; bytes: number }

export function perItem(b: Bench): PerItem {
  const n = Math.max(1, b.records);
  const cpuMs = (b.nodeCpuMs + b.browserCpuMs) / n;
  return { wallMs: b.wallMs / n, cpuMs, extractCpuMs: b.nodeCpuMs / n, cycles: Math.round(cpuMs * 1e-3 * b.cpuMHz * 1e6), bytes: Math.round(b.bytes / n) };
}

interface Platform {
  name: string;
  /** what runs there */
  runs: "browser" | "extract-only";
  /** $ per item given per-item measurements */
  perItem: (p: PerItem) => number;
  /** fixed $ per invocation (requests), amortised over `batch` items per invocation */
  perInvocation?: number;
  batch?: number;
  note: string;
  source: string;
}

const s = (ms: number) => ms / 1000;
export const PLATFORMS: Platform[] = [
  {
    name: "AWS Lambda (x86, 2 GB + Chromium layer)", runs: "browser",
    perItem: (p) => s(p.wallMs) * 2 * 0.0000166667, perInvocation: 0.2 / 1e6, batch: 100,
    note: "$0.0000166667/GB-s, $0.20/1M requests; billed on wall-clock", source: "https://aws.amazon.com/lambda/pricing/",
  },
  {
    name: "Google Cloud Run (2 vCPU, 2 GiB, request-billed)", runs: "browser",
    perItem: (p) => s(p.wallMs) * (2 * 0.000024 + 2 * 0.0000025), perInvocation: 0.4 / 1e6, batch: 100,
    note: "$0.000024/vCPU-s + $0.0000025/GiB-s, $0.40/1M requests", source: "https://cloud.google.com/run/pricing",
  },
  {
    name: "Cloudflare Browser Rendering", runs: "browser",
    perItem: (p) => (s(p.wallMs) / 3600) * 0.09,
    note: "$0.09 per browser-hour beyond the included hours (Workers Paid)", source: "https://developers.cloudflare.com/browser-rendering/platform/pricing/",
  },
  {
    name: "Browserbase (usage)", runs: "browser",
    perItem: (p) => (s(p.wallMs) / 3600) * 0.1,
    note: "≈$0.10 per browser-hour on usage plans (plan-dependent)", source: "https://www.browserbase.com/pricing",
  },
  {
    name: "Cloudflare Workers / WASM (extraction only)", runs: "extract-only",
    perItem: (p) => p.extractCpuMs * (0.02 / 1e6), perInvocation: 0.3 / 1e6, batch: 100,
    note: "$0.02/1M CPU-ms + $0.30/1M requests; JSONata over captured responses, no browser", source: "https://developers.cloudflare.com/workers/platform/pricing/",
  },
  {
    name: "WasmEdge / Spin on a VM (extraction only)", runs: "extract-only",
    perItem: (p) => s(p.extractCpuMs) * (0.0416 / 3600), // ≈ 1 vCPU of a $0.0416/h general-purpose VM, fully utilised
    note: "self-hosted WASM runtime; ≈$0.0416/vCPU-hour VM, CPU-bound", source: "https://wasmedge.org/",
  },
];

export const VOLUMES = [1, 1_000, 100_000, 1_000_000] as const;

export function costTable(b: Bench) {
  const p = perItem(b);
  return PLATFORMS.map((pl) => {
    const unit = pl.perItem(p) + (pl.perInvocation ?? 0) / (pl.batch ?? 1);
    return { platform: pl.name, runs: pl.runs, note: pl.note, source: pl.source, costs: Object.fromEntries(VOLUMES.map((v) => [v, unit * v])) as Record<number, number> };
  });
}

const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toPrecision(2)}` : x < 100 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString("en")}`);

/** Markdown summary: per-item benchmark + cost table. */
export function benchMarkdown(b: Bench, apify = ""): string {
  const p = perItem(b);
  const rows = costTable(b).map((r) => `| ${r.platform} | ${VOLUMES.map((v) => usd(r.costs[v])).join(" | ")} |`).join("\n");
  return `**Benchmark** · ${b.records} records in ${(b.wallMs / 1000).toFixed(1)}s
| per item | wall | CPU (node + browser) | extraction CPU | cycles | bytes |
|---|---|---|---|---|---|
| | ${p.wallMs.toFixed(0)} ms | ${p.cpuMs.toFixed(1)} ms | ${p.extractCpuMs.toFixed(2)} ms | ${(p.cycles / 1e6).toFixed(1)} M | ${(p.bytes / 1024).toFixed(1)} KB |

**Estimated cost** (list prices, verify before use)
| platform | 1 | 1k | 100k | 1M |
|---|---|---|---|---|
${rows}${apify ? `\n${apify}` : ""}`;
}

// ---------------------------------------------------------------- Apify comparison


const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export interface ApifyPrice {
  actor: string; users: number; model: string;
  /** $ per result at the FREE tier and at the best tier */
  perItem: number | null; perItemBest: number | null;
  /** $ per run start (pay-per-event actor-start) */
  perRun: number; monthly: number | null; note: string;
}

/** Pricing of the most-used harvested Apify actors for a site (cached per brand under data/research). */
export async function apifyPrices(brand: string, max = 5): Promise<ApifyPrice[]> {
  const cacheDir = join(ROOT, "data/research"); mkdirSync(cacheDir, { recursive: true });
  const cache = join(cacheDir, `${brand}.apify-prices.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const dir = join(ROOT, "data/apify/categories");
  if (!existsSync(dir)) return [];
  const re = new RegExp(`\\b${brand}\\b`, "i"), seen = new Map<string, ApifyPrice>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for await (const line of createInterface({ input: createReadStream(join(dir, f)), crlfDelay: Infinity })) {
      if (!re.test(line.slice(0, 1500))) continue;
      try {
        const a = JSON.parse(line).actor ?? {};
        const name = `${a.username}/${a.name}`;
        if (seen.has(name) || !re.test(`${a.name} ${a.title}`)) continue;
        seen.set(name, { actor: name, users: a.stats?.totalUsers ?? 0, ...priceOf(a.currentPricingInfo) });
      } catch { /* skip */ }
    }
  }
  const out = [...seen.values()].filter((p) => p.perItem != null || p.monthly != null).sort((x, y) => y.users - x.users).slice(0, max);
  writeFileSync(cache, JSON.stringify(out, null, 1));
  return out;
}

function priceOf(pi: any): Omit<ApifyPrice, "actor" | "users"> {
  const model = pi?.pricingModel ?? "PAY_PER_USAGE";
  if (model === "PAY_PER_EVENT") {
    const ev = Object.values<any>(pi.pricingPerEvent?.actorChargeEvents ?? {});
    const primary = ev.find((e) => e.isPrimaryEvent) ?? ev.find((e) => !e.isOneTimeEvent);
    const tiers = Object.values<any>(primary?.eventTieredPricingUsd ?? {}).map((t) => t.tieredEventPriceUsd).filter((x) => typeof x === "number");
    const start = ev.find((e) => e.isOneTimeEvent);
    const startTiers = Object.values<any>(start?.eventTieredPricingUsd ?? {}).map((t) => t.tieredEventPriceUsd);
    const flat = primary?.eventPriceUsd;
    return { model, perItem: tiers[0] ?? flat ?? null, perItemBest: tiers.length ? Math.min(...tiers) : flat ?? null, perRun: startTiers[0] ?? start?.eventPriceUsd ?? 0, monthly: null, note: `per "${primary?.eventTitle ?? "result"}"` };
  }
  if (model === "PRICE_PER_DATASET_ITEM") {
    const per = (pi.pricePerUnitUsd ?? 0) / (pi.unitName === "1000 results" || /1000/.test(pi.unitName ?? "") ? 1000 : 1);
    return { model, perItem: per, perItemBest: per, perRun: 0, monthly: null, note: `per ${pi.unitName ?? "result"}` };
  }
  if (model === "FLAT_PRICE_PER_MONTH") return { model, perItem: null, perItemBest: null, perRun: 0, monthly: pi.pricePerUnitUsd ?? null, note: "monthly rental + platform usage" };
  return { model, perItem: null, perItemBest: null, perRun: 0, monthly: null, note: "platform usage (compute units)" };
}

/** Markdown rows for the Apify comparison at the standard volumes (runs of 1k items for the start fee). */
export function apifyRows(prices: ApifyPrice[]): string {
  return prices.filter((p) => p.perItem != null).map((p) => {
    const at = (v: number) => p.perItem! * v + p.perRun * Math.max(1, Math.ceil(v / 1000));
    return `| Apify ${p.actor} (${p.note}${p.perItemBest !== p.perItem ? `, best tier $${p.perItemBest}` : ""}) | ${VOLUMES.map((v) => usdFmt(at(v))).join(" | ")} |`;
  }).join("\n");
}
const usdFmt = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toPrecision(2)}` : x < 100 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString("en")}`);
