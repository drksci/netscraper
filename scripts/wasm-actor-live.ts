/**
 * One in-browser actor run, the way the Studio does it: a headless "user tab" loads studio/src/lib/wasm-actor.ts,
 * which starts the module Worker → QuickJS-wasm runtime; page control goes through the /session/actor/cdp proxy
 * (mounted here on its own port) to a dedicated headless CloakBrowser that does all target-site traffic.
 *
 *   npx tsx scripts/wasm-actor-live.ts <manifest.a2flow.json> '<inputs json>' [--engine auto|quickjs-wasm|worker-js] [--attempts 1]
 *
 * For live sites: one run, retries forced to --attempts (default 1); a block/captcha fails the run, nothing is evaded.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { attachActorCdpProxy } from "../src/studio/actor-cdp.ts";
import { launchAdapter } from "../src/adapters/index.ts";

const root = join(fileURLToPath(import.meta.url), "../..");
const assets = join(root, "studio/public/actor");
const [file, inputsJson] = process.argv.slice(2);
const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const manifest = JSON.parse(readFileSync(file, "utf8"));
manifest.policies = { ...manifest.policies, retry: { ...manifest.policies?.retry, attempts: Number(arg("--attempts", "1")) } };
const inputs = JSON.parse(inputsJson);

const harness = await build({
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  stdin: { contents: `import { startWasmActor } from "./studio/src/lib/wasm-actor.ts";
    window.__events = [];
    window.__run = (manifest, inputs, engine) => new Promise((resolve) => {
      const t0 = Date.now();
      const h = startWasmActor({ manifest, inputs, engine, onEvent: (e) => window.__events.push(e) });
      h.done.then((r) => resolve({ r, mode: h.mode, wall: Date.now() - t0 }));
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
const proxy = attachActorCdpProxy(http, { path: "/session/actor/cdp", log: (l) => console.error(`  [proxy] ${l}`) });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
const port = (http.address() as { port: number }).port;
const tab = await launchAdapter({ adapter: "cdp", headless: true });
let seen = 0;
const tail = setInterval(async () => {
  const ev = await tab.evaluate<any[]>(`window.__events ? window.__events.slice(${seen}) : []`).catch(() => []);
  seen += ev.length;
  for (const e of ev) console.error(`${new Date(e.at).toISOString().slice(11, 23)} ${e.kind.padEnd(5)} ${e.line}`);
}, 500);
try {
  await tab.goto(`http://127.0.0.1:${port}/`);
  const out = await tab.evaluate<any>(`(async () => { while (!window.__run) await new Promise((r) => setTimeout(r, 50));
    return window.__run(${JSON.stringify(manifest)}, ${JSON.stringify(inputs)}, ${JSON.stringify(arg("--engine", "auto"))}); })()`);
  await new Promise((r) => setTimeout(r, 700));
  console.log(JSON.stringify({ mode: out.mode, ok: out.r.ok, error: out.r.error, counts: out.r.counts, runMs: out.r.ms, wallMs: out.wall }));
} finally {
  clearInterval(tail);
  await tab.close();
  await proxy.closeAll();
  http.close();
}
