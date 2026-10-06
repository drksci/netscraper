"use client";

import { ChevronRightIcon, DownloadIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { bytes, ms } from "@/lib/format";
import { useSession, type ApifyRow, type CostRow } from "@/lib/session-store";
import { setUI, useUI } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { Retro } from "./retro";


/** The manifest as a file: name, size, records, download, JSON preview, and the way to run it as an actor. */
export function ArtifactCard() {
  const artifact = useSession((s) => s.production.artifact);
  const doc = useSession((s) => s.manifest?.doc);
  const actorOpen = useUI((u) => u.actorOpen);
  const [preview, setPreview] = useState(false);
  if (!artifact) return null;
  return (
    <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border bg-card animate-in fade-in duration-500">
      {/* one row: icon · name · size · records · preview · download · actor */}
      <div className="flex h-8 items-center gap-2 px-2 text-[11px] whitespace-nowrap">
        <Retro name="manifest" />
        <button type="button" onClick={() => setPreview((p) => !p)} title="Preview JSON" className="flex min-w-0 items-center gap-1 font-mono font-medium outline-none hover:underline">
          <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", preview && "rotate-90")} />
          <span className="truncate">{artifact.name}</span>
        </button>
        <span className="shrink-0 text-muted-foreground tabular-nums">{bytes(artifact.bytes)} · {artifact.records} rec</span>
        <span className="ml-auto" />
        <Button variant="ghost" size="icon-xs" render={<a href={artifact.url} download={artifact.name} />} nativeButton={false} aria-label="Download" title="Download">
          <DownloadIcon />
        </Button>
        <Button variant={actorOpen ? "secondary" : "ghost"} size="xs" className="h-6 text-[11px]" onClick={() => setUI({ actorOpen: !actorOpen })} title={actorOpen ? "Close the actor" : "Run as actor"}>
          <TerminalIcon data-icon="inline-start" />
          actor
        </Button>
      </div>
      {preview && (
        <pre className="max-h-72 overflow-auto border-t bg-muted/50 px-2.5 py-1.5 font-mono text-[10px] leading-[14px] text-muted-foreground">
          {doc ? JSON.stringify(doc, null, 2) : "Download to view."}
        </pre>
      )}
    </div>
  );
}

/** Per-item benchmark of the scale run: one dense row. */
export function BenchCard() {
  const report = useSession((s) => s.production.report);
  if (!report) return null;
  const { bench: b, perItem: p } = report;
  const cells: [string, string, string?][] = [
    ["wall", ms(p.wallMs)],
    ["cpu", ms(p.cpuMs), `extraction ${ms(p.extractCpuMs)}`],
    ["cycles", `${(p.cycles / 1e6).toFixed(1)}M`, `at ${(b.cpuMHz / 1000).toFixed(1)} GHz`],
    ["transfer", bytes(p.bytes)],
  ];
  return (
    <div className="flex h-7 w-full max-w-xl items-center gap-3 overflow-hidden rounded-lg border bg-card px-2 text-[11px] whitespace-nowrap animate-in fade-in duration-500">
      <Retro name="bench" />
      <span className="text-muted-foreground">per item</span>
      {cells.map(([k, v, tip]) => (
        <span key={k} title={tip} className="flex items-baseline gap-1 tabular-nums">
          <span className="text-muted-foreground">{k}</span>
          <span className="font-medium">{v}</span>
        </span>
      ))}
      <span className="ml-auto truncate text-muted-foreground tabular-nums">{b.records} in {ms(b.wallMs)}</span>
    </div>
  );
}

const VOLS = [1_000, 100_000, 1_000_000] as const;
const VOL: Record<number, string> = { 1000: "1k", 100000: "100k", 1000000: "1M" };

/** $0.53 · $5.26 · $53 · $3.7k · $1.2M — one rule everywhere */
function money(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  if (x === 0) return "$0";
  if (x < 0.01) return `$${x.toPrecision(1)}`;
  if (x < 100) return `$${x.toFixed(2)}`;
  if (x < 1000) return `$${Math.round(x)}`;
  return `$${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(x).toLowerCase()}`;
}

/** abbreviated platform names; the full name and pricing note live in the tooltip */
function shortPlatform(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("lambda")) return `Lambda ${/(\d+)\s*gb/i.exec(name)?.[1] ?? 2}GB`;
  if (n.includes("cloud run")) return "Cloud Run";
  if (n.includes("browser rendering")) return "CF Browser";
  if (n.includes("browserbase")) return "Browserbase";
  if (n.includes("workers")) return "Workers (extract)";
  if (n.includes("wasmedge") || n.includes("spin")) return "WasmEdge (extract)";
  return name.replace(/\s*\(.*\)$/, "");
}

/** Apify: per result × volume, plus the start fee once per 1k-item run. */
const apifyAt = (a: ApifyRow, v: number) => (a.perItem == null ? null : a.perItem * v + a.perRun * Math.max(1, Math.ceil(v / 1000)));

function Row({ name, tip, href, get, dim }: { name: string; tip: string; href: string; get: (v: number) => number | null; dim?: boolean }) {
  return (
    <tr className="border-t border-border/50">
      <td className="max-w-0 py-[3px] pr-2 pl-3">
        <a href={href} target="_blank" rel="noreferrer" title={tip} className={cn("block truncate hover:text-foreground hover:underline", dim && "text-muted-foreground")}>{name}</a>
      </td>
      {VOLS.map((v) => <td key={v} className="py-[3px] pr-3 text-right font-mono tabular-nums">{money(get(v))}</td>)}
    </tr>
  );
}

/** Estimated cost per volume: serverless platforms from the benchmark, then the site's Apify actors. */
export function CostCard() {
  const report = useSession((s) => s.production.report);
  if (!report) return null;
  const apify = report.apify.filter((a) => a.perItem != null);
  return (
    <div className="w-full max-w-xl overflow-hidden rounded-lg border bg-card text-[11px] whitespace-nowrap animate-in fade-in duration-500">
      <table className="w-full table-fixed">
        <colgroup><col /><col className="w-16" /><col className="w-16" /><col className="w-16" /></colgroup>
        <thead>
          <tr className="text-[10px] text-muted-foreground">
            <th className="py-1 pl-3 text-left font-normal" title="Estimated from the measured benchmark and public list prices; verify before relying on them">
              cost · list prices, verify
            </th>
            {VOLS.map((v) => <th key={v} className="py-1 pr-3 text-right font-normal">{VOL[v]}</th>)}
          </tr>
        </thead>
        <tbody>
          {report.costs.map((r: CostRow) => (
            <Row key={r.platform} name={shortPlatform(r.platform)} href={r.source} dim={r.runs === "extract-only"}
              tip={`${r.platform}\n${r.note}${r.runs === "extract-only" ? "\nextraction only: JSONata over captured responses, no browser" : "\nbilled on wall-clock time"}`}
              get={(v) => r.costs[String(v)] ?? null} />
          ))}
          {apify.map((a) => (
            <Row key={a.actor} name={`Apify ${a.actor}`} href={`https://apify.com/${a.actor}`}
              tip={`${a.note} · ${money(a.perItem)}/result${a.perItemBest != null && a.perItemBest !== a.perItem ? ` (best tier ${money(a.perItemBest)})` : ""}${a.perRun ? ` + ${money(a.perRun)} per run start (per 1k-item run)` : ""} · ${a.users.toLocaleString("en")} users`}
              get={(v) => apifyAt(a, v)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everything after a scale run, in the chat flow. */
export function ProductionCards() {
  const has = useSession((s) => !!s.production.artifact || !!s.production.report);
  if (!has) return null;
  return (
    <div className="flex flex-col gap-1.5 py-0.5">
      <ArtifactCard />
      <BenchCard />
      <CostCard />
    </div>
  );
}
