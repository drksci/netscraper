/**
 * a2flow Studio session server (port 7801):
 *   GET  /events          SSE stream for the UI (frames, phase, highlights, schema, manifest, A2UI, parity…)
 *   POST /scroll|click|navigate|action   UI → live browser / A2UI surface
 *   POST /facets {views|null}  draft views for the facet feed (UI streams the manifest being written)
 *   GET  /scenes, /scenes/:id, /scenes/:id/frame/:i  every action/run as a buffered scene (frames + facets + acts + A2UI on one clock)
 *   GET  /timeline, /timeline/frame/:i  the last run's scene (compat)
 *   GET  /system-prompt   default agent system prompt;  GET /state
 *   POST /mcp             MCP (streamable HTTP, stateless) — the authoring agent's tools
 *   WS   /actor/cdp       raw CDP to a dedicated sandboxed headless browser for the in-browser (QuickJS-wasm) actor
 *
 *   tsx src/studio/server.ts [--port 7801] [--headful]
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { StudioSession } from "./session.js";
import { digestJson, forModel } from "./sanitize.js";
import { researchSite } from "./research.js";
import { attachActorCdpProxy } from "./actor-cdp.js";

/** First object of the largest object-array in a payload (the "record"), else the payload. */
function firstRecord(json: unknown): unknown {
  let best: unknown[] | null = null;
  const find = (v: unknown, d: number) => {
    if (d > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { if (v.some((x) => x && typeof x === "object") && (!best || v.length > best.length)) best = v; return; }
    for (const x of Object.values(v)) find(x, d + 1);
  };
  find(json, 0);
  return best ? (best as unknown[]).find((x) => x && typeof x === "object") : json;
}
import type { FlowManifest } from "../manifest/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(here, "system-prompt.md"), "utf8");
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const PORT = Number(arg("--port") ?? 7801);
const session = new StudioSession({ headless: !process.argv.includes("--headful"), outDir: "out/studio" });

// every text result is sanitised: no base64/data URLs, capped strings/arrays, no fingerprint vectors
// every tool result is hard-capped: observations are digests, not dumps
const text = (t: unknown, cap = 9000) => ({ type: "text" as const, text: forModel(t, cap) });
const ok = (t: unknown) => ({ content: [text(t)] });
const fail = (e: unknown) => ({ content: [text(`ERROR: ${(e as Error)?.message ?? e}`)], isError: true });
const guard = <A,>(fn: (a: A) => Promise<{ content: any[] }>) => async (a: A) => {
  try { await session.ensure(); return await fn(a); } catch (e) { session.broadcast({ type: "log", text: `tool error: ${(e as Error).message}` }); return fail(e); }
};

/** Text-first observation; a (downscaled) screenshot only when asked for or after a navigation. */
async function observation(note = "", screenshot = false) {
  const o = await session.observe(screenshot);
  return {
    content: [
      ...(o.screenshot ? [{ type: "image" as const, data: o.screenshot.toString("base64"), mimeType: "image/jpeg" }] : []),
      text(`${note}url: ${o.url}\ntitle: ${o.title}\nscroll: ${o.scroll}/${o.height}px\n\n## Repeated groups (DOM)\n${o.lists || "- none"}\n\n## Page JSON XHRs (most recent)\n${o.net || "- none"}${o.overlays ? `\n\n## Interrupts over the page (declare as interrupt views + root INTERRUPT branch)\n${o.overlays}` : ""}\n\n## Accessibility outline\n${o.outline}`),
    ],
  };
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v === null ? undefined : deepMerge(out[k], v);
  return out;
}

function tools(s: McpServer) {
  s.registerTool("browser_navigate", { description: "Navigate the live browser to a URL and return an observation (screenshot + outline + lists + JSON XHR shapes).", inputSchema: { url: z.string() } },
    guard(async ({ url }: { url: string }) => { await session.inScene(`navigate ${url}`, () => session.navigate(url)); return observation("", true); }));
  s.registerTool("browser_observe", { description: "Observe the current page: accessibility outline, repeated DOM groups, recent JSON XHR shapes; set screenshot:true only when the visual layout matters (costly).", inputSchema: { screenshot: z.boolean().default(false) } },
    guard(async ({ screenshot }: { screenshot: boolean }) => observation("", screenshot)));
  s.registerTool("browser_scroll", { description: "Scroll like a person (mouse wheel, human timing) and verify the page moved. Reports steps actually scrolled, and STOPS with the overlay listed if something (a modal) blocks scrolling. Returns a text observation (a screenshot if asked or if blocked).", inputSchema: { times: z.number().int().min(1).max(20).default(1), direction: z.enum(["down", "up"]).default("down"), screenshot: z.boolean().default(false) } },
    guard(async ({ times, direction, screenshot }: { times: number; direction: "down" | "up"; screenshot: boolean }) => {
      const r = await session.inScene("scroll", () => session.scroll(times, direction));
      const note = `scrolled ${r.moved}/${r.requested} steps (${r.from}→${r.to}px of ${r.height}px)${r.blocked ? `; STOPPED — ${r.blocked}. Handle it (interrupt view + dismiss) before designing the manifest.` : ""}\n\n`;
      return observation(note, screenshot || !!r.blocked);
    }));
  s.registerTool("browser_click", { description: "Click a visible element by its text, href fragment, or CSS selector (human-like pointer). Returns an observation (with a screenshot, since the page usually changed).", inputSchema: { text: z.string().optional(), href: z.string().optional(), selector: z.string().optional(), screenshot: z.boolean().default(true) } },
    guard(async (t: { text?: string; href?: string; selector?: string; screenshot: boolean }) => { await session.inScene("click", () => session.click(t)); return observation("", t.screenshot); }));
  s.registerTool("browser_back", { description: "Browser back. Returns a text observation.", inputSchema: { screenshot: z.boolean().default(false) } },
    guard(async ({ screenshot }: { screenshot: boolean }) => { await session.inScene("back", () => session.back()); return observation("", screenshot); }));
  s.registerTool("research_site", { description: "Call FIRST, once. A cheap sub-agent finds open-source scrapers of the site on GitHub, clones and reads the best few and returns a brief: data sources (APIs, embedded JSON), anti-bot/captcha triggers, modals & cookie banners, pacing, pagination, canonical field names, gotchas. Cached per site.", inputSchema: { site: z.string().describe("site URL or domain"), goal: z.string().describe("what dataset you're building"), refresh: z.boolean().default(false) } },
    guard(async ({ site, goal, refresh }: { site: string; goal: string; refresh: boolean }) => {
      session.broadcast({ type: "log", text: `research: ${site} (${goal})` });
      const r = await researchSite(site, goal, { refresh });
      session.broadcast({ type: "research", site, cached: r.cached, ms: r.ms, brief: r.brief });
      return { content: [text(`${r.cached ? "(cached) " : ""}${r.brief}`, 6000)] };
    }));
  s.registerTool("network_samples", { description: "Digest of recent captured JSON responses (page XHRs and inline:<script id> first-load data) whose URL contains `urlContains`: where the record list is, each field's type + example, paging keys, plus one sanitised example record. Enough to write a `net` pointer; use net_preview to test the JSONata.", inputSchema: { urlContains: z.string() } },
    guard(async ({ urlContains }: { urlContains: string }) => {
      const h = session.net.filter((n) => n.url.includes(urlContains)).at(-1);
      if (!h) return ok(`no captured JSON response matching "${urlContains}"; recent: ${[...new Set(session.net.map((n) => n.url.split("?")[0]))].slice(-8).join(", ")}`);
      const count = session.net.filter((n) => n.url.split("?")[0] === h.url.split("?")[0]).length;
      return ok(`${h.method} ${h.status} ${h.url.split("?")[0]} (${count} captured)\n${digestJson(h.body)}\n\nexample record:\n${forModel(firstRecord(h.body), 2500, { maxArray: 3, maxString: 120 })}`);
    }));
  s.registerTool("net_preview", { description: "Evaluate a JSONata `select` (and optional `when`) against the captured responses matching `urlContains` — exactly what a `net` pointer would produce. Returns the count and the first items. With `recordAs: <route>`, the first `max` results are also stored as expected records for parity (instead of typing them out with record_expected).", inputSchema: { urlContains: z.string(), select: z.string(), when: z.string().optional(), recordAs: z.string().optional(), max: z.number().int().min(1).max(20).default(5) } },
    guard(async ({ urlContains, select, when, recordAs, max }: { urlContains: string; select: string; when?: string; recordAs?: string; max: number }) => {
      const { default: jsonata } = await import("jsonata");
      const hits = session.net.filter((n) => n.url.includes(urlContains));
      if (!hits.length) return ok(`no captured response matching "${urlContains}"`);
      const items: unknown[] = [];
      for (const h of hits) {
        if (when && !(await jsonata(when).evaluate(h.body))) continue;
        const v = await jsonata(select).evaluate(h.body);
        if (v != null) items.push(...(Array.isArray(v) ? v : [v]));
      }
      if (recordAs) session.setExpected([...session.expected, ...items.slice(0, max).map((record) => ({ route: recordAs, record: record as Record<string, unknown> }))]);
      return ok(`${items.length} items from ${hits.length} responses${recordAs ? `; recorded ${Math.min(max, items.length)} as expected ${recordAs}` : ""}\n${forModel(items.slice(0, 2), 3000, { maxArray: 5, maxString: 120 })}`);
    }));
  s.registerTool("highlight", { description: "Outline and label elements on the live page (the user sees them). kind: input | output | action | mapping.", inputSchema: {
    items: z.array(z.object({ selector: z.string().optional(), text: z.string().optional(), label: z.string(), kind: z.enum(["input", "output", "action", "mapping"]) })), replace: z.boolean().default(false) } },
    guard(async ({ items, replace }: { items: any[]; replace: boolean }) => ok(await session.highlight(items, replace))));
  s.registerTool("clear_highlights", { description: "Remove all highlights.", inputSchema: {} }, guard(async () => { await session.clearHighlights(); return ok("cleared"); }));
  s.registerTool("propose_schema", { description: "Publish the candidate input kinds and output routes/fields (shown to the user).", inputSchema: {
    inputs: z.array(z.object({ name: z.string(), kind: z.string(), description: z.string(), example: z.any().optional() })),
    outputs: z.record(z.string(), z.object({ description: z.string(), fields: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional() })) })) } },
    guard(async (sch: any) => { session.proposeSchema(sch); return ok("schema published"); }));
  s.registerTool("record_expected", { description: "Record records exactly as a human reads them on screen (parity targets). Appends.", inputSchema: {
    records: z.array(z.object({ route: z.string(), record: z.record(z.string(), z.any()) })) } },
    guard(async ({ records }: { records: any[] }) => { session.setExpected([...session.expected, ...records]); return ok(`${session.expected.length} expected records`); }));
  s.registerTool("finalize_schema", { description: "Lock the schema and move to the design phase (layout changes for the user).", inputSchema: {} },
    guard(async () => { session.setPhase("design"); return ok("phase: design"); }));
  s.registerTool("derive_view", { description: "Derive a stable A2UI view (selectors, model, components, anchors, actions, domhash+AX fingerprint) from 1+ sample URLs of the same page kind. Navigates the browser.", inputSchema: { viewId: z.string(), urls: z.array(z.string()).min(1).max(3) } },
    guard(async ({ viewId, urls }: { viewId: string; urls: string[] }) => {
      const r = await session.deriveView(viewId, urls);
      // the view is stored server-side (write_manifest may reference it verbatim); the model gets its essentials
      const v = r.view;
      return ok({ match: v.match, model: v.model, components: v.components.map((c: any) => `${c.id}:${c.component}${c.text?.path || c.url?.path ? `(${c.text?.path ?? c.url?.path})` : ""}`), actions: Object.keys(v.actions), report: { lists: r.report.lists, kept: r.report.fields.filter((f) => f.kept).map((f) => `${f.name} ← ${f.sel}`) } });
    }));
  s.registerTool("dsl_reference", { description: "The a2flow v0.2 manifest reference + a complete working example (TikTok profiles). Read before writing a manifest.", inputSchema: {} },
    guard(async () => ({ content: [text(dslReference(), 26_000)] })));
  s.registerTool("write_manifest", { description: "Replace the whole manifest (validated against the a2flow schema + A2UI catalog + machine lint). Returns errors to fix.", inputSchema: { manifest: z.record(z.string(), z.any()) } },
    guard(async ({ manifest }: { manifest: any }) => {
      const errs = session.setManifest(manifest as FlowManifest);
      return ok(errs.length ? { valid: false, errors: errs } : { valid: true, views: Object.keys(manifest.views), routes: Object.keys(manifest.routes) });
    }));
  s.registerTool("patch_manifest", { description: "Deep-merge a partial manifest into the current one (null deletes a key; arrays replace). Re-validates.", inputSchema: { patch: z.record(z.string(), z.any()) } },
    guard(async ({ patch }: { patch: any }) => {
      if (!session.manifest) throw new Error("no manifest yet");
      const errs = session.setManifest(deepMerge(structuredClone(session.manifest), patch));
      return ok(errs.length ? { valid: false, errors: errs } : { valid: true });
    }));
  s.registerTool("get_manifest", { description: "The current manifest JSON.", inputSchema: {} }, guard(async () => ok(session.manifest ?? "no manifest yet")));
  s.registerTool("run_manifest", { description: "Run the manifest on the live browser (user sees the A2UI stream). Returns per-route record counts, samples, errors, stats.", inputSchema: { inputs: z.record(z.string(), z.any()), maxSeconds: z.number().int().min(10).max(600).default(120) } },
    guard(async ({ inputs, maxSeconds }: { inputs: any; maxSeconds: number }) => {
      const t0 = Date.now();
      const r = await session.run(inputs, maxSeconds);
      const secs = (Date.now() - t0) / 1000;
      return ok({ seconds: +secs.toFixed(1), error: r.error, counts: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.length])),
        recordsPerSecond: +(Object.values(r.results).reduce((a, v) => a + v.length, 0) / secs).toFixed(2),
        samples: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.slice(0, 2)])), stats: r.stats, faults: r.faults,
        paging: r.paging, // e.g. hasMore:true at the end ⇒ something blocked loading (overlay/throttle); hasMore:false ⇒ source exhausted, fan out
        interrupts: { ...r.interrupts, note: r.interrupts.seenOnPage.length && !r.interrupts.declared.length ? "overlays appeared that the manifest doesn't handle: add interrupt views + a root INTERRUPT branch" : undefined } });
    }));
  s.registerTool("run_at_scale", { description: "After parity ≥ 0.95: the production run (≈100 records). The user sees the state machine + a live record table; at the end they get the manifest as a file, a per-item CPU benchmark and a serverless cost estimate. Pass inputs sized for ~100 records.", inputSchema: { inputs: z.record(z.string(), z.any()), maxSeconds: z.number().int().min(30).max(1200).default(600) } },
    guard(async ({ inputs, maxSeconds }: { inputs: any; maxSeconds: number }) => {
      const r = await session.runAtScale(inputs, maxSeconds);
      return ok(`${r.bench.records} records${r.error ? ` (stopped: ${r.error})` : ""} · manifest saved as ${r.artifact} (shown to the user)\n\n${r.markdown}`);
    }));
  s.registerTool("parity", { description: "Compare the last run's records with your record_expected targets, field by field.", inputSchema: {} },
    guard(async () => {
      const p = session.computeParity();
      // a diagnosis, not a dump: mismatches grouped by field with one example each, missing targets by key
      const byField = new Map<string, { n: number; expected: unknown; got: unknown }>();
      for (const m of p.mismatches) { const k = `${m.route}.${m.field}`; const e = byField.get(k); if (e) e.n++; else byField.set(k, { n: 1, expected: m.expected, got: m.got }); }
      const lines = [...byField].map(([k, e]) => `- ${k}: ${e.n}× e.g. expected ${forModel(e.expected, 80)} got ${forModel(e.got, 80)}`);
      const missing = p.missing.slice(0, 5).map((m) => `- ${m.route} ${forModel(m.record.id ?? m.record.webVideoUrl ?? Object.values(m.record)[0], 60)}`);
      return ok(`parity ${(p.score * 100).toFixed(0)}% · coverage ${p.found}/${p.expected}${p.found < p.expected ? " (missing targets weren't in the run's output — for reshuffling feeds, rerun with more items or re-record targets from the run's own responses)" : ""}\n${lines.join("\n") || "- no field mismatches"}${missing.length ? `\nmissing:\n${missing.join("\n")}` : ""}`);
    }));
}

function dslReference(): string {
  const types = readFileSync(join(here, "../manifest/types.ts"), "utf8");
  let example = "";
  try {
    const m = JSON.parse(readFileSync(join(here, "../../flows/tiktok-profile.a2flow.json"), "utf8"));
    // compact: one page view + one outcome view, abbreviated components/control; the machine and routes in full
    delete m.provenance;
    const keep = ["notFound", "profile"];
    m.views = Object.fromEntries(Object.entries<any>(m.views).filter(([k]) => keep.includes(k)));
    for (const v of Object.values<any>(m.views)) { delete v.fingerprint; if (v.components.length > 6) v.components = [...v.components.slice(0, 6), { "…": `${v.components.length - 6} more` }]; }
    if (m.control?.components?.length > 6) m.control.components = [...m.control.components.slice(0, 6), { "…": `${m.control.components.length - 6} more` }];
    for (const r of Object.values<any>(m.routes)) if (r.schema?.properties) r.schema = { type: "object", properties: Object.fromEntries(Object.keys(r.schema.properties).map((k) => [k, "…"])) };
    example = JSON.stringify(m);
  } catch { /* example optional */ }
  return `# a2flow manifest v0.2 — TypeScript types (authoritative)\n\n\`\`\`ts\n${types}\n\`\`\`\n
## Runtime library
- machine actions: ctx.set {k: expr} · ctx.shift {from,to} · ctx.inc {key} · ctx.stall {count} · route.emit {route} · work.start/complete/fail/skip {type,key,parent?,error?,reason?} · a2ui.write {path,value} · log {text}
- guards: cond {<Cond>} · work.done {type,key}
- invoked actors: browser.navigate {url} · view.await {view | views[], until?, timeoutMs?} → output.view · a2ui.act {on, action?, item?, expect?: view|views[], within?} · a2ui.input {component, value}
- templates: "{{ path | filter }}" over { ...context, context, event, target }; filters: url lower trimAt int json csv len; {"$model": "/ptr"} / {"$count": "/ptr"} read the active surface
- Cond: {gte|lt|eq: [a,b]} {not} {and:[]} {or:[]} {exists:"/ptr"} {stalled:n} {view:id} {empty:"{{ x }}"}; operands: number | "{{ expr }}" | "/ptr" | {count:"/ptr"}
- routes (v0.2): { key, dataset?, from: { view, on: "close"|"item", each?: JSONata }, extract: JSONata ($model, $surfaces.<view>, $surfaces.control.run.<input>, $item, $view), schema }
- the machine's start transition should a2ui.write "/run" with the inputs so routes can read $surfaces.control.run
- net pointers: "/feed": { net: { url: regex, method?, when?: JSONata predicate, select: JSONata, key, mode: "append" } }
- outcome views: { outcome: true, match: { path, text } } declared BEFORE the views they shadow (first match wins)
- extractor get: text | src | bg | html | canvas | location | attr:<n> | prop:<n> | json:<pointer>; as: count | int | float | bool | url | seconds

## Complete working example (TikTok profiles; fast path = network feed, fallback = open videos)
\`\`\`json\n${example}\n\`\`\``;
}

// ---------------- actor (the shipped manifest, run as its own sandboxed job) ----------------

/**
 * Runs a saved manifest artifact with the CLI in a child process: its own headless browser, server-side, so
 * every request to the target goes out from this host (the UI never talks to the site). Lines stream as SSE
 * `actor` events: kind log | item | unit | fault | done | exit.
 */
let actor: ReturnType<typeof spawn> | undefined;
function startActor(name: string | undefined, inputs: Record<string, unknown>) {
  const file = name ? session.artifacts.get(name) : [...session.artifacts.values()].at(-1);
  if (!file) return { error: "no manifest artifact yet (run_at_scale first)" };
  actor?.kill("SIGTERM");
  const out = join(dirname(file), `actor-${Date.now()}`);
  const root = join(here, "../..");
  const child = (actor = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "bin/a2flow.ts"), "run", file, "--input", JSON.stringify(inputs), "--out", out], { cwd: root, stdio: ["ignore", "ignore", "pipe"] }));
  const emit = (kind: string, line: string, extra: Record<string, unknown> = {}) => session.broadcast({ type: "actor", kind, line, at: Date.now(), ...extra });
  emit("start", `▶ ${basename(file)} ${JSON.stringify(inputs)}`, { name: basename(file) });
  let buf = "";
  child.stderr!.on("data", (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trimEnd(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = /^\+ (\S+) (.*)$/.exec(line);
      if (m) { let item: unknown; try { item = JSON.parse(m[2]); } catch { item = m[2]; } emit("item", line, { route: m[1], item }); }
      else emit(line.startsWith("! ") ? "fault" : line.trimStart().startsWith("unit ") ? "unit" : line.startsWith("done ") ? "done" : "log", line);
    }
  });
  child.on("exit", (code) => { emit("exit", `■ exited ${code ?? 0}`, { code }); if (actor === child) actor = undefined; });
  return { ok: true, out };
}

// ---------------- HTTP ----------------

const clients = new Set<ServerResponse>();
session.on("event", (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(line); });

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : undefined;
}
const json = (res: ServerResponse, code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(v)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }); return res.end(); }
    if (url.pathname === "/mcp") {
      const mcp = new McpServer({ name: "a2flow", version: "0.2.0" });
      tools(mcp);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.method === "POST" ? await body(req) : undefined);
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      clients.add(res);
      for (const ev of session.replay()) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      void session.ensure();
      return;
    }
    if (req.method === "POST" && url.pathname === "/export") {
      const { exportSession } = await import("./export.js");
      const dir = join(here, "../../out/studio/exports", new Date().toISOString().replace(/[:.]/g, "-"));
      return json(res, 200, await exportSession(session, dir));
    }
    if (req.method === "POST" && (url.pathname === "/actor/run" || url.pathname === "/actor/stop")) {
      const b = (await body(req)) ?? {};
      if (url.pathname === "/actor/stop") { actor?.kill("SIGTERM"); return json(res, 200, { ok: true }); }
      return json(res, 200, startActor(b.name, b.inputs ?? {}));
    }
    const am = /^\/artifacts\/(.+)$/.exec(url.pathname);
    if (am) {
      const f = session.artifacts.get(decodeURIComponent(am[1]));
      if (!f) return json(res, 404, { error: "no artifact" });
      res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${decodeURIComponent(am[1])}"` });
      return void res.end(readFileSync(f));
    }
    if (url.pathname === "/scenes") return json(res, 200, session.scenes.map((sc) => session.sceneSummary(sc)));
    const sm = /^\/scenes\/([\w-]+)(?:\/frame\/(\d+))?$/.exec(url.pathname);
    if (sm && sm[2] === undefined) { const d = session.sceneData(sm[1]); return d ? json(res, 200, d) : json(res, 404, { error: "no scene" }); }
    if (sm) {
      const buf = session.sceneFrame(sm[1], Number(sm[2]));
      if (!buf) return json(res, 404, { error: "no frame" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" });
      return void res.end(buf);
    }
    if (url.pathname === "/timeline") return json(res, 200, session.timelineData());
    const fm = /^\/timeline\/frame\/(\d+)$/.exec(url.pathname);
    if (fm) {
      const buf = session.frameAt(Number(fm[1]));
      if (!buf) return json(res, 404, { error: "no frame" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" });
      return void res.end(buf);
    }
    if (url.pathname === "/system-prompt") return json(res, 200, { prompt: SYSTEM_PROMPT });
    if (url.pathname === "/state") return json(res, 200, { phase: session.phase, url: session.url, schema: session.schema, manifest: session.manifest, expected: session.expected, parity: session.lastParity });
    if (req.method === "POST") {
      const b = (await body(req)) ?? {};
      await session.ensure();
      if (url.pathname === "/facets") { session.setFacetViews(b.views && typeof b.views === "object" ? b.views : null); return json(res, 200, { ok: true }); }
      if (url.pathname === "/scroll") { await session.inScene("user scroll", () => session.scrollTo(Number(b.ratio))); return json(res, 200, { ok: true }); }
      if (url.pathname === "/click") { await session.inScene("user click", () => session.click({ x: Number(b.x), y: Number(b.y) })); return json(res, 200, { ok: true }); }
      if (url.pathname === "/back") { await session.inScene("user back", () => session.back()); return json(res, 200, { ok: true }); }
      if (url.pathname === "/reload") { await session.inScene("user reload", () => session.navigate(session.url)); return json(res, 200, { ok: true }); }
      if (url.pathname === "/navigate") { await session.inScene(`navigate ${b.url}`, () => session.navigate(String(b.url))); return json(res, 200, { ok: true }); }
      if (url.pathname === "/action") {
        if (!session.runner) return json(res, 409, { error: "no run in progress" });
        await session.runner.handleClientAction(b.action);
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String((e as Error).message ?? e) });
  }
});
attachActorCdpProxy(server, { log: (l) => session.broadcast({ type: "log", text: `actor/cdp: ${l}` }) });
server.listen(PORT, "127.0.0.1", () => console.log(`a2flow studio session server on http://127.0.0.1:${PORT} (MCP at /mcp)`));
