/**
 * In-browser ("WASM") actor smoke test against the deterministic TikTok mock.
 *
 *  1. Node host: load studio/public/actor/a2flow-actor.js into QuickJS-wasm (quickjs-emscripten release-asyncify,
 *     the same src/actor/quickjs-host.ts the Worker uses), connect through the /actor/cdp proxy (dedicated
 *     headless browser), check the records — and that they equal the Node runtime's records on the same input.
 *  2. Real browser: a headless page loads studio/src/lib/wasm-actor.ts → module Worker → QuickJS-wasm, through the
 *     proxy mounted at /session/actor/cdp (the path the Studio uses), and must report mode "quickjs-wasm".
 *
 * Builds the bundle first (scripts/build-actor.mjs). Set A2FLOW_SKIP_E2E=1 to skip (launches CloakBrowser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten";
import RELEASE_ASYNC from "@jitl/quickjs-wasmfile-release-asyncify";
import { startMock } from "../fixtures/tiktok-mock/server.ts";
import { attachActorCdpProxy } from "../src/studio/actor-cdp.ts";
import { runActorInQuickJS, type HostSocket } from "../src/actor/quickjs-host.ts";
import { launchAdapter } from "../src/adapters/index.ts";
import { loadManifest } from "../src/manifest/load.ts";
import { MachineRunner } from "../src/machine/runner.ts";

const skip = !!process.env.A2FLOW_SKIP_E2E;
const root = join(fileURLToPath(import.meta.url), "../..");
const assets = join(root, "studio/public/actor");
const INPUTS = { profiles: ["chef.nova"], resultsPerPage: 5 };

function listen(s: Server): Promise<number> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
}

test("wasm actor: QuickJS-wasm runtime via the CDP proxy yields the Node runtime's records", { skip, timeout: 300_000 }, async () => {
  execFileSync(process.execPath, [join(root, "scripts/build-actor.mjs")], { stdio: "inherit" });
  const { server: mock, url } = await startMock();
  const http = createServer((_q, r) => { r.writeHead(404); r.end(); });
  const proxy = attachActorCdpProxy(http, { log: () => {} });
  const port = await listen(http);
  try {
    const manifest = loadManifest(join(root, "flows/tiktok-profile.a2flow.json"));
    manifest.target.baseUrl = url;

    // --- QuickJS-wasm (what the Studio Worker runs) ---
    const module = await newQuickJSAsyncWASMModuleFromVariant(RELEASE_ASYNC as any);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/actor/cdp`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const socket: HostSocket = { send: (d) => ws.send(d), close: () => ws.close() };
    ws.onmessage = (e) => socket.onmessage?.(String(e.data));
    ws.onclose = (e) => socket.onclose?.(`${e.code} ${e.reason}`);
    const events: any[] = [];
    const t0 = Date.now();
    const h = await runActorInQuickJS({ module, bundleSource: readFileSync(join(assets, "a2flow-actor.js"), "utf8"), manifest, inputs: INPUTS, socket, onEvent: (e) => events.push(e) });
    const r = await h.done;
    const ms = Date.now() - t0;
    const items = events.filter((e) => e.kind === "item");
    console.log(`[quickjs-wasm] ok=${r.ok} counts=${JSON.stringify(r.counts)} run=${r.ms}ms wall=${ms}ms`);
    assert.ok(r.ok, r.error ?? "");
    assert.deepEqual(r.counts, { "tiktok.author": 1, "tiktok.video": 5 });
    assert.deepEqual(events.map((e) => e.kind).filter((k, i, a) => a.indexOf(k) === i).sort(), ["done", "exit", "item", "log", "start", "unit"]);
    for (const e of events) assert.equal(typeof e.at, "number");
    while (proxy.busy) await new Promise((res) => setTimeout(res, 100)); // proxy browser torn down

    // --- parity: the Node runtime on the same manifest/input ---
    const a = await launchAdapter({ adapter: "cdp", headless: true, viewport: manifest.target.viewport });
    let nodeRes: Record<string, unknown[]>;
    try { nodeRes = await new MachineRunner(structuredClone(manifest), a, INPUTS).run(); } finally { await a.close(); }
    const byRoute = (route: string) => items.filter((e) => e.route === route).map((e) => e.item);
    assert.deepEqual(byRoute("tiktok.author"), nodeRes["tiktok.author"]);
    assert.deepEqual(byRoute("tiktok.video"), nodeRes["tiktok.video"]);
  } finally {
    await proxy.closeAll();
    http.close();
    mock.close();
  }
});

test("wasm actor: real browser tab → module Worker → QuickJS-wasm (startWasmActor)", { skip, timeout: 300_000 }, async () => {
  const { server: mock, url } = await startMock();
  const harness = await build({
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    stdin: { contents: `import { startWasmActor } from "./studio/src/lib/wasm-actor.ts";
      window.__run = (manifest, inputs, baseUrl) => new Promise((resolve) => {
        const events = []; const t0 = Date.now();
        const h = startWasmActor({ manifest, inputs, baseUrl, onEvent: (e) => events.push(e) });
        h.done.then((r) => resolve({ r, mode: h.mode, wall: Date.now() - t0, events }));
      });`, resolveDir: root, loader: "ts" },
  });
  const types: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" };
  const http = createServer((q, r) => {
    const p = new URL(q.url ?? "/", "http://x").pathname;
    if (p === "/") { r.writeHead(200, { "content-type": "text/html" }); return r.end(`<!doctype html><script type="module" src="/harness.js"></script>`); }
    if (p === "/harness.js") { r.writeHead(200, { "content-type": "text/javascript" }); return r.end(harness.outputFiles[0].text); }
    const m = /^\/actor\/([\w.-]+)$/.exec(p);
    if (m) { try { const b = readFileSync(join(assets, m[1])); r.writeHead(200, { "content-type": types[extname(m[1])] ?? "application/octet-stream" }); return r.end(b); } catch { /* 404 */ } }
    r.writeHead(404); r.end();
  });
  const proxy = attachActorCdpProxy(http, { path: "/session/actor/cdp", log: () => {} });
  const port = await listen(http);
  const tab = await launchAdapter({ adapter: "cdp", headless: true });
  try {
    await tab.goto(`http://127.0.0.1:${port}/`);
    const manifest = JSON.parse(readFileSync(join(root, "flows/tiktok-profile.a2flow.json"), "utf8"));
    const out = await tab.evaluate<any>(`(async () => { while (!window.__run) await new Promise((r) => setTimeout(r, 50));
      return window.__run(${JSON.stringify(manifest)}, ${JSON.stringify(INPUTS)}, ${JSON.stringify(url)}); })()`);
    console.log(`[browser worker] mode=${out.mode} ok=${out.r.ok} counts=${JSON.stringify(out.r.counts)} run=${out.r.ms}ms wall=${out.wall}ms`);
    console.log(out.events.filter((e: any) => /engine:/.test(e.line)).map((e: any) => e.line).join("\n"));
    assert.equal(out.mode, "quickjs-wasm", out.events.map((e: any) => e.line).join("\n"));
    assert.ok(out.r.ok, out.r.error);
    assert.deepEqual(out.r.counts, { "tiktok.author": 1, "tiktok.video": 5 });
  } finally {
    await tab.close();
    await proxy.closeAll();
    http.close();
    mock.close();
  }
});
