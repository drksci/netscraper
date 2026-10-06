import type { FlowManifest } from "../manifest/types.js";

/** Implementations the runtime provides for JSON machine configs. */
export const LIBRARY = {
  actions: ["ctx.set", "ctx.shift", "ctx.inc", "ctx.stall", "route.emit", "work.start", "work.complete", "work.fail", "work.skip", "a2ui.write", "log"],
  guards: ["cond", "work.done"],
  actors: ["browser.navigate", "view.await", "a2ui.act", "a2ui.input"],
} as const;

/** Static checks: every referenced action/guard/actor exists in the library; targets resolve. */
export function lintMachine(m: FlowManifest): string[] {
  const errs: string[] = [];
  if (!m.machine) return errs;
  const states = new Set<string>();
  const walkStates = (node: any, path: string) => {
    for (const [k, st] of Object.entries(node.states ?? {}) as [string, any][]) { states.add(k); walkStates(st, `${path}.${k}`); }
  };
  walkStates(m.machine, "machine");
  const check = (x: any, at: string) => {
    if (Array.isArray(x)) return x.forEach((y, i) => check(y, `${at}[${i}]`));
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      const here = `${at}.${k}`;
      if ((k === "entry" || k === "exit" || k === "actions") && v) {
        for (const a of ([] as any[]).concat(v)) {
          const t = typeof a === "string" ? a : a?.type;
          if (!(LIBRARY.actions as readonly string[]).includes(t)) errs.push(`${here}: unknown action "${t}"`);
        }
      } else if (k === "guard" && v) {
        const t = typeof v === "string" ? v : (v as any).type;
        if (!(LIBRARY.guards as readonly string[]).includes(t)) errs.push(`${here}: unknown guard "${t}"`);
      } else if (k === "src" && typeof v === "string" && !(LIBRARY.actors as readonly string[]).includes(v)) errs.push(`${here}: unknown actor "${v}"`);
      else if (k === "target" && typeof v === "string" && !states.has(v.replace(/^[.#]/, "").split(".").pop()!)) errs.push(`${here}: unknown target "${v}"`);
      if (k !== "params" && k !== "input" && k !== "context") check(v, here);
    }
  };
  check(m.machine, "machine");
  // string shorthand targets: on: { start: "next" }, onDone: "x"
  const shorthand = (x: any, at: string) => {
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === "string" && (k === "onDone" || k === "onError" || (at.endsWith(".on")))) {
        if (!states.has(v.replace(/^[.#]/, "").split(".").pop()!)) errs.push(`${at}.${k}: unknown target "${v}"`);
      } else if (k !== "params" && k !== "input" && k !== "context") shorthand(v, `${at}.${k}`);
    }
  };
  shorthand(m.machine, "machine");
  return errs;
}
