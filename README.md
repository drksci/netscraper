<p align="center"><img src="studio/public/brand/netscraper-mark.svg" width="72" alt="Netscraper"></p>

# Netscraper

**Portable scrapers, shipped as a manifest rather than an image, a package or source code.**

A Netscraper actor is one JSON file: an [XState v5](https://stately.ai/docs/xstate) machine for control flow,
[A2UI v0.9](https://a2ui.org/) surfaces for what the page *is*, and JSONata routes for what comes out. The same file
runs on Playwright, Puppeteer, a raw CDP socket, or compiled to WebAssembly (QuickJS) inside a browser tab. An agent in
the Studio writes it by watching a real browsing session; tests keep it honest; refactoring it takes minutes and
well under a dollar.

Write-up and recorded session replay: **[drksci.com/labs-netscraper](https://drksci.com/labs-netscraper)**

```
manifest.a2flow.json
 ├─ views     page regions → A2UI components bound to a data model (DOM selectors or the page's own XHR/JSON)
 ├─ machine   XState v5 JSON: states, guards, interrupts (login walls, consent modals) with history resume
 ├─ routes    JSONata maps from the A2UI data model → output records (JSON Schema validated)
 └─ policies  pacing, budgets, stop conditions
```

| | |
|---|---|
| **JSON** | XState + A2UI. That's it. Validated by [`schema/a2flow.schema.json`](schema/a2flow.schema.json). |
| **Target** | TypeScript, or WASM: the runtime and a manifest run in QuickJS inside a Worker, talking CDP. |
| **BYOD** | Bring your own driver: `--adapter playwright \| puppeteer \| cdp`, `--endpoint ws://…` for any CDP endpoint. |

Example actors: [`flows/tiktok-explore.a2flow.json`](flows/tiktok-explore.a2flow.json) (the one authored in the
recorded session: reads the Explore feed from the page's own `item_list` XHRs, handles the logged-out login prompt as
an interrupt) and [`flows/tiktok-profile.a2flow.json`](flows/tiktok-profile.a2flow.json) (derived from DOM + vision).

## Quick start

```bash
npm install
```

```bash
npx tsx bin/a2flow.ts run flows/tiktok-explore.a2flow.json --input '{"maxItems":100}'   # live site
```

```bash
npm run mock          # deterministic TikTok look-alike on :4545 (same data-e2e contract as tiktok.com)
```

```bash
npx tsx bin/a2flow.ts run flows/tiktok-profile.a2flow.json --base-url http://127.0.0.1:4545 --input '{"profiles":["chef.nova"],"resultsPerPage":15}' --serve 7778
```

```bash
npx tsx bin/a2flow.ts test flows/tiktok-profile.a2flow.json --base-url http://127.0.0.1:4545 --input '{"profiles":["chef.nova"],"resultsPerPage":14}' --serve 7777
```

```bash
npm test              # unit + 3-adapter e2e (A2FLOW_SKIP_E2E=1 to skip browsers)
```

Against the real site, drop `--base-url` (defaults to `https://www.tiktok.com`) and consider `--headful`
(CloakBrowser's guidance for hard targets is headed + residential proxy + `humanize`, which the manifest enables).

Outputs: `out/run-*/{tiktok.author,tiktok.video}.jsonl`, `a2ui.jsonl` (the full A2UI stream, server and
client messages interleaved), `out/test-*/report.{json,html}`, `events.jsonl`, `steps/NNN-{M.jpg,A.json}`.

## Studio

The Studio is where manifests get written: chat on the left, the manifest streaming in colour-linked to the
regions it reads on the live page, then a parity check, a production run and a WASM run of the result.

```bash
npm run studio:server   # session server on :7801: browser, MCP tools for the agent, scenes, CDP proxy for the WASM actor
npm run build:actor     # bundle the runtime + QuickJS worker into studio/public/actor
npm --prefix studio install && npm run studio:ui   # Next.js UI on :3100
```

The authoring agent is the [Claude Code](https://claude.com/claude-code) CLI (`claude`, or `CLAUDE_BIN`), driven
headless with the session server as its only MCP server. Research (`research_site`) uses `gh search repos` and a
cheaper sub-agent that reads existing open-source scrapers for the target before anything is written.

### Ground rules the agent works under

- Passive capture only: it reads the XHRs the page makes for itself; it never replays or forges requests.
- It never logs in, accepts terms, solves captchas or submits personal data. Blockers become interrupt views.
- Before authoring it must scroll far enough to prove what blocks a visitor (verified scroll: moved / blocked).

## Deriving a view (and the inference cache)

```bash
npx tsx bin/a2flow.ts derive --view profile --url http://127.0.0.1:4545/@chef.nova --url http://127.0.0.1:4545/@dance.mike --manifest out/derived.a2flow.json
```

1. **DOM pass**: repeated sibling groups become templated `List`s, and salient singletons become `Text`/`Image`. Selectors
   prefer `data-e2e`/`data-testid`/aria, then semantic emotion-class suffixes (`[class*="-ImgAvatar"]`;
   tiktok.com's per-deploy hash segment is stripped), then short structural paths.
2. **Stability**: with ≥2 sample URLs, only selectors present in *every* sample survive, and only values
   that *vary* become data (constant texts like "Followers" become literal labels).
3. **Pixels**: sample screenshots, an annotated screenshot (each anchored component boxed and labelled), and
   `<canvas>`/`<video>` frames are written to `out/derive/`.
4. **Vision patch**: something looks at those images and returns a `RefinePatch`: semantic renames,
   variants, drops, labels, intents. It never contains selectors. Three sources: `--patch file.json`
   (an agent/human interpreted the images; how the TikTok patches in `flows/tiktok-profile/*.patch.json`
   were made), `--refine sdk` (Claude Opus 5.5 vision via `@anthropic-ai/sdk`), `--refine cli` (`claude -p`).
   If nothing is supplied and the cache misses, `<view>.inference-request.json` is left for whoever interprets it.
5. **Cache** (`.a2flow-cache/inference/<key>.json`): key = sha256 of the derived view's *structure*
   (no sample values), plus 64-bit dHash fingerprints of the annotated screenshot and canvas frames. The same
   structure re-derived is a `hit` (no re-inference). The same structure with a big pixel drift is `visual-drift`
   (patch reused, drift reported). `flows/tiktok-profile/build.ts --use-cache` rebuilds the shipped manifest
   byte-identically from the cache alone.

What the vision pass contributed for TikTok (see the `notes` in the patches):
- `undefined-count` is **collect/bookmark**: TikTok really does name it that, and only the icon gives it away.
- The `DivNumber` group duplicates the stat counters, so it was dropped.
- The clip duration is only rendered into the `<canvas>`, so it's sourced from the SSR payload instead.
- The animating canvas is excluded from the live surface, because streaming it would never settle.

## Side-by-side test semantics

Lane A finishes a step, then the barrier runs: lane M performs the *same intent* from perception (e.g. find the
visible link carrying `context.id`, wheel it into view, click its centre; for `loadMore`, wheel one viewport),
both settle, then:

- **url-sync** (at `navigate`/`await`): both lanes are on the same path.
- **render-equivalence** (A→M): every data-bound `Text`/`Image` value in the A2UI surface is visible to lane M
  (text corpus, abbreviated counts parsed to numbers, image/href paths). Threshold `--min-coverage` (0.9).
- **list-parity** (M→A): item links lane M sees vs the surface's list, in DOM order. The shorter must be an exact
  prefix of the longer, because lanes may load different amounts while scrolling.
- **emit-grounding**: fields an emitted record reads from the current view are visible to lane M.
- **a2ui-schema**: every streamed server and client message validates against the official v0.9 JSON Schemas.

## Layout

```
src/a2ui/        v0.9 types, JSON pointer + diff, SurfaceStore, template expansion, action building
src/inpage/      runtime.js — extractor, view matcher, anchor locator, observer, visual snapshot, repeat/singleton detection
src/adapters/    playwright.ts, puppeteer.ts, cdp.ts (+ screencast) — all launch CloakBrowser
src/manifest/    types, loader, validation (a2flow schema + vendored A2UI v0.9 schemas/catalog)
src/render/      projector.ts — the streaming renderer
src/runtime/     driver (A2UI-only), bridge (A2UI → browser), runner (flow + routes), expr
src/derive/      capture, heuristic, refine (vision patch), cache (inference cache), derive (+ manifest scaffold)
src/harness/     perceive (lane M), sidebyside (lockstep + checks + report), server (live viewer)
viewer/          index.html + a2ui-renderer.js (dependency-free A2UI web renderer, clickable → actions)
src/machine/      XState runner, interrupts, policy, ledger, diagnose
src/actor/        QuickJS-wasm host + Worker entry (the in-browser actor) and Node shims
src/studio/       Studio session server: MCP tools, scenes, research, pricing, export
studio/           Next.js Studio UI
fixtures/        tiktok-mock — deterministic look-alike for CI
flows/           tiktok-profile.a2flow.json (+ build.ts, vision patches)
```

## Status

A prototype from [d/rksci labs](https://drksci.com). Tested on one site, logged out, from one network. Expect sharp
edges: the WASM host works but is slower than Node and untuned, and the Studio loses an in-flight agent run on hot
reload.

## Licence

MIT © 2026 Blake Carter, d/rksci. See [LICENSE](LICENSE). The vendored A2UI v0.9 schemas in `vendor/a2ui/` are Google's, under Apache 2.0.
