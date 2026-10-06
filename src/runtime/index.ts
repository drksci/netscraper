import type { BrowserAdapter } from "../adapters/types.js";
import type { FlowManifest } from "../manifest/types.js";
import { MachineRunner } from "../machine/runner.js";
import { FlowRunner, type RunOptions } from "./runner.js";

export type AnyRunner = FlowRunner | MachineRunner;

/** v0.2 manifests (control + machine) run on XState; v0.1 (flow) on the linear runner. */
export function createRunner(m: FlowManifest, a: BrowserAdapter, inputs: Record<string, unknown> | undefined, opts: RunOptions & { outDir?: string; relaunch?: () => Promise<BrowserAdapter> } = {}): AnyRunner {
  return m.machine ? new MachineRunner(m, a, inputs, opts) : new FlowRunner(m, a, inputs ?? {}, opts);
}
