#!/usr/bin/env node
/**
 * Build the in-browser actor: the a2flow v0.2 runtime as one IIFE (sets globalThis.runActor) for QuickJS-wasm
 * or a plain Worker, plus the Worker host and the QuickJS wasm file.
 *
 *   node scripts/build-actor.mjs   →  studio/public/actor/{a2flow-actor.js, actor-worker.js, quickjs.wasm}
 *
 * Node-only modules are replaced at build time (alias layer, the runtime itself is not forked):
 *   node:events            → src/actor/shims/events.ts (tiny EventEmitter)
 *   node:fs|path|url|os|child_process|module, ws, cloakbrowser, @opentelemetry/*
 *                          → src/actor/shims/node-unavailable.ts (throws if ever called; no outDir → never called)
 *   src/machine/recorder.ts    → shim (no flight recorder / fault bundles)
 *   src/machine/fingerprint.ts → shim (no domhash drift checks)
 *   src/inpage/source.ts       → the in-page runtime (src/inpage/runtime.js) inlined as a string
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "studio/public/actor");
mkdirSync(out, { recursive: true });
const shim = (f) => join(root, "src/actor/shims", f);

const NODE_ONLY = /^(node:)?(fs|fs\/promises|path|url|os|child_process|module|crypto)$|^(ws|cloakbrowser|@opentelemetry\/.*|@iocium\/domhash)$/;
const replaceFile = {
  [join(root, "src/machine/recorder.ts")]: shim("recorder.ts"),
  [join(root, "src/machine/fingerprint.ts")]: shim("fingerprint.ts"),
};

const aliases = {
  name: "a2flow-browser-aliases",
  setup(b) {
    b.onResolve({ filter: /^(node:)?events$/ }, () => ({ path: shim("events.ts") }));
    b.onResolve({ filter: NODE_ONLY }, () => ({ path: shim("node-unavailable.ts") }));
    // relative imports of runtime modules that have browser replacements (".js" specifiers → ".ts" sources)
    b.onResolve({ filter: /\/(recorder|fingerprint|source)\.js$/ }, (a) => {
      const abs = resolve(a.resolveDir, a.path).replace(/\.js$/, ".ts");
      if (replaceFile[abs]) return { path: replaceFile[abs] };
      if (abs === join(root, "src/inpage/source.ts")) return { path: abs, namespace: "inpage-inline" };
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "inpage-inline" }, () => ({
      contents: `export const INPAGE_RUNTIME = ${JSON.stringify(readFileSync(join(root, "src/inpage/runtime.js"), "utf8"))};`,
      loader: "js",
    }));
  },
};

const common = { bundle: true, platform: "browser", target: "es2022", legalComments: "none", logLevel: "warning", minify: process.argv.includes("--minify") };

const r = await build({
  ...common,
  entryPoints: [join(root, "src/actor/entry.ts")],
  outfile: join(out, "a2flow-actor.js"),
  format: "iife",
  plugins: [aliases],
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
// guard: nothing Node-only may leak into the bundle
const leaked = Object.keys(r.metafile.inputs).filter((p) => /recorder\.ts$|fingerprint\.ts$|opentelemetry|domhash|cloakbrowser|node_modules\/ws\//.test(p) && !p.includes("src/actor/shims"));
if (leaked.length) { console.error("node-only inputs leaked into the actor bundle:", leaked); process.exit(1); }

// Worker host (QuickJS-wasm with a worker-js fallback); quickjs-emscripten bundled in, wasm served beside it
const workerSrc = join(root, "src/actor/worker.ts");
if (existsSync(workerSrc)) await build({
  ...common,
  entryPoints: [workerSrc],
  outfile: join(out, "actor-worker.js"),
  format: "esm",
});
const require = createRequire(import.meta.url);
const wasm = join(dirname(require.resolve("@jitl/quickjs-wasmfile-release-asyncify")), "emscripten-module.wasm");
copyFileSync(wasm, join(out, "quickjs-asyncify.wasm"));

const kb = (f) => `${(statSync(join(out, f)).size / 1024).toFixed(0)} KiB`;
console.log(`actor bundle  ${kb("a2flow-actor.js")}  (inputs: ${Object.keys(r.metafile.inputs).length})`);
if (existsSync(join(out, "actor-worker.js"))) console.log(`worker host   ${kb("actor-worker.js")}`);
console.log(`quickjs wasm  ${kb("quickjs-asyncify.wasm")}  (release-asyncify)`);
