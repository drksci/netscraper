/**
 * Step controller — the lockstep/breakpoint protocol between the runtime and whoever is
 * supervising it (the authoring LLM loop, the side-by-side harness, a human in the viewer).
 *
 *   breakpoints  by step kind ("emit", "action", "await"…), by machine state name, or "*" (every step)
 *   gate(ev)     plugged into the runner's afterStep barrier; resolves when the supervisor continues
 *   continue()   resume until the next breakpoint; step() resume for exactly one step
 *   inspect()    current A2UI surface, machine snapshot, last step, recent emits — everything needed to decide
 *
 * While paused, the supervisor may hot-patch the manifest (runner.patchView / patchRoute) and the
 * change applies from the next step on, without restarting the browser or losing machine state.
 */
import { EventEmitter } from "node:events";
import type { StepEvent } from "../runtime/runner.js";

export type Breakpoint = "*" | StepEvent["kind"] | { state: string } | ((ev: StepEvent) => boolean);

export class Stepper extends EventEmitter {
  private breakpoints: Breakpoint[] = [];
  private stepOnce = false;
  private waiting?: () => void;
  paused?: StepEvent;
  readonly history: StepEvent[] = [];

  constructor(bps: Breakpoint[] = []) { super(); this.breakpoints = bps; }

  setBreakpoints(bps: Breakpoint[]) { this.breakpoints = bps; }

  private hits(ev: StepEvent): boolean {
    if (this.stepOnce) return true;
    return this.breakpoints.some((b) => b === "*" || b === ev.kind || (typeof b === "object" && ev.path === b.state) || (typeof b === "function" && b(ev)));
  }

  /** afterStep barrier. */
  gate = async (ev: StepEvent): Promise<void> => {
    this.history.push(ev);
    if (this.history.length > 500) this.history.shift();
    if (!this.hits(ev)) return;
    this.stepOnce = false;
    this.paused = ev;
    this.emit("paused", ev);
    await new Promise<void>((r) => (this.waiting = r));
    this.paused = undefined;
  };

  continue() { const w = this.waiting; this.waiting = undefined; w?.(); }
  step() { this.stepOnce = true; this.continue(); }
  get isPaused() { return !!this.paused; }

  /** Resolve when the run next pauses (or `timeoutMs`). */
  nextPause(timeoutMs = 120_000): Promise<StepEvent | undefined> {
    if (this.paused) return Promise.resolve(this.paused);
    return new Promise((res) => {
      const t = setTimeout(() => { this.off("paused", on); res(undefined); }, timeoutMs);
      const on = (ev: StepEvent) => { clearTimeout(t); res(ev); };
      this.once("paused", on);
    });
  }
}
