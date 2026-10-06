"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { NetscraperSplash } from "@/components/brand/netscraper-logo";
import { loadWasmActor, MODE_LABEL, startActor, type ActorMode, type ActorPrefer, type ActorRun } from "@/lib/actor-source";
import { formatLog, statePath, type Tone } from "@/lib/actor-log";
import { clock } from "@/lib/format";
import { useSession, type ActorLine } from "@/lib/session-store";
import { setUI } from "@/lib/ui-store";
import { cn } from "@/lib/utils";

/**
 * The shipped manifest run as its own job: a small live TUI (btop / k9s spirit) in one black monospace pane,
 * designed for ~50 columns. Header · machine strip · records · progress · pinned log.
 * Runs in this tab (WASM) when the in-browser runtime is available, otherwise on the session server.
 */

// flat black, one accent (brand yellow), red/amber for trouble, greys for everything else
const C = { bg: "#000", rule: "#1a1a1a", text: "#d4d4d4", dim: "#6b6b6b", faint: "#3a3a3a", accent: "#ffdd33", warn: "#ffb454", fault: "#ff6b6b", ok: "#8fdc7f", info: "#8ab4c8" };
const TONE: Record<Tone, string> = { dim: C.dim, text: C.text, accent: C.accent, ok: C.ok, warn: C.warn, fault: C.fault, info: C.info };

// ---------------------------------------------------------------- inputs

const toText = (v: unknown) => (Array.isArray(v) ? v.join(",") : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? ""));
function fromText(text: string, like: unknown): unknown {
  if (Array.isArray(like)) return text.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (typeof like[0] === "number" ? Number(s) : s));
  if (typeof like === "number") return Number(text) || 0;
  if (typeof like === "boolean") return /^(true|yes|1)$/i.test(text.trim());
  if (typeof like === "object" && like) { try { return JSON.parse(text); } catch { return like; } }
  return text;
}
const LIMIT_KEY = /^(max\w*|limit|count|resultsPerPage|n)$/i;

// ---------------------------------------------------------------- records

type Rec = Record<string, unknown>;
const get = (o: Rec, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Rec)[k] : undefined), o);
const firstOf = (o: Rec, paths: string[]) => { for (const p of paths) { const v = get(o, p); if (v != null && v !== "") return v; } return undefined; };
const sid = (v: unknown) => { const s = String(v ?? ""); return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v != null ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n) : "—"; };

/** id · ♥ likes · ▶ plays · @author · caption, by field-name heuristics */
function rowOf(item: unknown) {
  const o = (item && typeof item === "object" ? item : { value: item }) as Rec;
  const who = firstOf(o, ["authorMeta.name", "author.uniqueId", "author", "uniqueId", "username", "authorMeta.nickName"]);
  return {
    id: sid(firstOf(o, ["id", "videoId", "key", "url", "webVideoUrl"])),
    like: num(firstOf(o, ["diggCount", "likes", "likeCount", "heartCount", "stats.diggCount"])),
    play: num(firstOf(o, ["playCount", "plays", "views", "viewCount", "stats.playCount"])),
    who: typeof who === "string" && who ? `@${who.replace(/^@/, "")}` : "",
    text: String(firstOf(o, ["text", "desc", "caption", "title"]) ?? "").replace(/\s+/g, " "),
  };
}

const COLS = "grid-cols-[3ch_10ch_7ch_7ch_minmax(0,1fr)]";

const RecordRow = memo(function RecordRow({ l, i, fresh }: { l: ActorLine; i: number; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const r = useMemo(() => rowOf(l.item), [l.item]);
  return (
    <div className={cn(fresh && "animate-in slide-in-from-top-1 fade-in duration-300")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn("grid w-full gap-x-[1ch] text-left whitespace-nowrap hover:bg-white/[0.04]", COLS)}
        style={fresh ? { animation: "tui-flash 1.2s ease-out" } : undefined}
        title={r.text || undefined}
      >
        <span className="text-right" style={{ color: C.faint }}>{i}</span>
        <span>{r.id}</span>
        <span className="text-right">{r.like}</span>
        <span className="text-right">{r.play}</span>
        <span className="truncate">
          <span style={{ color: C.info }}>{r.who}</span>
          {r.text && <span style={{ color: C.dim }}> {r.text}</span>}
        </span>
      </button>
      {open && (
        <pre className="my-0.5 ml-[4ch] overflow-x-auto border-l pl-[1ch] text-[10px] leading-[14px] whitespace-pre" style={{ borderColor: C.rule, color: C.dim }}>
          {JSON.stringify(l.item, null, 1)}
        </pre>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- machine strip

/** The run's states as a compact chain: active inverted in the accent, visited normal, unvisited dim, loops ×N. */
function MachineStrip({ states, lines }: { states: string[]; lines: ActorLine[] }) {
  const { counts, current } = useMemo(() => statePath(lines), [lines]);
  const chain = useMemo(() => {
    const out = [...states];
    for (const s of counts.keys()) if (!out.includes(s)) out.push(s); // fall back to what the log saw
    return out;
  }, [states, counts]);
  // fault / interrupt branches flash when taken
  const last = lines.at(-1);
  const alert = last && (last.kind === "fault" || /interrupt|dismiss/i.test(last.line)) ? last : null;
  const [flash, setFlash] = useState<{ text: string; tone: string; n: number } | null>(null);
  useEffect(() => {
    if (!alert) return;
    const fault = alert.kind === "fault";
    const what = /interrupt[:\s]+(\w+)/i.exec(alert.line)?.[1];
    setFlash({ text: fault ? "⚑ fault → recover" : `⚑ interrupt${what ? ` ${what}` : ""} → dismiss`, tone: fault ? C.fault : C.warn, n: alert.n });
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [alert?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chain.length) return null;
  return (
    <div className="shrink-0 border-b px-[1ch] py-1" style={{ borderColor: C.rule }}>
      <div className="flex flex-wrap items-baseline gap-y-0.5">
        {chain.map((s, i) => {
          const n = counts.get(s) ?? 0;
          const active = s === current;
          return (
            <Fragment key={s}>
              {i > 0 && <span style={{ color: C.faint }}>{active ? "─▶" : "─"}</span>}
              <span className="px-[0.5ch] whitespace-nowrap" style={active ? { background: C.accent, color: "#000" } : { color: n ? C.text : C.faint }}>
                {s}{n > 1 && <span style={{ color: active ? "#000" : C.accent }}> ×{n}</span>}
              </span>
            </Fragment>
          );
        })}
      </div>
      {flash && <div key={flash.n} className="animate-in fade-in duration-150" style={{ color: flash.tone }}>{flash.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- terminal

function useTicker(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function usePinned(dep: unknown, end: "top" | "bottom") {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => { const el = ref.current; if (el && stuck.current) el.scrollTop = end === "bottom" ? el.scrollHeight : 0; }, [dep, end]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stuck.current = end === "bottom" ? el.scrollHeight - el.scrollTop - el.clientHeight < 20 : el.scrollTop < 20;
  };
  return { ref, onScroll };
}

const BAR = 16;

export function ActorTerminal({ defaults, className }: { defaults: Record<string, unknown>; className?: string }) {
  const artifact = useSession((s) => s.production.artifact);
  const machine = useSession((s) => s.manifest?.doc?.machine);
  const actor = useSession((s) => s.actor);
  const [wasm, setWasm] = useState<boolean | null>(null);
  const [prefer, setPrefer] = useState<ActorPrefer>("browser");
  const [mode, setMode] = useState<ActorMode | null>(null);
  const run = useRef<ActorRun | null>(null);
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, toText(v)])));

  useEffect(() => { void loadWasmActor().then((m) => setWasm(!!m)); }, []);
  const expected: ActorMode = mode ?? (prefer === "browser" && wasm ? "quickjs-wasm" : "server");
  const name = (artifact?.name ?? "manifest").replace(/\.a2flow\.json$|\.json$/, "");
  const inputs = useMemo(() => Object.fromEntries(Object.entries(form).map(([k, t]) => [k, fromText(t, defaults[k])])), [form, defaults]);

  const start = async () => {
    if (!artifact) return;
    run.current?.stop();
    const r = await startActor({ name: artifact.name, url: artifact.url, inputs, prefer });
    run.current = r;
    setMode(r.mode);
  };
  const stop = () => run.current?.stop();
  useEffect(() => () => run.current?.stop(), []);

  const engineMs = useMemo(() => { for (const l of actor.lines) { const m = /engine\D*?(\d+)\s*ms/i.exec(l.line); if (m) return `${m[1]}ms`; } return null; }, [actor.lines]);
  const states = useMemo(() => (machine && typeof machine === "object" && (machine as any).states ? Object.keys((machine as any).states) : []), [machine]);
  const log = useMemo(() => formatLog(actor.lines, 200), [actor.lines]);
  const rows = useMemo(() => [...actor.items].reverse(), [actor.items]);
  const seen = useRef(0);
  const freshFrom = seen.current;
  useEffect(() => { seen.current = actor.items.at(-1)?.n ?? 0; }, [actor.items]);

  const now = useTicker(actor.running);
  const elapsed = actor.startedAt ? (actor.endedAt ?? now) - actor.startedAt : 0;
  const rate = elapsed > 0 ? actor.items.length / (elapsed / 1000) : 0;
  const limitKey = Object.keys(defaults).find((k) => LIMIT_KEY.test(k) && typeof defaults[k] === "number");
  const target = limitKey ? Number(inputs[limitKey]) || 0 : 0;
  // toward maxItems; without a target, a sweeping block while running
  const filled = target ? Math.min(BAR, Math.round((actor.items.length / target) * BAR)) : 0;
  const sweep = !target && actor.running ? Math.floor(now / 250) % BAR : -1;
  const lastLog = log.at(-1);
  const logPin = usePinned(lastLog ? `${lastLog.key}:${lastLog.count}` : "", "bottom");
  const recPin = usePinned(rows.length, "top");
  const loading = !actor.items.length && (!actor.startedAt || actor.running);
  const engine = expected === "server" ? "server" : expected === "worker-js" ? "worker·js" : "quickjs·wasm";

  return (
    <div className={cn("flex size-full min-h-0 flex-col overflow-hidden rounded-xl border font-mono text-[11px] leading-[16px] animate-in fade-in duration-300", className)} style={{ background: C.bg, color: C.text, borderColor: C.rule }}>
      <style>{"@keyframes tui-flash{0%{background:rgba(255,221,51,.16)}100%{background:transparent}}"}</style>

      {/* 1 · header: one line, never wraps */}
      <div className="flex h-7 shrink-0 items-center gap-[1ch] overflow-hidden border-b px-[1ch] whitespace-nowrap" style={{ borderColor: C.rule }}>
        <span className="font-bold" style={{ color: C.accent }}>WASM</span>
        <span title={MODE_LABEL[expected]} style={{ color: C.dim }}>◆ {engine}{engineMs ? ` ${engineMs}` : ""}</span>
        <span className="min-w-0 truncate" title={artifact?.name} style={{ color: C.dim }}>· {name}</span>
        <span className="ml-auto" />
        {Object.keys(defaults).map((k) => (
          <label key={k} className="flex shrink-0 items-center" title={k}>
            <span style={{ color: C.dim }}>{k.length > 10 ? `${k.slice(0, 9)}…` : k}</span>
            <span style={{ color: C.faint }}>[</span>
            <input
              value={form[k] ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              disabled={actor.running}
              size={Math.max(2, Math.min(14, (form[k] ?? "").length))}
              className="border-0 bg-transparent p-0 text-[11px] outline-none disabled:opacity-60"
              style={{ color: C.text }}
            />
            <span style={{ color: C.faint }}>]</span>
          </label>
        ))}
        <button
          type="button"
          title={wasm === false ? "In-browser runtime unavailable: runs on the server" : `Runs ${prefer === "browser" ? "in this tab" : "on the server"} (click to switch)`}
          disabled={actor.running || wasm === false}
          onClick={() => { setPrefer((p) => (p === "browser" ? "server" : "browser")); setMode(null); }}
          className="shrink-0 disabled:opacity-60"
          style={{ color: C.dim }}
        >
          {prefer === "browser" && wasm !== false ? "tab" : "srv"}
        </button>
        {actor.running ? (
          <button type="button" onClick={stop} title="Stop" className="shrink-0 hover:underline" style={{ color: C.fault }}>■ stop</button>
        ) : (
          <button type="button" onClick={() => void start()} disabled={!artifact} title={actor.startedAt ? "Run again" : "Run"} className="shrink-0 hover:underline disabled:opacity-40" style={{ color: C.accent }}>▶ run</button>
        )}
        <button type="button" onClick={() => setUI({ actorOpen: false })} title="Close" className="shrink-0 hover:text-white" style={{ color: C.dim }}>×</button>
      </div>

      {/* 2 · machine strip */}
      <MachineStrip states={states} lines={actor.lines} />

      {/* 3 · records (main area); the VGA splash covers it until the first record */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={cn("grid shrink-0 gap-x-[1ch] px-[1ch] whitespace-nowrap", COLS)} style={{ color: C.dim }}>
          <span className="text-right">#</span><span>id</span><span className="text-right">♥</span><span className="text-right">▶</span>
          <span className="flex justify-between gap-[1ch]"><span>@author</span><span className="tabular-nums" style={{ color: C.faint }}>{actor.items.length} · {rate.toFixed(1)}/s</span></span>
        </div>
        <div ref={recPin.ref} onScroll={recPin.onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[1ch] tabular-nums">
          {rows.map((l, i) => <RecordRow key={l.n} l={l} i={rows.length - i} fresh={l.n > freshFrom && freshFrom > 0} />)}
        </div>
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black animate-in fade-in duration-300">
            <NetscraperSplash
              className="max-h-full w-auto max-w-full"
              status={!actor.startedAt ? "PRESS RUN" : (actor.lines.at(-1)?.line ?? "LOADING ACTOR").replace(/[^\x20-\x7e]/g, "").slice(0, 44)}
            />
          </div>
        )}
      </div>

      {/* 4 · progress */}
      <div className="flex h-6 shrink-0 items-center gap-[1ch] overflow-hidden border-t px-[1ch] whitespace-nowrap tabular-nums" style={{ borderColor: C.rule, color: C.dim }}>
        <span>
          {Array.from({ length: BAR }, (_, i) => (
            <span key={i} style={{ color: i < filled || i === sweep ? C.accent : C.faint }}>{i < filled || i === sweep ? "█" : "░"}</span>
          ))}
        </span>
        <span style={{ color: C.text }}>{actor.items.length}{target ? `/${target}` : ""}</span>
        <span>{rate.toFixed(1)}/s</span>
        <span>{clock(elapsed)}</span>
        <span className="ml-auto" style={{ color: actor.code ? C.fault : C.dim }}>{actor.running ? "running" : actor.startedAt ? `exit ${actor.code ?? 0}` : "ready"}</span>
      </div>

      {/* 5 · log, pinned at the bottom (≈5 lines) */}
      <div ref={logPin.ref} onScroll={logPin.onScroll} className="h-[86px] shrink-0 overflow-y-auto border-t px-[1ch] py-[3px]" style={{ borderColor: C.rule }}>
        {!log.length && <p className="truncate" style={{ color: C.faint }}>$ a2flow run {name} --input {JSON.stringify(inputs)}</p>}
        {log.map((r) => (
          <p key={r.key} title={r.full} className="flex gap-[1ch] whitespace-nowrap">
            <span className="w-[2ch] shrink-0 text-center" style={{ color: TONE[r.tone] }}>{r.glyph}</span>
            <span className="min-w-0 truncate" style={{ color: TONE[r.tone] }}>{r.text}</span>
            {r.count > 1 && <span className="shrink-0" style={{ color: C.faint }}>×{r.count}</span>}
          </p>
        ))}
      </div>
    </div>
  );
}
