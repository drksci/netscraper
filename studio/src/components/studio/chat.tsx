"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  CircleXIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isBrowserTool, toolName, toolParts, type ToolPart } from "@/lib/authoring";
import { useSession } from "@/lib/session-store";
import type { useStudioChat } from "@/lib/use-studio-chat";
import { cn } from "@/lib/utils";
import { BrowserEmbed } from "./browser";
import { Prose } from "./prose";
import { ProductionCards } from "./production-cards";
import { Hourglass, Retro, type RetroName } from "./retro";
import { NetscraperLockup } from "@/components/brand/netscraper-logo";

type Chat = ReturnType<typeof useStudioChat>;

const STARTERS = [
  {
    title: "TikTok video feed",
    prompt: "TikTok explore / For You video feed (not a profile): one record per video with id, caption, author, play/like/comment/share counts and cover.",
  },
  {
    title: "Hashtag feed",
    prompt: "TikTok hashtag video feed, e.g. #cooking (not a profile): one record per video in the tag's grid with id, caption, author, counts and cover.",
  },
];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- tool rows

/** Win95 accent per tool; browser tools get the spinning globe while they run. */
function toolIcon(name: string, busy: boolean): RetroName {
  if (name.startsWith("browser_")) return busy ? "spinning-globe" : "globe";
  if (name === "research_site") return "research";
  if (name === "network_samples" || name === "net_preview") return "net";
  if (name === "highlight" || name === "clear_highlights") return "highlight";
  if (name === "record_expected") return "expected";
  if (name.includes("schema")) return "schema";
  if (name === "dsl_reference") return "research";
  if (name === "derive_view") return "find";
  if (name.includes("manifest") && name !== "run_manifest") return "manifest";
  if (name === "run_manifest" || name === "run_at_scale") return busy ? "gears" : "run";
  if (name === "parity") return "parity";
  return "gears";
}

/** "browser_navigate" → "Navigate", "propose_schema" → "Propose schema" */
function toolTitle(name: string) {
  if (name === "run_manifest") return "Run";
  if (name === "run_at_scale") return "Run at scale";
  const t = name.replace(/^browser_/, "").replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const host = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function summarize(name: string, input: unknown): string {
  if (!isObj(input)) return "";
  switch (name) {
    case "browser_navigate": return typeof input.url === "string" ? host(input.url) : "";
    case "browser_scroll": return `${input.direction ?? "down"}${input.times > 1 ? ` ×${input.times}` : ""}`;
    case "browser_click": return String(input.text ?? input.href ?? input.selector ?? "");
    case "research_site": return typeof input.site === "string" ? host(input.site) : "";
    case "propose_schema": return isObj(input.outputs) ? Object.keys(input.outputs).join(", ") : "";
    case "record_expected": return Array.isArray(input.records) ? `${input.records.length} records` : "";
    case "write_manifest": return isObj(input.manifest) ? String(input.manifest.title ?? input.manifest.id ?? "") : "";
    case "run_manifest": return isObj(input.inputs) ? Object.entries(input.inputs).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ") : "";
  }
  for (const k of ["url", "selector", "text", "query", "urlContains", "name", "route", "view", "id"]) if (typeof input[k] === "string") return input[k];
  for (const v of Object.values(input)) if (typeof v === "string" || typeof v === "number") return String(v);
  return "";
}

function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="max-h-56 overflow-auto rounded-md bg-muted/70 px-2.5 py-2 font-mono text-[10.5px] leading-4 whitespace-pre-wrap break-all text-muted-foreground">{text}</pre>;
}

const running = (s: string) => s === "input-streaming" || s === "input-available";

/** The research_site brief: quiet, collapsed, readable when opened. */
function ResearchBody({ part }: { part: ToolPart }) {
  const research = useSession((s) => s.research);
  const brief = research?.brief || (typeof part.output === "string" ? part.output : "");
  if (!brief) return part.state === "output-error" ? <Json value={part.errorText ?? "error"} /> : null;
  return (
    <div className="max-h-80 overflow-auto rounded-lg border px-2.5 py-2 text-xs text-muted-foreground">
      {research && <p className="mb-1 font-mono text-[10px] text-muted-foreground/70">{host(research.site)} · {research.cached ? "cached" : `${(research.ms / 1000).toFixed(0)}s`}</p>}
      <Prose text={brief} />
    </div>
  );
}

/** chip verb per tool: "nav", "scroll", "samples"… */
function verb(name: string) {
  const V: Record<string, string> = {
    browser_navigate: "nav", browser_scroll: "scroll", browser_click: "click", browser_back: "back", browser_observe: "observe",
    research_site: "research", network_samples: "samples", net_preview: "preview", highlight: "highlight", clear_highlights: "clear",
    propose_schema: "schema", record_expected: "expected", finalize_schema: "finalize", derive_view: "derive", dsl_reference: "dsl",
    write_manifest: "manifest", patch_manifest: "patch", get_manifest: "get manifest", run_manifest: "run", parity: "parity", run_at_scale: "run at scale",
  };
  return V[name] ?? name.replace(/_/g, " ");
}

/** The expanded detail of one tool call (JSON, or the research brief). */
function ToolDetail({ part }: { part: ToolPart }) {
  const name = toolName(part);
  if (name === "research_site") return <ResearchBody part={part} />;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-[10px] text-muted-foreground">{name}</p>
      {part.input !== undefined && <Json value={part.input} />}
      {part.state === "output-available" && <Json value={part.output} />}
      {part.state === "output-error" && <Json value={part.errorText ?? "error"} />}
    </div>
  );
}

/**
 * Consecutive tool calls as one wrapped row of compact chips (icon · verb · short arg, ×N for repeats);
 * clicking a chip opens its detail under the cluster.
 */
const ToolCluster = memo(function ToolCluster({ parts }: { parts: ToolPart[] }) {
  const [open, setOpen] = useState<string | null>(null);
  // fold identical consecutive calls (scroll ×3)
  const chips: { part: ToolPart; n: number }[] = [];
  for (const p of parts) {
    const prev = chips.at(-1);
    if (prev && toolName(prev.part) === toolName(p) && summarize(toolName(p), p.input) === summarize(toolName(prev.part), prev.part.input) && !running(p.state)) { prev.n++; prev.part = p; }
    else chips.push({ part: p, n: 1 });
  }
  const sel = parts.find((p) => p.toolCallId === open);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {chips.map(({ part, n }) => {
          const name = toolName(part);
          const busy = running(part.state);
          const failed = part.state === "output-error";
          const summary = summarize(name, part.input);
          const on = open === part.toolCallId;
          return (
            <button
              key={part.toolCallId}
              type="button"
              title={`${toolTitle(name)}${summary ? ` · ${summary}` : ""}`}
              onClick={() => setOpen(on ? null : part.toolCallId)}
              className={cn(
                "flex h-5 max-w-full min-w-0 items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                on && "bg-muted text-foreground",
                failed && "text-destructive",
              )}
            >
              <Retro name={toolIcon(name, busy)} />
              <span className="shrink-0">{verb(name)}</span>
              {summary && <span className="max-w-[16ch] truncate font-mono text-[10px] opacity-70">{summary}</span>}
              {n > 1 && <span className="shrink-0 font-mono text-[10px] opacity-70">×{n}</span>}
              {busy && <Hourglass />}
              {failed && <CircleXIcon className="size-3 shrink-0" />}
            </button>
          );
        })}
      </div>
      {sel && <div className="animate-in fade-in duration-150"><ToolDetail part={sel} /></div>}
    </div>
  );
});

// ---------------------------------------------------------------- reasoning

/** Thinking streams as a short live tail; once done it folds to its first line (expandable). */
function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const t = text.trim();
  if (streaming) {
    const tail = t.length > 180 ? `…${t.slice(-180)}` : t;
    return (
      <p className="line-clamp-2 border-l-2 border-foreground/15 pl-2.5 text-xs leading-snug text-muted-foreground italic">
        {tail}
        <span className="ml-0.5 inline-block h-2.5 w-1 animate-pulse bg-muted-foreground/50 align-middle" />
      </p>
    );
  }
  const first = t.split(/\n+/)[0] ?? "";
  return (
    <Collapsible className="group/think flex flex-col gap-1">
      <CollapsibleTrigger render={<button type="button" className="flex w-full min-w-0 items-start gap-1.5 border-l-2 border-transparent pl-2.5 text-left text-xs leading-snug text-muted-foreground/80 italic outline-none hover:text-muted-foreground" />}>
        <span className="line-clamp-1 min-w-0">{first}</span>
        {t.length > first.length && <ChevronRightIcon className="mt-0.5 size-3 shrink-0 not-italic opacity-60 transition-transform group-data-[open]/think:rotate-90" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="border-l-2 border-foreground/10 pl-2.5 text-xs leading-snug whitespace-pre-wrap text-muted-foreground">{t}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------- messages

/** The live browser under the latest browser call, scrolled into view when it appears. */
function Embed() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 80);
    return () => clearTimeout(t);
  }, []);
  return <div ref={ref} className="animate-in py-1 duration-300 fade-in slide-in-from-bottom-1"><BrowserEmbed /></div>;
}

function ChatMessage({ message, streaming, embedId, scaleId }: { message: UIMessage; streaming: boolean; embedId: string | null; scaleId: string | null }) {
  const isUser = message.role === "user";
  // consecutive tool calls form one cluster
  const blocks: ({ kind: "part"; i: number } | { kind: "tools"; parts: ToolPart[] })[] = [];
  message.parts.forEach((p, i) => {
    if (p.type === "dynamic-tool") {
      const last = blocks.at(-1);
      if (last?.kind === "tools") last.parts.push(p as unknown as ToolPart);
      else blocks.push({ kind: "tools", parts: [p as unknown as ToolPart] });
    } else blocks.push({ kind: "part", i });
  });
  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageContent className="gap-1.5">
        {blocks.map((b) => {
          if (b.kind === "tools") {
            const ids = new Set(b.parts.map((t) => t.toolCallId));
            return (
              <div key={b.parts[0].toolCallId} className="flex min-w-0 flex-col gap-1.5">
                <ToolCluster parts={b.parts} />
                {embedId && ids.has(embedId) && <Embed />}
                {scaleId && ids.has(scaleId) && <ProductionCards />}
              </div>
            );
          }
          const p = message.parts[b.i];
          if (p.type === "text") {
            if (!p.text.trim()) return null;
            return isUser ? (
              <Bubble key={b.i} variant="secondary" align="end">
                <BubbleContent className="rounded-xl px-2.5 py-1 text-[13px] leading-snug whitespace-pre-wrap">{p.text}</BubbleContent>
              </Bubble>
            ) : (
              <Prose key={b.i} text={p.text} className="text-[13px] text-foreground/90" />
            );
          }
          if (p.type === "reasoning") return p.text ? <Reasoning key={b.i} text={p.text} streaming={streaming && p.state === "streaming"} /> : null;
          return null;
        })}
      </MessageContent>
    </Message>
  );
}

function SpinningGlobeMark() {
  return <NetscraperLockup size="lg" className="mb-2" />;
}

function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-8 text-center animate-in fade-in duration-500">
      <div className="flex flex-col items-center gap-3">
        <SpinningGlobeMark />
        <h1 className="text-2xl font-medium tracking-tight">What should we collect?</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Describe a dataset. The agent browses the site, drafts a schema and a manifest, then runs it until the records match.
        </p>
      </div>
      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onPick(s.prompt)}
            className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="text-sm font-medium">{s.title}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{s.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- panel

/**
 * Stick to the bottom while anything grows (streamed text, the thinking tail, tool rows, the browser embed),
 * unless the user has scrolled up; scrolling back near the end (or the jump button) re-sticks.
 * MessageScroller's own follow only reacts to new items, not to content growing inside the last one.
 */
function useStickToBottom(active: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const v = viewport.current, c = content.current;
    if (!active || !v || !c) return;
    stuck.current = true;
    const pin = () => { if (stuck.current) v.scrollTop = v.scrollHeight; };
    // only the user un-sticks (wheel / touch / keys / scrollbar drag); programmatic scrolls never do
    let dragging = false;
    const near = () => v.scrollHeight - v.scrollTop - v.clientHeight < 72;
    const onScroll = () => { if (near()) stuck.current = true; else if (dragging) stuck.current = false; };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) stuck.current = false; };
    const onTouch = () => { stuck.current = near(); };
    const onKey = (e: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) stuck.current = false; };
    const onDown = () => { dragging = true; };
    const onUp = () => { dragging = false; };
    v.addEventListener("scroll", onScroll, { passive: true });
    v.addEventListener("wheel", onWheel, { passive: true });
    v.addEventListener("touchmove", onTouch, { passive: true });
    v.addEventListener("keydown", onKey);
    v.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    const ro = new ResizeObserver(pin);
    ro.observe(c);
    ro.observe(v);
    pin();
    return () => {
      ro.disconnect();
      v.removeEventListener("scroll", onScroll);
      v.removeEventListener("wheel", onWheel);
      v.removeEventListener("touchmove", onTouch);
      v.removeEventListener("keydown", onKey);
      v.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  }, [active]);
  /** a new message from the user always brings the view back down */
  const follow = () => { stuck.current = true; requestAnimationFrame(() => { const v = viewport.current; if (v) v.scrollTop = v.scrollHeight; }); };
  return { viewport, content, follow };
}

export function ChatPanel({ chat, wide, stageOpen, onToggleStage }: { chat: Chat; wide: boolean; stageOpen: boolean; onToggleStage: () => void }) {
  const { messages, sendMessage, status, stop, error, system, setSystem } = chat;
  const busy = status === "submitted" || status === "streaming";
  const [input, setInput] = useState("");
  // the browser embeds in the chat only while the chat has the whole window
  const embedId = useMemo(() => (wide ? toolParts(messages).findLast((p) => isBrowserTool(toolName(p)))?.toolCallId ?? null : null), [messages, wide]);

  // the production cards follow the latest run_at_scale row (or close the chat when the run came from elsewhere)
  const scaleId = useMemo(() => toolParts(messages).findLast((p) => toolName(p) === "run_at_scale")?.toolCallId ?? null, [messages]);
  const hasProduction = useSession((s) => !!s.production.artifact || !!s.production.report);
  const stick = useStickToBottom(messages.length > 0 || hasProduction);
  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    stick.follow();
    void sendMessage({ text: t });
  };
  const pad = wide ? "px-8" : "px-4";

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {messages.length === 0 && !hasProduction ? (
          <Welcome onPick={submit} />
        ) : (
          <MessageScrollerProvider defaultScrollPosition="end">
            <MessageScroller className="[container-type:size]">
              <MessageScrollerViewport ref={stick.viewport}>
                <MessageScrollerContent ref={stick.content} aria-busy={busy} className={cn("w-full gap-2 pt-4 pb-4 transition-[padding] duration-500", pad)}>
                  {messages.map((m, i) => (
                    <MessageScrollerItem key={m.id} messageId={m.id}>
                      <ChatMessage message={m} streaming={busy && i === messages.length - 1} embedId={embedId} scaleId={scaleId} />
                    </MessageScrollerItem>
                  ))}
                  {!scaleId && hasProduction && (
                    <MessageScrollerItem messageId="production"><ProductionCards /></MessageScrollerItem>
                  )}
                  {status === "submitted" && (
                    <MessageScrollerItem messageId="pending">
                      <span className="flex items-center gap-2 text-xs text-muted-foreground"><Hourglass />Starting</span>
                    </MessageScrollerItem>
                  )}
                  {error && (
                    <MessageScrollerItem messageId="error">
                      <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error.message}</p>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton size="icon-xs" variant="outline" />
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </div>

      <form className={cn("w-full pt-1 pb-4 transition-[padding] duration-500", pad)} onSubmit={(e) => { e.preventDefault(); submit(input); }}>
        <InputGroup className="rounded-2xl bg-card">
          <InputGroupTextarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(input); }
            }}
            placeholder={messages.length ? "Reply…" : "Describe the dataset to build…"}
            rows={wide ? 2 : 1}
            className="max-h-40 min-h-0 px-3.5 pt-3 text-sm"
          />
          <InputGroupAddon align="block-end" className="justify-between px-2 pb-2">
            <div className="flex items-center gap-0.5">
              <Sheet>
                <Tooltip>
                  <TooltipTrigger render={<SheetTrigger render={<InputGroupButton variant="ghost" size="icon-xs" aria-label="System prompt" />} />}>
                    <SlidersHorizontalIcon />
                  </TooltipTrigger>
                  <TooltipContent>System prompt</TooltipContent>
                </Tooltip>
                <SheetContent className="w-full sm:max-w-xl">
                  <SheetHeader>
                    <SheetTitle>System prompt</SheetTitle>
                    <SheetDescription>Sent with every request. Prefilled from the session server.</SheetDescription>
                  </SheetHeader>
                  <div className="flex min-h-0 flex-1 px-4 pb-4">
                    <Textarea
                      value={system}
                      onChange={(e) => setSystem(e.target.value)}
                      placeholder="Default system prompt unavailable (session server not connected)."
                      className="h-full min-h-0 flex-1 resize-none font-mono text-xs"
                    />
                  </div>
                </SheetContent>
              </Sheet>
              <Tooltip>
                <TooltipTrigger render={<InputGroupButton variant="ghost" size="icon-xs" aria-label={stageOpen ? "Chat only" : "Show code and browser"} onClick={onToggleStage} />}>
                  {stageOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
                </TooltipTrigger>
                <TooltipContent>{stageOpen ? "Chat only" : "Show code and browser"}</TooltipContent>
              </Tooltip>
            </div>
            {busy ? (
              <InputGroupButton type="button" variant="secondary" size="icon-xs" aria-label="Stop" className="rounded-full" onClick={() => stop()}>
                <SquareIcon className="fill-current" />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" variant="default" size="icon-xs" aria-label="Send" className="rounded-full" disabled={!input.trim()}>
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}
