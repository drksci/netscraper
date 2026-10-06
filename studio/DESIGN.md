# a2flow Studio: design note

One idea: **the page, the code and the components are the same thing seen three ways.** Facet colour is
the thread between them; everything else stays neutral and quiet so that thread is what the eye follows.

## Layout

```
 chat                       author / run
┌──────────────────────┐   ┌───────┬───────────────────────────────┐
│                      │   │ chat  │ ▢ Browser·Code·Both  Schema … │  ← one slim header per container
│   messages           │   │ 1/4   │ code (11px mono)              │
│   ┌ web preview ┐    │   │       ├───────────────────────────────┤
│   └ ≤80% w / h  ┘    │   │       │ ‹ › ⟳ url                ●●●  │
│                      │   │       │ browser canvas (+ Dock)       │
│ [ composer        ]  │   │ [   ] │ ▸ ‖ ◂ 1× ━━━━━━━━━━━━  Live   │  ← scene strip
└──────────────────────┘   └───────┴───────────────────────────────┘
```

- **Three stage modes**, chosen automatically (overridable from the composer):
  - `chat`: chat only, full width. Browser tool calls embed a Web Preview in the conversation.
  - `author`: chat at 1/4, stage at 3/4. Stage defaults to **Both** (code on top, browser below, 50/50).
  - `run`: same split, but the stage switches to the full **Browser** view with the **Dock** overlay.
- Panes are absolutely positioned; `left`/`width` animate (500ms, ease-out-quint). The code/browser split is a
  CSS grid whose `grid-template-rows` animates, so Browser · Code · Both slide rather than jump.
- No app header. The stage is one rounded, hairline-bordered surface; its top row carries the view switch.
  In Both, the browser half keeps its own Web Preview nav row (that is the browser's header, not a menu).

## Components (src/components/studio)

- `studio.tsx`: mode logic, pane positioning, draft-facet POSTs while the manifest streams.
- `chat.tsx` + `prose.tsx`: conversation (MessageScroller/Message/Bubble), live-tail reasoning, single-line tool rows
  (the research_site row expands to the research brief), browser embed, starters, composer (system prompt sheet +
  chat-only/split toggle).
- `stage.tsx`: the right-hand surface (view switch, animated grid split, overlay modes).
- `code-pane.tsx` + `facet-json.tsx`: doc tabs (Schema · Expected · Manifest · Machine), Linked/All focus,
  facet-coloured blocks, paced reveal, spotlight.
- `machine-view.tsx`: React Flow + dagre. Edges are drawn on dagre's own routed points and labels are laid out by
  dagre as real boxes, so nothing overlaps; both directions are laid out and the one that fits the pane best wins.
  Distinct initial / state / invoke / final / failure / unresolved-target ("ghost") nodes.
- `browser.tsx`: nav row, frame canvas, facet outlines + spotlight mask, status bar, chat embed.
- `dock.tsx`: A2UI overlay. Default **Lo-fi**: each matched item/field is covered at exactly its rect by an opaque
  lo-fi rendering of its component (image glyph on a muted plate, truncated caption, icon + compact count, @handle);
  the page shows around them. Stream / Off are secondary.
- `retro.tsx`: Win95/98 accent icons (@react95/icons) plus hand-drawn animated pixel SVGs (spinning globe,
  hourglass), always 16/32px with crispEdges. Used for tool rows, waiting states, empty states and the view switch.
- `action-hud.tsx`, `scene-strip.tsx`, `segmented.tsx`, `a2ui-stream.tsx`.

## Typography

- Geist Sans for UI at 13px (chat 14px), Geist Mono 11px for code, 10px for status/meta, 9px inside Dock mockups.
- Weight carries hierarchy (400/500), never size jumps. Muted foreground for everything secondary.

## Colour

- Neutral shadcn tokens everywhere. Facet colours (`lib/facets.ts`) are the only raw colours and appear only
  where something is linked to the page: block borders + keys in code, hairline outlines on the canvas, card
  borders in the Dock, net dots in the status bar.
- Destructive is reserved for failures (error edges, failed states, faults on the scene strip).

## Spotlight

- Not a dark mask: everything unlit gets a pale wash of the background colour (~62%), like a faded print, on the
  canvas (SVG mask with cut-outs) and in the code (lines at 38% opacity over the background).

## Playback

- Strictly scene-based: only closed scenes play, each fully fetched and decoded first; while one records the last
  frame holds and the status bar shows an hourglass. Live SSE facets/acts/frames/machine apply only when idle and
  caught up. Frames crossfade (140ms) to smooth the ~8fps capture; backlog catch-up tops out at 2×.

## Motion

- Layout: 500ms `cubic-bezier(0.22,1,0.36,1)` for panes; 300ms for the split.
- Paced reveal: one facet block every 850ms, active block tinted + 2px border; the page element is tinted at the
  same moment and the rest of both sides dims (code to 40%, canvas under a 50% mask with cut-outs).
- HUD: 150ms fade/zoom in, ~900ms on screen; clicks ripple at the point.
- Machine: the edge just taken animates its dash for 1.2s; active node fades in its fill.
- Nothing bounces, glows or uses gradients; shadows are absent except a hairline ring on floating cards.

## Performance

- Every derived structure is memoised on content (JSON signature) rather than object identity where the parent
  rebuilds objects per render (machine graph, draft views).
- Frame swaps go through the canvas (`useBrowserImage`), never through React state of the overlay tree.
- The playhead is a separate store, read only by the strip's fill.

## Production (after parity)

- `phase: "production"` (run_at_scale): the stage becomes `production.tsx`: the live machine (follows the SSE
  machine state, zoomed to the active state) over a live records table (newest first, animated in, compacted cells,
  virtualised above 200 rows), with a footer breadcrumb `Open › Explore › More (7)`, record count and elapsed time.
- `artifact` arrives: chat | stage animate to 50/50; after the run_at_scale row the chat shows the manifest as a
  file card (download, JSON preview, Run as actor), the per-item benchmark and the cost table (platforms × 1/1k/100k/1M,
  extract-only marked, Apify actors priced per result + start fee per 1k-item run, list-price caveat + sources).
- Actor: `actor-terminal.tsx`, a Win95 program window around a flat dark console (log lines by kind, a "data out"
  pane, status line with items / rate / elapsed, Run / Run again / Stop, editable inputs defaulting to the scale run's).
  It runs through `lib/actor-source.ts`: the in-browser runtime (`lib/wasm-actor.ts`, optional, loaded on demand) or
  the server runner (POST /session/actor/run + SSE); both feed one reducer, and the title bar states the actual mode.

## Later additions

- **Interrupts** (`lib/interrupts.ts`, `interrupt-layer.tsx`): `…interrupt:<view>` A2UI surfaces render as a lo-fi
  modal card centred over the page (title + its button); a click/key act while one is up flashes the button and the
  HUD reads "Dismiss"; deleteSurface fades the card out. Sourced from scene a2ui during playback, live when caught up.
- **A2UI tab** (`a2ui-log.tsx`): the message stream as compact lines (type badge · surface · path · preview), filters
  by surface group and type, Pretty/JSONL, copy / download .jsonl; a line expands to FacetJson with facet colours on
  data-model paths (`/videos/3/playCount` → `/videos/*/playCount`). Client actions join the stream as `clientAction`.
- **Chat density**: consecutive tool calls are one wrapped cluster of 20px chips (repeats ×N, click for detail);
  13px prose with snug leading; 2-line thinking tail; 8px between messages; one-row file and benchmark cards.
- **Actor TUI** (`actor-terminal.tsx`, `lib/actor-log.ts`): one black monospace pane for ~50 columns: header line
  (WASM ◆ engine · manifest · inputs · ▶ run), machine strip (states chain, active inverted in brand yellow, ×N loops,
  fault/interrupt flashes), records table (id · ♥ · ▶ · @author caption, newest first, click to expand), block
  progress bar toward maxItems, and a pinned 5-line log through the terse formatter (glyph gutter, ×N folding).
