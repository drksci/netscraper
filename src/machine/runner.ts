/**
 * v0.2 runtime: a manifest's JSON XState machine, driven by A2UI.
 *
 *   control surface (A2UI form) ──write contract──▶ local data model
 *        Button event {name, context:{path…}} ──▶ machine event {type:name, context}
 *   machine state ──invoke──▶ browser.navigate | view.await | a2ui.act | a2ui.input   (the only ways to touch the page)
 *        actions: ctx.* / route.emit / work.* / a2ui.write / log      guards: cond, work.done
 *   projected page surfaces + control surface (status, work ledger, attention) ──▶ one A2UI stream
 *
 * Every page-touching operation runs under the manifest's `policies` (timeouts, classified retries
 * with backoff, recovery, overlay dismissal, rate limiting, block detection). Units of work are
 * recorded in an append-only ledger so reruns over the same directory are idempotent.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { assign, createActor, fromPromise, setup, type AnyActorRef } from "xstate";
import type { BrowserAdapter } from "../adapters/types.js";
import type { ClientAction, Component } from "../a2ui/types.js";
import { msg } from "../a2ui/types.js";
import { buildAction, instancesOf, type Surface } from "../a2ui/surface.js";
import { getAt, setAt } from "../a2ui/pointer.js";
import type { Cond, FlowManifest } from "../manifest/types.js";
import { Projector } from "../render/projector.js";
import { ActionBridge } from "../runtime/bridge.js";
import { A2UIDriver } from "../runtime/driver.js";
import { evalCond, tmpl, type Scope } from "../runtime/expr.js";
import { RouteSink, type Emitted } from "../runtime/routes.js";
import { viewOfSurface } from "../runtime/extract.js";
import type { RunOptions, StepEvent } from "../runtime/runner.js";
import { Ledger } from "./ledger.js";
import { FlightRecorder } from "./recorder.js";
import type { Span } from "@opentelemetry/api";
import { DEFAULT_POLICIES, OpError, backoff, classify, sleep, withTimeout, type OpKind, type Policies } from "./policy.js";

export interface MachineRunOptions extends RunOptions {
  /** Run/state directory: ledger.jsonl, <route>.jsonl, machine.json. Reruns over it resume idempotently. */
  outDir?: string;
  /** Factory to replace a crashed browser (classified "crash"). */
  relaunch?: () => Promise<BrowserAdapter>;
  /** Flight recorder (spans/HAR/console/A2UI → fault bundles). Default: on when outDir is set. */
  recorder?: boolean;
  /** Restore a persisted XState snapshot (e.g. from a fault bundle's machine.json) instead of starting at `initial`. */
  restore?: unknown;
  /** Control-surface writes to re-publish on restore (machine.json `published`). */
  restorePublished?: Record<string, unknown>;
  /** Navigate here before restoring (the page state the snapshot was taken on). */
  startUrl?: string;
  /**
   * Studio: the first navigation to the URL already open in the browser is skipped (no reload), so sites
   * that throttle repeated loads keep serving, and the page's already-captured JSON is reused (`seedNet`).
   */
  reuseOpenPage?: boolean;
  /** Responses captured before the run (url, method, body), applied to net sources for the open page. */
  seedNet?: { url: string; method: string; body: unknown }[];
}

const CONTROL = "control";

export class MachineRunner extends EventEmitter {
  readonly projector: Projector;
  readonly bridge: ActionBridge;
  readonly driver: A2UIDriver;
  readonly ledger: Ledger;
  private sink: RouteSink;
  private actor?: AnyActorRef;
  private pending: StepEvent[] = [];
  private controlId = `${CONTROL}-1`;
  private stateLabel = "";
  private policies: Policies & typeof DEFAULT_POLICIES;
  private lastOpAt = 0;
  private lastGoodUrl?: string;
  private resumeWaiter?: () => void;
  /** Last data model per projected view — `$surfaces` for JSONata routes. */
  private lastByView: Record<string, unknown> = {};
  private emitQueue: (() => Promise<void>)[] = [];
  readonly recorder?: FlightRecorder;
  readonly faults: string[] = [];
  private currentOp?: Span;
  private expected?: string;
  private driftDumped = new Set<string>();
  private abortWith?: (e: Error) => void;
  private snapTimer?: NodeJS.Timeout;
  readonly stats = { retries: 0, recoveries: { reload: 0, relaunch: 0, resync: 0 }, dismissed: 0, blocked: 0, httpErrors: 0 };

  private reusedOnce = false;
  constructor(readonly manifest: FlowManifest, public adapter: BrowserAdapter, private inputs?: Record<string, unknown>, private opts: MachineRunOptions = {}) {
    super();
    if (!manifest.machine || !manifest.control) throw new Error("manifest has no machine/control (v0.2)");
    const mp = (manifest as any).policies as Policies | undefined;
    this.policies = {
      ...DEFAULT_POLICIES, ...mp,
      timeouts: { ...DEFAULT_POLICIES.timeouts, ...mp?.timeouts },
      retry: { ...DEFAULT_POLICIES.retry, ...mp?.retry },
      rateLimit: { ...DEFAULT_POLICIES.rateLimit, ...mp?.rateLimit },
      http: { ...DEFAULT_POLICIES.http, ...mp?.http },
    };
    this.projector = new Projector(adapter, manifest, opts.surfacePrefix);
    this.projector.on("message", (m) => {
      const sid = m.createSurface?.surfaceId ?? m.updateDataModel?.surfaceId;
      const view = sid && viewOfSurface(sid);
      if (view && (manifest.views[view] || view === CONTROL)) this.lastByView[view] = this.projector.store.surfaces.get(sid)?.dataModel;
      this.emit("message", m);
    });
    this.bridge = new ActionBridge(adapter, manifest, this.projector);
    this.driver = new A2UIDriver(this.projector.store, async (a) => { this.emit("action", a); await this.bridge.handle(a); });
    this.sink = new RouteSink(manifest, opts.outDir);
    this.ledger = new Ledger(opts.outDir);
    if (opts.outDir && opts.recorder !== false) {
      const rec = (this as { recorder?: FlightRecorder }).recorder = new FlightRecorder(manifest, opts.outDir);
      this.on("message", (m) => rec.record("a2ui", m));
      this.on("action", (a) => rec.record("action", a));
      this.on("log", (l) => rec.log(String(l)));
      this.on("drift", (d) => {
        if (this.driftDumped.has(d.view)) return;
        this.driftDumped.add(d.view);
        this.currentOp?.addEvent("drift", { view: d.view, similarity: d.similarity });
        this.emitQueue.push(() => this.faultDump("drift", `structure similarity ${d.similarity.toFixed(2)} for view ${d.view}`, d.view));
      });
    }
  }

  /** Dump a fault bundle (page still in the faulted state) — input for `a2flow diagnose`. */
  private async faultDump(reason: string, error?: string, expectedView?: string, unit?: unknown, at?: { snapshot: unknown; state: string; published: Record<string, unknown> }) {
    if (!this.recorder) return;
    const snap = await this.projector.sync().catch(() => undefined);
    const exp = expectedView ?? this.expected;
    let fingerprint: unknown;
    const fp = exp ? this.manifest.views[exp]?.fingerprint : undefined;
    if (fp) {
      const { fingerprintPage, similarity, structuralDiff } = await import("./fingerprint.js");
      const now = await fingerprintPage(this.adapter).catch(() => null);
      if (now) fingerprint = { view: exp, expected: fp, observed: now, similarity: similarity(fp, now), diff: structuralDiff(fp, now) };
    }
    const dir = await this.recorder.dump(reason, {
      adapter: this.adapter, error, unit, state: at?.state ?? this.stateLabel, view: snap?.view ?? this.projector.view, expectedView: exp,
      // the snapshot *at the fault* (state whose operation failed), not after the machine moved on
      machine: at ?? { published: this.published, snapshot: this.actor?.getPersistedSnapshot() }, stats: this.stats, fingerprint,
      projection: snap && { matchedView: snap.view, url: snap.url, model: snap.model },
    });
    this.faults.push(dir);
    this.emit("fault", { reason, dir, error });
    this.write("/health/lastFault", dir);
  }

  get results() { return this.sink.results; }

  // ---------------- control surface (the A2UI "user input" + operator view) ----------------

  private control(): Surface { return this.projector.store.surfaces.get(this.controlId)!; }
  /** Machine-authored control-surface writes (e.g. /run inputs) — persisted so a restored run can re-publish them. */
  private published: Record<string, unknown> = {};
  private write(path: string, value: unknown) { this.projector.publish(msg.updateDataModel(this.controlId, path, value)); }

  private openControl() {
    const c = this.manifest.control!;
    this.projector.publish(msg.createSurface(this.controlId, this.manifest.a2ui.catalogId, this.manifest.a2ui.theme));
    this.projector.publish(msg.updateComponents(this.controlId, c.components));
    this.projector.publish(msg.updateDataModel(this.controlId, "/", {
      ...(c.dataModel ?? {}), status: { state: "idle" }, work: this.ledger.summary(), attention: { message: "" },
    }));
  }

  private publishWork() { this.write("/work", this.ledger.summary()); }

  /** Client-side local write (A2UI write contract): what a renderer does when the user types. */
  clientWrite(path: string, value: unknown) {
    const s = this.control();
    s.dataModel = setAt(s.dataModel, path, value);
    this.emit("client-write", { surfaceId: s.surfaceId, path, value });
  }

  /** Press a control Button: resolve its {path}-bound context from the local model, send the action. */
  async press(componentId: string): Promise<ClientAction> {
    const s = this.control();
    const node = instancesOf(s, componentId)[0];
    if (!node) throw new Error(`control component ${componentId} not rendered`);
    const c = s.components.get(componentId) as Component;
    for (const check of (c.checks as any[]) ?? []) {
      const cond = check.condition;
      const v = cond?.call === "required" ? getAt(s.dataModel, cond.args?.value?.path ?? "/") : true;
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) throw new Error(check.message);
    }
    const a = buildAction(s, node);
    await this.handleClientAction(a);
    return a;
  }

  // ---------------- supervision (authoring loop / debugger) ----------------

  /** Current A2UI + machine state, for a supervisor deciding what to do at a breakpoint. */
  inspect() {
    const s = this.projector.store.current();
    return {
      state: this.stateLabel, view: this.projector.view, url: this.projector.last?.url,
      surface: s && { surfaceId: s.surfaceId, components: [...s.components.values()], dataModel: s.dataModel },
      context: (this.actor?.getSnapshot() as any)?.context, results: this.results, stats: this.stats,
    };
  }

  /** Hot-patch a view (selectors, model, anchors, actions, components); applies from the next step. */
  async patchView(id: string, view: FlowManifest["views"][string]) {
    this.manifest.views[id] = view;
    const views = Object.fromEntries(Object.entries(this.manifest.views).map(([k, v]) => [k, { match: v.match, model: Object.fromEntries(Object.entries(v.model).filter(([, ex]) => !(ex as any).net)) }]));
    await this.adapter.evaluate(`window.__a2flow && window.__a2flow.configure(${JSON.stringify(views)})`).catch(() => {});
    this.emit("log", `patched view "${id}"`);
  }

  /** Hot-patch a route (extract/from/map/schema); applies to the next emission. */
  patchRoute(name: string, route: FlowManifest["routes"][string]) {
    this.manifest.routes[name] = route;
    this.emit("log", `patched route "${name}"`);
  }

  /** Stop the run now (operator cancel, crash simulation, debugger). The ledger keeps what was done. */
  abort(reason = "aborted") { this.abortWith?.(new Error(reason)); }

  /** Entry point for every v0.2 client action (CLI, viewer, agent). */
  async handleClientAction(a: ClientAction) {
    this.emit("action", a);
    if (a.action.name === "resume" && this.resumeWaiter) { this.resumeWaiter(); return; }
    if (a.action.surfaceId === this.controlId) {
      this.actor?.send({ type: a.action.name, context: a.action.context, source: a.action.sourceComponentId });
    } else {
      await this.bridge.handle(a);
      this.actor?.send({ type: `a2ui.${a.action.name}`, context: a.action.context });
    }
  }

  /** Map plain CLI inputs onto the control form via its bindings, then press the button that sends `start`. */
  private async submitInputs(inputs: Record<string, unknown>) {
    const s = this.control();
    const ajv = new Ajv2020({ strict: false, useDefaults: true, validateFormats: false });
    const v = ajv.compile(this.manifest.inputs);
    const data = structuredClone(inputs);
    if (!v(data)) throw new Error(`invalid inputs: ${ajv.errorsText(v.errors)}`);
    const start = [...s.components.values()].find((c) => (c.action as any)?.event?.name === "start");
    if (!start) throw new Error("control surface has no Button with event 'start'");
    for (const [k, binding] of Object.entries((start.action as any).event.context ?? {}) as [string, any][]) {
      if (binding?.path && data[k] !== undefined) this.clientWrite(binding.path, data[k]);
    }
    await this.press(start.id);
  }

  // ---------------- resilience ----------------

  private async pace() {
    const { minDelayMs = 0, jitterMs = 0 } = this.policies.rateLimit;
    const wait = this.lastOpAt + minDelayMs + Math.random() * jitterMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastOpAt = Date.now();
  }

  private async dismissOverlays() {
    for (const d of this.policies.dismiss ?? []) {
      const visible = await this.adapter.evaluate<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(d.sel)});
        if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })()`).catch(() => false);
      if (!visible) continue;
      await this.adapter.click(d.sel).catch(() => this.adapter.evaluate(`document.querySelector(${JSON.stringify(d.sel)})?.click()`).catch(() => {}));
      this.stats.dismissed++;
      this.currentOp?.addEvent("overlay.dismissed", { selector: d.sel, intent: d.intent });
      this.emit("log", `dismissed overlay (${d.intent})`);
      await sleep(250);
    }
  }

  private async checkBlocked() {
    const b = this.policies.blocked;
    if (!b?.selectors?.length && !b?.textPatterns?.length) return;
    const hit = await this.adapter.evaluate<string | null>(`(() => {
      for (const s of ${JSON.stringify(b.selectors ?? [])}) { const e = document.querySelector(s); if (e && e.getBoundingClientRect().height > 0) return s; }
      const t = (document.body && document.body.innerText || "").slice(0, 20000);
      for (const p of ${JSON.stringify(b.textPatterns ?? [])}) if (new RegExp(p, "i").test(t)) return p;
      return null; })()`).catch(() => null);
    if (hit) { this.stats.blocked++; throw new OpError("blocked", `blocked: matched ${hit}`); }
  }

  /** Human-in-the-loop: surface the problem on the control surface and wait for an A2UI `resume`. */
  private async pauseForHuman(reason: string) {
    const url = await this.adapter.url().catch(() => "");
    this.write("/attention", { message: `${reason} — solve it in the browser, then press Resume`, url });
    this.write("/status/state", "paused");
    this.emit("log", `paused: ${reason}`);
    await new Promise<void>((r) => (this.resumeWaiter = r));
    this.resumeWaiter = undefined;
    this.write("/attention", { message: "" });
    this.write("/status/state", this.stateLabel);
  }

  private async relaunch() {
    if (!this.opts.relaunch) throw new OpError("crash", "browser crashed and no relaunch factory configured");
    await this.adapter.close().catch(() => {});
    this.adapter = await this.opts.relaunch();
    this.projector.adapter = this.adapter;
    this.bridge.adapter = this.adapter;
    await this.projector.attach();
    this.stats.recoveries.relaunch++;
    await this.recorder?.attach(this.adapter);
    if (this.lastGoodUrl) await this.adapter.goto(this.lastGoodUrl).catch(() => {});
  }

  private async recover(cls: string) {
    if (cls === "crash") { this.emit("log", "recover: relaunching browser"); await this.relaunch(); return; }
    if (cls === "timeout" || cls === "network" || cls === "unknown") {
      const url = this.lastGoodUrl ?? (await this.adapter.url().catch(() => undefined));
      if (url && url !== "about:blank") {
        this.emit("log", `recover: reload ${url}`);
        this.stats.recoveries.reload++;
        await withTimeout(this.adapter.goto(url), this.policies.timeouts.navigate!, "reload").catch((e) => {
          if (classify(e) === "crash") return this.relaunch();
        });
      }
      return;
    }
    // missing target: let the page settle and re-project before the next attempt
    this.stats.recoveries.resync++;
    await this.projector.settle(400, 4000).catch(() => {});
  }

  /** Run one page operation under policy; `effect()` reports whether a failed attempt already took effect. */
  private async guarded<T>(kind: OpKind, fn: () => Promise<T>, effect?: () => boolean): Promise<T> {
    const span = this.recorder?.startOp(`op ${kind}`, { "a2flow.op": kind, "a2flow.state": this.stateLabel, "a2flow.view": this.projector.view ?? "", "a2flow.expect": this.expected });
    this.currentOp = span;
    try {
      const r = await this.guardedInner(kind, fn, effect, span);
      if (span) this.recorder!.endOp(span);
      return r;
    } catch (e) {
      if (span) this.recorder!.endOp(span, String((e as Error)?.message ?? e).slice(0, 300));
      throw e;
    } finally { this.currentOp = undefined; }
  }

  private async guardedInner<T>(kind: OpKind, fn: () => Promise<T>, effect: (() => boolean) | undefined, span?: Span): Promise<T> {
    const attempts = this.policies.retry.attempts ?? 3;
    for (let i = 1; ; i++) {
      try {
        await this.pace();
        await this.dismissOverlays();
        await this.checkBlocked();
        return await withTimeout(fn(), this.policies.timeouts[kind] ?? 30_000, kind);
      } catch (e) {
        const cls = classify(e);
        const m = String((e as Error)?.message ?? e).split("\n")[0];
        span?.addEvent("attempt.failed", { attempt: i, "error.class": cls, "error.message": m.slice(0, 300) });
        if (effect?.()) { this.emit("log", `${kind}: error after it took effect (${m}) — treating as done`); span?.addEvent("took-effect"); return undefined as T; }
        this.emit("log", `${kind} attempt ${i}/${attempts} failed [${cls}]: ${m}`);
        this.write("/health", { lastError: `${kind} [${cls}] ${m}`.slice(0, 300), ...this.stats });
        if (cls === "blocked") {
          if ((this.policies.blocked?.action ?? "fail") === "pause") { await this.pauseForHuman(m); i--; continue; }
          throw e;
        }
        if (cls === "http-fatal" || i >= attempts) throw e;
        this.stats.retries++;
        span?.addEvent("recover", { "error.class": cls });
        await this.recover(cls);
        await sleep(backoff(i, this.policies.retry));
      }
    }
  }

  /** domhash structural similarity vs. the fingerprint captured at derive time. */
  private driftChecked = new Set<string>();
  private background: Promise<unknown>[] = [];
  /** Capture synchronously (page is in the right state now), hash + compare asynchronously. Once per view per document. */
  private async checkDrift(view: string, url: string) {
    const fp = this.manifest.views[view]?.fingerprint;
    const k = `${view} ${url}`;
    if (!fp || this.driftChecked.has(k)) return;
    this.driftChecked.add(k);
    const { capturePage, fingerprintCaptured, similarity } = await import("./fingerprint.js");
    const raw = await capturePage(this.adapter).catch(() => null);
    if (!raw) return;
    this.background.push(fingerprintCaptured(raw).then((now) => this.compareDrift(view, fp, now, similarity)).catch(() => {}));
  }
  private compareDrift(view: string, fp: NonNullable<FlowManifest["views"][string]["fingerprint"]>, now: { simhash: string }, similarity: (a: any, b: any) => number) {
    const sim = similarity(fp, now);
    this.emit("fingerprint", { view, similarity: sim, simhash: now.simhash });
    if (sim < (fp.minSimilarity ?? 0.5)) {
      this.emit("drift", { view, similarity: sim, expected: fp.simhash, observed: now.simhash });
      this.emit("log", `drift: view "${view}" structure similarity ${sim.toFixed(2)} < ${fp.minSimilarity ?? 0.5}`);
    }
  }

  // ---------------- machine ----------------

  private model() { return this.projector.store.current()?.dataModel ?? {}; }
  private scope(context: any, event: any): Scope {
    return { ...context, context, event, target: this.manifest.target };
  }

  /** Deep-evaluate templates + $model/$count reads. */
  private resolve(x: any, scope: Scope): any {
    if (typeof x === "string") return tmpl(x, scope);
    if (Array.isArray(x)) return x.map((y) => this.resolve(y, scope));
    if (x && typeof x === "object") {
      if (typeof x.$model === "string" && Object.keys(x).length === 1) return structuredClone(getAt(this.model(), x.$model) ?? null);
      if (typeof x.$count === "string" && Object.keys(x).length === 1) { const v = getAt(this.model(), x.$count); return Array.isArray(v) ? v.length : 0; }
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.resolve(v, scope)]));
    }
    return x;
  }

  /** Turn JSON params/input into XState param/input functions. */
  private hydrate(node: any): any {
    if (Array.isArray(node)) return node.map((n) => this.hydrate(n));
    if (!node || typeof node !== "object") return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "params" && node.type === "cond") {
        out.params = ({ context, event }: any) => ({ cond: v, scope: this.scope(context, event), stalled: context?.stall ?? 0 });
      } else if (k === "params" && node.type) {
        out.params = ({ context, event }: any) => this.resolve(v, this.scope(context, event));
      } else if (k === "input" && node.src) {
        out.input = ({ context, event }: any) => this.resolve(v, this.scope(context, event));
      } else out[k] = this.hydrate(v);
    }
    return out;
  }

  /** Every page-touching actor: flush pending emits, run under policy, then hit the barrier. */
  private async step<T>(kind: OpKind, fn: () => Promise<T>, effect?: () => boolean): Promise<T> {
    await this.flush();
    const r = await this.guarded(kind, fn, effect);
    const ev: StepEvent = { path: this.stateLabel, step: { log: kind } as any, kind, view: this.projector.view, scope: {}, ...(r && (r as any).action ? { action: (r as any).action } : {}) };
    this.emit("step", ev);
    await this.opts.afterStep?.(ev);
    return r;
  }
  private recordEmit(e: Emitted, path: string, view: string | null) {
    if (e.warning) this.emit("log", `warn: ${e.warning}`);
    if (!e.duplicate) {
      this.emit("item", { route: e.route, item: e.item });
      this.write(`/status/${e.route.replace(/\W+/g, "_")}`, this.sink.results[e.route].length);
    }
    this.pending.push({ path, step: { emit: e.route }, kind: "emit", view, scope: {}, emitted: { route: e.route, item: e.item, duplicate: e.duplicate } });
  }

  private async flush() {
    while (this.emitQueue.length) await this.emitQueue.shift()!();
    while (this.pending.length) {
      const ev = this.pending.shift()!;
      this.emit("step", ev);
      await this.opts.afterStep?.(ev);
    }
  }

  private build() {
    const self = this;
    const work = (status: "done" | "failed" | "skipped") => (_: any, p: { type: string; key: string; error?: string; reason?: string }) => {
      const id = Ledger.id(p.type, String(p.key));
      self.ledger.finish(p.type, String(p.key), status, p.error ?? p.reason);
      self.recorder?.endUnit(id, status, p.error ?? p.reason);
      self.emit("unit", { ...p, status });
      self.publishWork();
      if (status === "failed") {
        const unit = self.ledger.units.get(id);
        // inside a transition getPersistedSnapshot() is still the state that failed → replay restarts its operation
        const persisted: any = self.actor?.getPersistedSnapshot();
        const at = { snapshot: persisted, state: typeof persisted?.value === "string" ? persisted.value : JSON.stringify(persisted?.value), published: { ...self.published } };
        self.emitQueue.push(() => self.faultDump(`unit-failed-${p.type}`, p.error, undefined, unit, at));
      }
    };
    return setup({
      actions: {
        "ctx.set": assign((_: any, p: Record<string, unknown>) => p),
        "ctx.shift": assign(({ context }: any, p: { from: string; to: string }) => {
          const q = [...((context[p.from] as unknown[]) ?? [])];
          const x = q.shift();
          return { [p.from]: q, [p.to]: x ?? null };
        }),
        "ctx.inc": assign(({ context }: any, p: { key: string; by?: number }) => ({ [p.key]: Number(context[p.key] ?? 0) + (p.by ?? 1) })),
        "ctx.stall": assign(({ context }: any, p: { count: number; key?: string }) => {
          const k = p.key ?? "stall";
          const same = context[`${k}Last`] === p.count;
          return { [k]: same ? Number(context[k] ?? 0) + 1 : 0, [`${k}Last`]: p.count };
        }),
        "route.emit": ({ context, event }: any, p: { route: string }) => {
          const r = self.manifest.routes[p.route];
          const path = self.stateLabel, view = self.projector.view;
          if (r?.extract && r.from?.on === "item") {
            const model = structuredClone(self.model()), surfaces = structuredClone(self.lastByView);
            self.emitQueue.push(async () => { for (const e of await self.sink.emitItems(p.route, model, surfaces, view ?? "")) self.recordEmit(e, path, view); });
          } else if (r?.extract) {
            // JSONata is async: snapshot the A2UI state now, evaluate before the next page operation
            const model = structuredClone(self.model()), surfaces = structuredClone(self.lastByView);
            self.emitQueue.push(async () => self.recordEmit(await self.sink.emitExtract(p.route, model, surfaces, view ?? ""), path, view));
          } else self.recordEmit(self.sink.emit(p.route, self.model(), self.scope(context, event)), path, view);
        },
        "work.start": (_: any, p: { type: string; key: string; parent?: string }) => {
          self.ledger.start(p.type, String(p.key), p.parent);
          self.recorder?.startUnit(Ledger.id(p.type, String(p.key)), { "a2flow.unit.type": p.type, "a2flow.unit.key": String(p.key), ...(p.parent ? { "a2flow.unit.parent": p.parent } : {}) });
          self.emit("unit", { ...p, status: "running" });
          self.publishWork();
        },
        "work.complete": work("done"),
        "work.fail": work("failed"),
        "work.skip": work("skipped"),
        "a2ui.write": (_: any, p: { path: string; value: unknown }) => { self.published[p.path] = p.value; self.write(p.path, p.value); },
        log: (_: any, p: { text: string }) => { self.emit("log", p.text); },
      },
      guards: {
        cond: (_: any, p: { cond: Cond; scope: Scope; stalled: number }) =>
          evalCond(p.cond, { model: self.model(), scope: p.scope, view: self.projector.view, stalled: p.stalled }),
        "work.done": (_: any, p: { type: string; key: string }) => self.ledger.isDone(p.type, String(p.key)),
      },
      actors: {
        "browser.navigate": fromPromise(async ({ input }: { input: { url: string } }) => self.step("navigate", async () => {
          const url = new URL(input.url, self.manifest.target.baseUrl).href;
          if (self.opts.reuseOpenPage && !self.reusedOnce) {
            self.reusedOnce = true;
            const here = await self.adapter.url().catch(() => "");
            const same = (a: string, b: string) => { try { const x = new URL(a), y = new URL(b); return x.host === y.host && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, ""); } catch { return false; } };
            if (same(here, url)) {
              self.emit("log", `reuse open page ${url} (no reload)`);
              for (const r of self.opts.seedNet ?? []) await self.projector.seedNet(r.url, r.method, r.body, new URL(url).pathname);
              return { url, status: 200 };
            }
          }
          self.emit("log", `navigate ${url}`);
          const { status } = await self.adapter.goto(url);
          if (status && status >= 400) {
            self.stats.httpErrors++;
            // an error status is a fault only if no declared view (e.g. a "not found" outcome) explains the page
            const explained = await self.projector.sync().then((s) => s?.view).catch(() => null);
            if (explained) { self.emit("log", `HTTP ${status} explained by view "${explained}"`); return { url, status, view: explained }; }
            if (self.policies.http.fatal?.includes(status)) throw new OpError("http-fatal", `HTTP ${status} for ${url}`, status);
            throw new OpError("network", `HTTP ${status} for ${url}`, status);
          }
          return { url, status };
        })),
        // Wait for ANY of the expected views (normal + outcome states); the machine branches on output.view.
        "view.await": fromPromise(async ({ input }: { input: { view?: string; views?: string[]; until?: Cond; timeoutMs?: number; scope?: Scope } }) => self.step("await", async () => {
          const views = input.views ?? [input.view!];
          self.expected = views[0];
          for (const id of views) if (!self.manifest.views[id]) throw new Error(`unknown view ${id}`);
          const primary = self.manifest.views[views[0]];
          const snap = await self.projector.waitFor((s) => !!s.view && views.includes(s.view) && (!input.until || s.view !== views[0] || evalCond(input.until, { model: s.model, scope: input.scope ?? {}, view: s.view, stalled: 0 })),
            input.timeoutMs ?? primary.settle?.timeoutMs ?? self.policies.timeouts.await ?? 30_000, `view ${views.map((v) => `"${v}"`).join(" | ")}`);
          await self.projector.settle(self.manifest.views[snap.view!]?.settle?.quietMs ?? 300, 8000);
          if (!self.manifest.views[snap.view!].outcome) self.lastGoodUrl = snap.url;
          await self.checkDrift(snap.view!, snap.url);
          return { view: snap.view, url: snap.url };
        })),
        "a2ui.act": fromPromise(async ({ input }: { input: { on: string; action?: string; item?: number | Record<string, unknown>; expect?: string | string[]; within?: number } }) => {
          const startView = self.projector.view;
          const expect = input.expect == null ? undefined : ([] as string[]).concat(input.expect);
          if (expect) self.expected = expect[0];
          // idempotency: an action that already moved us to an expected view must not be repeated
          const tookEffect = () => (expect ? expect.includes(self.projector.view ?? "") && self.projector.view !== startView : self.projector.view !== startView && startView != null);
          return self.step("action", async () => {
            const s = self.projector.store.current();
            const declared = (s?.components.get(input.on)?.action as any)?.event?.name;
            if (input.action && declared && input.action !== declared) throw new Error(`${input.on} raises "${declared}", not "${input.action}"`);
            const action = await self.driver.act(input.on, typeof input.item === "string" ? Number(input.item) : input.item);
            await self.projector.settle(150, 6000);
            if (expect) { // expectation: the action must lead to one of these views within the budget
              await self.projector.waitFor((s) => expect.includes(s.view ?? ""), input.within ?? 10_000, `view ${expect.join("|")} after ${input.on}`)
                .catch(() => { throw new OpError("unexpected", `expected ${expect.join("|")} after ${action.action.name} on ${input.on}, got "${self.projector.view}"`); });
            }
            return { action };
          }, tookEffect);
        }),
        "a2ui.input": fromPromise(async ({ input }: { input: { component: string; value: unknown } }) => self.step("input", async () => {
          const action = await self.driver.input(input.component, input.value);
          return { action };
        })),
      },
    }).createMachine(this.hydrate(this.manifest.machine) as any);
  }

  /** Run to a final state. Without `inputs`, waits for a `start` action from an A2UI client (viewer). */
  async run(): Promise<Record<string, Record<string, unknown>[]>> {
    try { return await this.runInner(); } catch (e) {
      await this.flush().catch(() => {});
      await this.faultDump("run-failed", String((e as Error)?.message ?? e)).catch(() => {});
      this.recorder?.endRun(String((e as Error)?.message ?? e));
      throw e;
    }
  }

  private async runInner(): Promise<Record<string, Record<string, unknown>[]>> {
    await this.recorder?.attach(this.adapter);
    this.recorder?.startRun({ "a2flow.adapter": this.adapter.kind, "a2flow.base_url": this.manifest.target.baseUrl, "a2flow.out_dir": this.opts.outDir ?? "" });
    await this.projector.attach();
    this.openControl();
    const machine = this.build();
    if (this.opts.startUrl) await this.adapter.goto(this.opts.startUrl).catch(() => {});
    const actor = createActor(machine, this.opts.restore ? { snapshot: this.opts.restore as any } : undefined);
    this.actor = actor;
    if (this.opts.outDir) mkdirSync(this.opts.outDir, { recursive: true });
    actor.subscribe({
      next: (snap: any) => {
        const label = typeof snap.value === "string" ? snap.value : JSON.stringify(snap.value);
        if (label !== this.stateLabel) {
          this.stateLabel = label;
          this.emit("state", { value: snap.value, context: snap.context });
          this.write("/status/state", label);
        }
        // operator view + post-mortem: the persisted XState snapshot after every transition
        if (this.opts.outDir && !this.snapTimer) {
          this.snapTimer = setTimeout(() => {
            this.snapTimer = undefined;
            writeFile(join(this.opts.outDir!, "machine.json"), JSON.stringify({ at: new Date().toISOString(), stats: this.stats, published: this.published, snapshot: actor.getPersistedSnapshot() }, null, 1)).catch(() => {});
          }, 300);
        }
      },
      error: () => {},
    });
    const done = new Promise<void>((res, rej) => {
      actor.subscribe({ complete: () => res(), error: (e) => rej(e) });
      this.abortWith = (e) => { rej(e); actor.stop(); }; // reject first: stop() fires `complete`
    });
    actor.start();
    // interrupts (modal/banner/captcha views) → INTERRUPT to the machine's root handler, else the dismiss policy
    const handles = !!(this.manifest.machine as any)?.on?.INTERRUPT;
    this.projector.on("interrupt", (e: { view: string; present: boolean }) => {
      this.emit("log", `interrupt ${e.present ? "appeared" : "cleared"}: ${e.view}`);
      if (!e.present) return;
      if (handles) actor.send({ type: "INTERRUPT", view: e.view });
      else void this.dismissOverlays().catch(() => {});
    });
    if (this.inputs && !this.opts.restore) await this.submitInputs(this.inputs);
    for (const [path, value] of Object.entries(this.opts.restorePublished ?? {})) { this.published[path] = value; this.write(path, value); }
    await done;
    await this.flush();
    await Promise.allSettled(this.background); // drift hashing etc.
    await this.recorder?.drain();
    const snap: any = actor.getSnapshot();
    this.write("/health", { ...this.stats, lastError: snap.context?.error ?? "" });
    if (snap.value === "failed") throw new Error(`machine ended in "failed": ${snap.context?.error ?? "unknown error"}`);
    this.recorder?.endRun();
    if (this.opts.outDir && this.recorder) writeFileSync(join(this.opts.outDir, "spans.otlp.json"), JSON.stringify(this.recorder.otlp()));
    return this.results;
  }
}
