/**
 * Executes a manifest's flow. Every interaction is an A2UI action dispatched by the A2UIDriver
 * against the projected surface; every emitted record is read from the A2UI data model.
 */
import { EventEmitter } from "node:events";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { BrowserAdapter } from "../adapters/types.js";
import type { ClientAction } from "../a2ui/types.js";
import type { FlowManifest, Step } from "../manifest/types.js";
import { Projector } from "../render/projector.js";
import { ActionBridge } from "./bridge.js";
import { A2UIDriver } from "./driver.js";
import { evalCond, tmpl, type Scope } from "./expr.js";
import { getAt } from "../a2ui/pointer.js";
import { RouteSink } from "./routes.js";

export interface StepEvent {
  path: string;
  step: Step;
  kind: "navigate" | "await" | "action" | "input" | "emit" | "log";
  view: string | null;
  scope: Scope;
  action?: ClientAction;
  emitted?: { route: string; item: Record<string, unknown>; duplicate: boolean };
}

export interface RunOptions {
  /** Awaited after every primitive step — the side-by-side harness uses this as its barrier. */
  afterStep?: (e: StepEvent) => Promise<void>;
  surfacePrefix?: string;
}

export class FlowRunner extends EventEmitter {
  readonly projector: Projector;
  readonly bridge: ActionBridge;
  readonly driver: A2UIDriver;
  private sink: RouteSink;
  readonly inputs: Record<string, unknown>;
  private ajv = new Ajv2020({ strict: false, useDefaults: true, allErrors: true, validateFormats: false });

  constructor(readonly manifest: FlowManifest, readonly adapter: BrowserAdapter, inputs: Record<string, unknown>, private opts: RunOptions = {}) {
    super();
    this.inputs = structuredClone(inputs);
    const vi = this.ajv.compile(manifest.inputs);
    if (!vi(this.inputs)) throw new Error(`invalid inputs: ${this.ajv.errorsText(vi.errors)}`);
    this.projector = new Projector(adapter, manifest, opts.surfacePrefix);
    this.projector.on("message", (m) => this.emit("message", m));
    this.bridge = new ActionBridge(adapter, manifest, this.projector);
    this.driver = new A2UIDriver(this.projector.store, async (a) => { this.emit("action", a); await this.bridge.handle(a); });
    this.sink = new RouteSink(manifest);
  }

  get results() { return this.sink.results; }

  async run(): Promise<Record<string, Record<string, unknown>[]>> {
    await this.projector.attach();
    await this.exec(this.manifest.flow ?? [], { inputs: this.inputs, target: this.manifest.target }, "flow");
    return this.results;
  }

  private model(): unknown { return this.projector.store.current()?.dataModel ?? {}; }

  private async exec(steps: Step[], scope: Scope, at: string): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const path = `${at}[${i}]`;
      const done = async (e: Omit<StepEvent, "path" | "step" | "view" | "scope">) => {
        const ev: StepEvent = { path, step, view: this.projector.view, scope, ...e };
        this.emit("step", ev);
        await this.opts.afterStep?.(ev);
      };

      if ("navigate" in step) {
        const url = new URL(String(tmpl(step.navigate, scope)), this.manifest.target.baseUrl).href;
        this.emit("log", `navigate ${url}`);
        await this.adapter.goto(url);
        await done({ kind: "navigate" });
      } else if ("await" in step) {
        const { view, until, timeoutMs } = step.await;
        const v = this.manifest.views[view];
        await this.projector.waitFor(
          (s) => s.view === view && (!until || evalCond(until, { model: s.model, scope, view: s.view, stalled: 0 })),
          timeoutMs ?? v.settle?.timeoutMs ?? 30_000, `view "${view}"`);
        await this.projector.settle(v.settle?.quietMs ?? 500, 8000);
        await done({ kind: "await" });
      } else if ("action" in step) {
        const item = step.item == null ? undefined
          : typeof step.item === "object" ? Object.fromEntries(Object.entries(step.item).map(([k, x]) => [k, tmpl(x, scope)]))
          : Number(typeof step.item === "string" ? tmpl(step.item, scope) : step.item);
        const action = await this.driver.act(step.on, item as any);
        await this.projector.settle(300, 6000);
        await done({ kind: "action", action });
      } else if ("input" in step) {
        const action = await this.driver.input(step.input, tmpl(step.value, scope));
        await done({ kind: "input", action });
      } else if ("emit" in step) {
        await this.projector.sync();
        const emitted = this.emitRoute(step.emit, scope);
        await done({ kind: "emit", emitted });
      } else if ("set" in step) {
        await this.projector.sync();
        for (const [k, expr] of Object.entries(step.set)) {
          scope[k] = structuredClone(expr.startsWith("/") ? getAt(this.model(), expr) : tmpl(expr, scope));
        }
      } else if ("log" in step) {
        this.emit("log", String(tmpl(step.log, scope)));
      } else if ("repeat" in step) {
        const { until, max = 50, do: body } = step.repeat;
        let stalled = 0, prev = JSON.stringify(this.model());
        for (let n = 0; n < max; n++) {
          if (evalCond(until, { model: this.model(), scope, view: this.projector.view, stalled })) break;
          await this.exec(body, scope, `${path}.repeat#${n}`);
          const cur = JSON.stringify(this.model());
          stalled = cur === prev ? stalled + 1 : 0;
          prev = cur;
        }
      } else if ("forEach" in step) {
        const { in: src, as, limit, do: body } = step.forEach;
        const raw = src.startsWith("/") ? getAt(this.model(), src) : tmpl(src, scope);
        const list = structuredClone(Array.isArray(raw) ? raw : raw == null ? [] : [raw]);
        const lim = limit == null ? list.length : Number(typeof limit === "string" ? tmpl(limit, scope) : limit);
        for (let k = 0; k < Math.min(lim, list.length); k++) {
          await this.exec(body, { ...scope, [as]: list[k], $index: k }, `${path}.forEach#${k}`);
        }
      }
    }
  }

  private emitRoute(route: string, scope: Scope) {
    const e = this.sink.emit(route, this.model(), scope);
    if (e.warning) this.emit("log", `warn: ${e.warning}`);
    if (!e.duplicate) this.emit("item", { route, item: e.item });
    return { route: e.route, item: e.item, duplicate: e.duplicate };
  }
}
