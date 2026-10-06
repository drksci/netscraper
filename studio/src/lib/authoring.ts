"use client";
import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import { sessionApi } from "./session-store";

export type ToolPart = {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: any;
  output?: unknown;
  errorText?: string;
};

export const toolName = (p: ToolPart) => p.toolName.replace(/^mcp__a2flow__/, "");
export const isStreaming = (p?: ToolPart | null) => p?.state === "input-streaming";
export const isBrowserTool = (name: string) => name.startsWith("browser_") || name === "highlight" || name === "clear_highlights";

export function toolParts(messages: UIMessage[]): ToolPart[] {
  const out: ToolPart[] = [];
  for (const m of messages) for (const p of m.parts) if (p.type === "dynamic-tool") out.push(p as unknown as ToolPart);
  return out;
}

export type DocKind = "schema" | "expected" | "manifest";
const DOC_OF: Record<string, DocKind> = { propose_schema: "schema", record_expected: "expected", write_manifest: "manifest", patch_manifest: "manifest" };

export interface Authoring {
  /** any authoring tool called so far */
  started: boolean;
  /** doc currently streaming */
  active: DocKind | null;
  schema: ToolPart | null;
  expected: ToolPart | null;
  manifest: ToolPart | null;
  /** run_manifest / parity in flight → the browser (with A2UI overlaid) is the thing to watch */
  running: boolean;
}

export function deriveAuthoring(parts: ToolPart[]): Authoring {
  const a: Authoring = { started: false, active: null, schema: null, expected: null, manifest: null, running: false };
  for (const p of parts) {
    const n = toolName(p);
    if (n === "run_manifest" || n === "parity") a.running = p.state !== "output-available" && p.state !== "output-error";
    const kind = DOC_OF[toolName(p)];
    if (!kind) continue;
    a.started = true;
    a[kind] = p;
    if (isStreaming(p)) a.active = kind;
    else if (a.active === kind) a.active = null;
  }
  return a;
}

/** RFC 7396-style merge, or a minimal RFC 6902 apply when the patch is an op array. Best effort, never throws. */
export function applyPatch(doc: any, patch: any): any {
  const clone = (v: any) => JSON.parse(JSON.stringify(v ?? {}));
  try {
    if (Array.isArray(patch)) {
      const out = clone(doc);
      for (const op of patch) {
        if (!op || typeof op.path !== "string") continue;
        const keys = op.path.split("/").slice(1).map((k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
        if (!keys.length) continue;
        let c = out;
        for (let i = 0; i < keys.length - 1 && c != null; i++) c = c[keys[i]];
        const last = keys[keys.length - 1];
        if (c == null || typeof c !== "object") continue;
        if (op.op === "remove") { Array.isArray(c) ? c.splice(Number(last), 1) : delete c[last]; }
        else if (op.op === "add" && Array.isArray(c)) c.splice(last === "-" ? c.length : Number(last), 0, op.value);
        else if (op.op === "add" || op.op === "replace") c[last] = op.value;
      }
      return out;
    }
    const merge = (a: any, b: any): any => {
      if (!b || typeof b !== "object" || Array.isArray(b)) return b;
      const out = a && typeof a === "object" && !Array.isArray(a) ? { ...a } : {};
      for (const [k, v] of Object.entries(b)) { if (v === null) delete out[k]; else out[k] = merge(out[k], v); }
      return out;
    };
    return merge(doc, patch);
  } catch { return doc; }
}

/**
 * While the manifest is being written, push its (partial) views as draft facets, throttled (a debounce
 * would never fire while tokens keep arriving); when the tool finishes revert to the written manifest.
 */
export function useDraftFacets(streaming: boolean, views: Record<string, unknown> | undefined) {
  const latest = useRef(views);
  latest.current = views;
  const live = useRef(streaming);
  live.current = streaming;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef("");
  const was = useRef(false);

  useEffect(() => {
    if (!streaming || !views || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!live.current || !latest.current) return;
      const sig = JSON.stringify(latest.current);
      if (sig === sent.current) return;
      sent.current = sig;
      void sessionApi.post("facets", { views: latest.current });
    }, 350);
  }, [streaming, views]);

  useEffect(() => {
    if (was.current && !streaming) {
      clearTimeout(timer.current);
      timer.current = undefined;
      sent.current = "";
      void sessionApi.post("facets", { views: null });
    }
    was.current = streaming;
  }, [streaming]);

  useEffect(() => () => clearTimeout(timer.current), []);
}
