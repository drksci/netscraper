import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FlowManifest, Step } from "./types.js";
import type { Component, ServerMessage } from "../a2ui/types.js";
import { lintMachine } from "../machine/lint.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

let ajv: InstanceType<typeof Ajv2020> | undefined;
function validators() {
  if (ajv) return ajv;
  ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(readJson("vendor/a2ui/v0_9/common_types.json"));
  // server_to_client/common_types reference the active catalog as relative "catalog.json"
  ajv.addSchema({ ...readJson("vendor/a2ui/v0_9/catalog.json"), $id: "https://a2ui.org/specification/v0_9/catalog.json" });
  ajv.addSchema(readJson("vendor/a2ui/v0_9/server_to_client.json"));
  ajv.addSchema(readJson("vendor/a2ui/v0_9/client_to_server.json"), "a2ui:client_to_server");
  ajv.addSchema(readJson("schema/a2flow.schema.json"));
  return ajv;
}

const fmt = (errs: any[] | null | undefined) =>
  (errs ?? []).slice(0, 8).map((e) => `${e.instancePath || "/"} ${e.message}${e.params ? " " + JSON.stringify(e.params) : ""}`);

/** Validate one server→client message against the official v0.9 schema + basic catalog. */
export function validateServerMessage(m: ServerMessage): string[] {
  const v = validators().getSchema("https://a2ui.org/specification/v0_9/server_to_client.json")!;
  return v(m) ? [] : fmt(v.errors);
}
export function validateClientMessage(m: unknown): string[] {
  const v = validators().getSchema("a2ui:client_to_server")!;
  return v(m) ? [] : fmt(v.errors);
}
export function validateComponents(cs: Component[]): string[] {
  return validateServerMessage({ version: "v0.9", updateComponents: { surfaceId: "lint", components: cs } });
}

export function loadManifest(path: string): FlowManifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as FlowManifest;
  const errors = checkManifest(m);
  if (errors.length) throw new Error(`invalid manifest ${path}:\n  - ${errors.join("\n  - ")}`);
  return m;
}

/** Schema + A2UI catalog + cross-reference checks. Returns human-readable errors. */
export function checkManifest(m: FlowManifest): string[] {
  const v = validators().getSchema("https://a2flow.dev/schema/0.1/a2flow.schema.json")!;
  if (!v(m)) return fmt(v.errors);
  const errs: string[] = [];
  for (const [vid, view] of Object.entries(m.views)) {
    errs.push(...validateComponents(view.components).map((e) => `views.${vid}.components${e}`));
    const ids = new Set(view.components.map((c) => c.id));
    for (const a of Object.keys(view.anchors)) if (!ids.has(a)) errs.push(`views.${vid}.anchors.${a}: no such component`);
    for (const [name, am] of Object.entries(view.actions)) {
      if (am.anchor && !view.anchors[am.anchor]) errs.push(`views.${vid}.actions.${name}: anchor ${am.anchor} not defined`);
      if (am.reveal && !view.actions[am.reveal]) errs.push(`views.${vid}.actions.${name}: reveal ${am.reveal} not an action`);
    }
    for (const c of view.components) {
      const ev = (c.action as any)?.event?.name;
      if (ev && !view.actions[ev]) errs.push(`views.${vid}.components.${c.id}: event "${ev}" has no action mapping`);
    }
  }
  const walk = (steps: Step[], at: string) => steps.forEach((s, i) => {
    const p = `${at}[${i}]`;
    if ("await" in s && !m.views[s.await.view]) errs.push(`${p}: unknown view ${s.await.view}`);
    if ("emit" in s && !m.routes[s.emit]) errs.push(`${p}: unknown route ${s.emit}`);
    if ("action" in s && !Object.values(m.views).some((v) => v.actions[s.action])) errs.push(`${p}: unknown action ${s.action}`);
    if ("repeat" in s) walk(s.repeat.do, `${p}.repeat.do`);
    if ("forEach" in s) walk(s.forEach.do, `${p}.forEach.do`);
  });
  walk(m.flow ?? [], "flow");
  if (m.control) errs.push(...validateComponents(m.control.components).map((e) => `control.components${e}`));
  if (m.machine) errs.push(...lintMachine(m));
  // interrupts must be handled end-to-end: a root INTERRUPT transition, and each interrupt view needs an action to clear it
  const interrupts = Object.entries(m.views).filter(([, v]) => v.interrupt);
  if (interrupts.length && m.machine) {
    if (!(m.machine as any).on?.INTERRUPT) errs.push(`machine: interrupt views (${interrupts.map(([k]) => k).join(", ")}) need a root "on": { "INTERRUPT": … } handler — e.g. target ".interrupted" which invokes a2ui.act { on: "dismiss" } and returns via a { "type": "history", "history": "deep" } state`);
    for (const [k, v] of interrupts) if (!Object.keys(v.actions ?? {}).length) errs.push(`views.${k}: interrupt view has no actions (e.g. "dismiss" → click the close button)`);
  }
  // routes reading $surfaces.control.run.<x> need <x> to be an input the start button binds (else it's undefined at run time)
  if (m.control && m.machine) {
    const start = m.control.components.find((c: any) => c.action?.event?.name === "start") as any;
    const bound = new Set(Object.keys(start?.action?.event?.context ?? {}));
    const props = new Set(Object.keys((m.inputs as any)?.properties ?? {}));
    for (const [name, r] of Object.entries(m.routes)) {
      for (const [, x] of (r.extract ?? "").matchAll(/\$surfaces\.control\.run\.(\w+)/g)) {
        if (!props.has(x)) errs.push(`routes.${name}.extract: reads $surfaces.control.run.${x} but inputs has no property "${x}"`);
        else if (!bound.has(x)) errs.push(`routes.${name}.extract: reads $surfaces.control.run.${x} but the start Button's event.context doesn't bind "${x}"`);
      }
    }
  }
  return errs;
}
