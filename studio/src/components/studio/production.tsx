"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cell, clock } from "@/lib/format";
import { useSession, type LiveRecord } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { MachineView } from "./machine-view";
import { Hourglass, Retro } from "./retro";

const ROW_H = 26;
const VIRTUAL_OVER = 200;
const MAX_COLS = 9;

/** Columns: top-level keys of the first records, in first-seen order (route first when there are several). */
function useColumns(records: LiveRecord[]) {
  const head = records.slice(0, 8);
  const sig = head.map((r) => `${r.route}:${Object.keys(r.item).join(",")}`).join("|");
  return useMemo(() => {
    const keys: string[] = [];
    for (const r of head) for (const k of Object.keys(r.item)) if (!keys.includes(k)) keys.push(k);
    const routes = new Set(head.map((r) => r.route));
    return { keys: keys.slice(0, MAX_COLS), more: Math.max(0, keys.length - MAX_COLS), multiRoute: routes.size > 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

const isNumeric = (v: unknown) => typeof v === "number";

const Row = memo(function Row({ r, keys, multiRoute, fresh, top }: { r: LiveRecord; keys: string[]; multiRoute: boolean; fresh: boolean; top?: number }) {
  return (
    <tr
      className={cn("border-b border-border/60 hover:bg-muted/50", fresh && "animate-in fade-in slide-in-from-top-1 duration-300")}
      style={top != null ? { position: "absolute", top, left: 0, right: 0, display: "table", tableLayout: "fixed", width: "100%" } : { height: ROW_H }}
    >
      <td className="w-12 px-3 text-right text-muted-foreground/60 tabular-nums">{r.n}</td>
      {multiRoute && <td className="truncate px-2 text-muted-foreground">{r.route}</td>}
      {keys.map((k) => (
        <td key={k} title={typeof r.item[k] === "object" ? JSON.stringify(r.item[k]) : String(r.item[k] ?? "")} className={cn("truncate px-2", isNumeric(r.item[k]) && "text-right tabular-nums")} style={{ height: ROW_H }}>
          {cell(r.item[k])}
        </td>
      ))}
    </tr>
  );
});

/** Live records, newest first. Above 200 rows only the visible window renders (fixed row height). */
export function RecordsTable({ className }: { className?: string }) {
  const records = useSession((s) => s.production.records);
  const { keys, more, multiRoute } = useColumns(records);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 400 });
  const seen = useRef(0);
  const freshFrom = seen.current;
  useEffect(() => { seen.current = records.length ? records[records.length - 1].n : 0; }, [records]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => [...records].reverse(), [records]);
  const virtual = rows.length > VIRTUAL_OVER;
  const first = virtual ? Math.max(0, Math.floor(view.top / ROW_H) - 10) : 0;
  const last = virtual ? Math.min(rows.length, Math.ceil((view.top + view.h) / ROW_H) + 10) : rows.length;
  const HEAD = 28;

  if (!records.length) {
    return (
      <div className={cn("flex size-full flex-col items-center justify-center gap-2.5 text-xs text-muted-foreground", className)}>
        <Hourglass size={32} />
        Waiting for the first records
      </div>
    );
  }
  return (
    <div ref={scroller} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })} className={cn("relative size-full overflow-auto", className)}>
      <table className="w-full table-fixed border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b text-left text-[10px] font-normal text-muted-foreground" style={{ height: HEAD }}>
            <th className="w-12 px-3 text-right font-normal">#</th>
            {multiRoute && <th className="px-2 font-normal">route</th>}
            {keys.map((k) => <th key={k} className={cn("truncate px-2 font-normal", isNumeric(rows[0]?.item[k]) && "text-right")}>{k}</th>)}
          </tr>
        </thead>
        {virtual ? (
          <tbody className="relative block" style={{ height: rows.length * ROW_H }}>
            {rows.slice(first, last).map((r, i) => (
              <Row key={r.n} r={r} keys={keys} multiRoute={multiRoute} fresh={false} top={(first + i) * ROW_H} />
            ))}
          </tbody>
        ) : (
          <tbody>
            {rows.map((r) => <Row key={r.n} r={r} keys={keys} multiRoute={multiRoute} fresh={r.n > freshFrom && freshFrom > 0} />)}
          </tbody>
        )}
      </table>
      {more > 0 && <p className="px-3 py-2 text-[10px] text-muted-foreground">+{more} more fields per record</p>}
    </div>
  );
}

function useElapsed(from: number | null, to: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!from || to) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [from, to]);
  return from ? (to ?? now) - from : 0;
}

/** Breadcrumb of the machine's path (loops folded, re-entries counted), record count, elapsed time. */
export function ProductionStatus({ className }: { className?: string }) {
  const crumbs = useSession((s) => s.production.crumbs);
  const total = useSession((s) => s.production.total);
  const startedAt = useSession((s) => s.production.startedAt);
  const endedAt = useSession((s) => s.production.endedAt);
  const elapsed = useElapsed(startedAt, endedAt);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollLeft = el.scrollWidth; }, [crumbs]);
  return (
    <div className={cn("flex h-7 shrink-0 items-center gap-3 border-t px-3 font-mono text-[10px] text-muted-foreground", className)}>
      {endedAt ? <Retro name="parity" /> : <Hourglass />}
      <div ref={ref} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
        {crumbs.map((c, i) => (
          <Fragment key={`${c.state}-${i}`}>
            {i > 0 && <ChevronRightIcon className="size-3 shrink-0 opacity-50" />}
            <span className={cn(i === crumbs.length - 1 && !endedAt && "text-foreground")}>
              {c.state}{c.n > 1 && <span className="ml-0.5 tabular-nums opacity-70">({c.n})</span>}
            </span>
          </Fragment>
        ))}
      </div>
      <span className="shrink-0 tabular-nums"><span className="text-foreground">{total}</span> records</span>
      <span className="shrink-0 tabular-nums">{clock(elapsed)}</span>
    </div>
  );
}

/** The production stage: live machine on top, live records below, path + count + time in the footer. */
export function ProductionStage({ machine, className }: { machine: unknown; className?: string }) {
  const total = useSession((s) => s.production.total);
  const done = useSession((s) => !!s.production.artifact);
  return (
    <div className={cn("grid size-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)_auto] overflow-hidden rounded-xl border bg-card animate-in fade-in duration-500", className)}>
      <section className="relative min-h-0">
        <div className="absolute top-2.5 left-3 z-10 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Retro name="machine" />
          {done ? "Run complete" : "Running at scale"}
        </div>
        <MachineView machine={machine} follow />
      </section>
      <section className="min-h-0 border-t">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[11px] text-muted-foreground">
            <Retro name="schema" />
            Records <span className="tabular-nums text-foreground">{total}</span>
          </div>
          <div className="min-h-0 flex-1"><RecordsTable /></div>
        </div>
      </section>
      <ProductionStatus />
    </div>
  );
}
