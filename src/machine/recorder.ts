/**
 * Flight recorder: always-on, bounded telemetry for a run, dumped as a self-contained *fault bundle*
 * when something goes wrong — the input for the authoring pass (`a2flow diagnose`).
 *
 *   spans     OpenTelemetry (run → unit → operation; retries/recoveries/dismissals as span events),
 *             exported as OTLP/JSON so any OTel backend/viewer can load them
 *   network   CDP Network.* → HAR 1.2 (what Chrome DevTools "Save all as HAR" produces)
 *   console   CDP Runtime.consoleAPICalled / exceptionThrown / Log.entryAdded
 *   a2ui      server→client messages + client actions (tail), runtime logs
 *   page      dom.html, screenshot.png, canvas frames, visual snapshot, projection, domhash fingerprint
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { context as otelContext, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { BrowserAdapter } from "../adapters/types.js";
import type { FlowManifest } from "../manifest/types.js";

class Ring<T> {
  items: T[] = [];
  constructor(private cap: number) {}
  push(x: T) { this.items.push(x); if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap); }
}

class RingExporter implements SpanExporter {
  readonly ring: Ring<ReadableSpan>;
  constructor(cap: number) { this.ring = new Ring(cap); }
  export(spans: ReadableSpan[], cb: (r: { code: number }) => void) { spans.forEach((s) => this.ring.push(s)); cb({ code: 0 }); }
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

interface HarEntry { requestId: string; startedDateTime: string; t0: number; request: any; response?: any; time?: number; failure?: string; resourceType?: string }

export class FlightRecorder {
  private exporter: RingExporter;
  private provider: BasicTracerProvider;
  readonly tracer;
  private runSpan?: Span;
  private units = new Map<string, Span>();
  private open = new Set<Span>();
  private net = new Map<string, HarEntry>();
  private netRing: Ring<HarEntry>;
  private consoleRing: Ring<Record<string, unknown>>;
  private a2uiRing: Ring<unknown>;
  private logRing: Ring<string>;
  private dumps = 0;
  private writes: Promise<unknown>[] = [];
  /** Wait for queued bundle writes (call at run end). */
  async drain() { await Promise.allSettled(this.writes); this.writes = []; }

  constructor(readonly manifest: FlowManifest, private outDir: string, cap = { spans: 2000, network: 400, console: 300, a2ui: 400, logs: 500 }) {
    this.exporter = new RingExporter(cap.spans);
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "a2flow", "a2flow.manifest": manifest.id, "a2flow.version": manifest.a2flow }),
      spanProcessors: [new SimpleSpanProcessor(this.exporter)],
    });
    this.tracer = this.provider.getTracer("a2flow.runtime");
    this.netRing = new Ring(cap.network);
    this.consoleRing = new Ring(cap.console);
    this.a2uiRing = new Ring(cap.a2ui);
    this.logRing = new Ring(cap.logs);
  }

  /** Subscribe to CDP network/console events (call again after a browser relaunch). */
  async attach(a: BrowserAdapter) {
    for (const d of ["Network.enable", "Runtime.enable", "Log.enable"]) await a.cdp(d).catch(() => {});
    a.onCdp("Network.requestWillBeSent", (p: any) => {
      const e: HarEntry = { requestId: p.requestId, startedDateTime: new Date(p.wallTime * 1000).toISOString(), t0: p.timestamp, resourceType: p.type,
        request: { method: p.request.method, url: p.request.url, httpVersion: "HTTP/1.1", headers: hdrs(p.request.headers), queryString: [], cookies: [], headersSize: -1, bodySize: p.request.postData?.length ?? 0 } };
      this.net.set(p.requestId, e);
      this.netRing.push(e);
    });
    a.onCdp("Network.responseReceived", (p: any) => {
      const e = this.net.get(p.requestId);
      if (e) e.response = { status: p.response.status, statusText: p.response.statusText, httpVersion: p.response.protocol ?? "HTTP/1.1", headers: hdrs(p.response.headers),
        cookies: [], content: { size: p.response.encodedDataLength ?? 0, mimeType: p.response.mimeType }, redirectURL: "", headersSize: -1, bodySize: -1 };
    });
    a.onCdp("Network.loadingFinished", (p: any) => { const e = this.net.get(p.requestId); if (e) { e.time = (p.timestamp - e.t0) * 1000; this.net.delete(p.requestId); } });
    a.onCdp("Network.loadingFailed", (p: any) => { const e = this.net.get(p.requestId); if (e) { e.failure = p.errorText; e.time = (p.timestamp - e.t0) * 1000; this.net.delete(p.requestId); } });
    a.onCdp("Runtime.consoleAPICalled", (p: any) => this.consoleRing.push({ at: new Date().toISOString(), level: p.type, text: (p.args ?? []).map((x: any) => x.value ?? x.description ?? "").join(" ").slice(0, 2000) }));
    a.onCdp("Runtime.exceptionThrown", (p: any) => this.consoleRing.push({ at: new Date().toISOString(), level: "exception", text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text }));
    a.onCdp("Log.entryAdded", (p: any) => this.consoleRing.push({ at: new Date().toISOString(), level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url }));
  }

  record(kind: "a2ui" | "action", m: unknown) { this.a2uiRing.push(kind === "action" ? { client: m } : m); }
  log(line: string) { this.logRing.push(`${new Date().toISOString()} ${line}`); }

  // ---- spans ----
  startRun(attrs: Record<string, string | number | boolean>) {
    this.runSpan = this.tracer.startSpan(`a2flow.run ${this.manifest.id}`, { attributes: attrs });
    this.open.add(this.runSpan);
  }
  private parent(unitId?: string) {
    const p = (unitId && this.units.get(unitId)) || [...this.units.values()].at(-1) || this.runSpan;
    return p ? trace.setSpan(otelContext.active(), p) : otelContext.active();
  }
  startUnit(id: string, attrs: Record<string, string | number | boolean>) {
    const s = this.tracer.startSpan(`unit ${id}`, { attributes: { "a2flow.unit": id, ...attrs } }, this.parent());
    this.units.set(id, s); this.open.add(s);
  }
  endUnit(id: string, status: "done" | "failed" | "skipped", error?: string) {
    const s = this.units.get(id);
    if (!s) return;
    s.setAttribute("a2flow.unit.status", status);
    s.setStatus(status === "failed" ? { code: SpanStatusCode.ERROR, message: error } : { code: SpanStatusCode.OK });
    s.end(); this.open.delete(s); this.units.delete(id);
  }
  startOp(name: string, attrs: Record<string, string | number | boolean | undefined>): Span {
    const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
    const s = this.tracer.startSpan(name, { attributes: clean }, this.parent());
    this.open.add(s);
    return s;
  }
  endOp(s: Span, error?: string) {
    s.setStatus(error ? { code: SpanStatusCode.ERROR, message: error } : { code: SpanStatusCode.OK });
    s.end(); this.open.delete(s);
  }
  endRun(error?: string) {
    for (const [id] of this.units) this.endUnit(id, "failed", "run ended");
    if (this.runSpan) { this.endOp(this.runSpan, error); this.runSpan = undefined; }
  }

  /** OTLP/JSON (opentelemetry-proto JSON mapping) of finished + still-open spans. */
  otlp() {
    const attr = (o: Record<string, unknown>) => Object.entries(o).map(([key, v]) => ({ key, value:
      typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v) } }));
    const ns = (t: [number, number]) => String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));
    const conv = (s: ReadableSpan, open = false) => ({
      traceId: s.spanContext().traceId, spanId: s.spanContext().spanId, parentSpanId: s.parentSpanContext?.spanId ?? "",
      name: s.name, kind: 1, startTimeUnixNano: ns(s.startTime), endTimeUnixNano: open ? "0" : ns(s.endTime),
      attributes: attr({ ...s.attributes, ...(open ? { "a2flow.open": true } : {}) }),
      events: s.events.map((e) => ({ timeUnixNano: ns(e.time), name: e.name, attributes: attr(e.attributes ?? {}) })),
      status: { code: s.status.code, message: s.status.message ?? "" },
    });
    const spans = [...this.exporter.ring.items.map((s) => conv(s)), ...[...this.open].map((s) => conv(s as unknown as ReadableSpan, true))];
    return { resourceSpans: [{ resource: { attributes: attr({ "service.name": "a2flow", "a2flow.manifest": this.manifest.id }) }, scopeSpans: [{ scope: { name: "a2flow.runtime" }, spans }] }] };
  }

  har() {
    return { log: { version: "1.2", creator: { name: "a2flow", version: "0.2" }, pages: [],
      entries: this.netRing.items.map((e) => ({
        startedDateTime: e.startedDateTime, time: e.time ?? -1, request: e.request,
        response: e.response ?? { status: 0, statusText: e.failure ?? "(pending)", httpVersion: "", headers: [], cookies: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1 },
        cache: {}, timings: { send: 0, wait: e.time ?? -1, receive: 0 }, _resourceType: e.resourceType, ...(e.failure ? { _error: e.failure } : {}),
      })) } };
  }

  /** Write a fault bundle while the page is still in the faulted state. Returns its directory. */
  async dump(reason: string, info: {
    adapter: BrowserAdapter; error?: string; unit?: unknown; state?: string; view?: string | null; expectedView?: string;
    machine?: unknown; stats?: unknown; projection?: unknown; fingerprint?: unknown;
  }): Promise<string> {
    const dir = join(this.outDir, "faults", `${String(++this.dumps).padStart(3, "0")}-${reason}`);
    mkdirSync(dir, { recursive: true });
    const a = info.adapter;
    const url = await a.url().catch(() => "");
    // page state is captured (awaited) below; serialisation + disk writes happen in the background
    const w = (f: string, d: unknown) => { this.writes.push(writeFile(join(dir, f), typeof d === "string" || Buffer.isBuffer(d) ? d : JSON.stringify(d, null, 1)).catch(() => {})); };
    w("reason.json", { reason, error: info.error, at: new Date().toISOString(), url, state: info.state, view: info.view, expectedView: info.expectedView, unit: info.unit, stats: info.stats });
    w("spans.otlp.json", this.otlp());
    w("network.har", this.har());
    w("console.json", this.consoleRing.items);
    w("a2ui.tail.jsonl", this.a2uiRing.items.map((x) => JSON.stringify(x)).join("\n") + "\n");
    w("logs.txt", this.logRing.items.join("\n") + "\n");
    if (info.machine) w("machine.json", info.machine);
    if (info.projection) w("projection.json", info.projection);
    if (info.fingerprint) w("fingerprint.json", info.fingerprint);
    const ev = info.expectedView ?? info.view;
    if (ev && this.manifest.views[ev]) w("expected.view.json", { id: ev, ...this.manifest.views[ev] });
    await Promise.all([
      a.evaluate<string>("document.documentElement.outerHTML").then((h) => w("dom.html", h)).catch(() => {}),
      a.screenshot({ type: "png" }).then((b) => w("screenshot.png", b)).catch(() => {}),
      a.evaluate<any>("window.__a2flow ? window.__a2flow.visual({ selectors: true, max: 3000 }) : null").then((v) => {
        if (!v) return;
        (v.canvases ?? []).forEach((c: any, i: number) => c.dataUrl && w(`canvas${i}.jpg`, Buffer.from(c.dataUrl.split(",")[1], "base64")));
        w("visual.json", { ...v, canvases: (v.canvases ?? []).map((c: any) => ({ ...c, dataUrl: undefined })) });
      }).catch(() => {}),
    ]);
    this.log(`fault bundle ${dir} (${reason})`);
    return dir;
  }
}

const hdrs = (h: Record<string, string> = {}) => Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
