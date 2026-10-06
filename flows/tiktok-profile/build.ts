/**
 * Reproducible build of flows/tiktok-profile.a2flow.json — the prototype of the Apify
 * clockworks/tiktok-scraper "profiles" flow.
 *
 *   1. derive    two profile pages + two video pages (DOM + screenshot + canvas capture)
 *   2. refine    apply the vision-review patches in this folder (authored by looking at the
 *                saved annotated captures; see *.patch.json "notes")
 *   3. curate    the few edits a human makes that neither pass can (marked CURATE below)
 *   4. compose   Apify-shaped routes + an A2UI-action-only flow, validate, write one file
 *
 *   tsx flows/tiktok-profile/build.ts [--base-url https://www.tiktok.com]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, mockUser } from "../../fixtures/tiktok-mock/server.js";
import { launchAdapter } from "../../src/adapters/index.js";
import { derive } from "../../src/derive/derive.js";
import { checkManifest } from "../../src/manifest/load.js";
import { BASIC_CATALOG_ID } from "../../src/a2ui/types.js";
import type { FlowManifest, ViewSpec } from "../../src/manifest/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.argv.includes("--base-url") ? process.argv[process.argv.indexOf("--base-url") + 1] : "https://www.tiktok.com";
// Vision-review patches are the committed source of truth; --use-cache skips them to prove the
// cached inference reproduces the same result without re-interpreting any images.
const useCache = process.argv.includes("--use-cache");
const patch = (n: string) => (useCache ? undefined : JSON.parse(readFileSync(join(here, `${n}.patch.json`), "utf8")));

const { server, url } = await startMock();
const a = await launchAdapter({ adapter: "playwright", headless: true });
const outDir = join(here, "../../out/derive");
let profile: ViewSpec, video: ViewSpec, reports: unknown[];
try {
  const p = await derive(a, { viewId: "profile", urls: [`${url}/@chef.nova`, `${url}/@dance.mike`], outDir, patch: patch("profile") });
  const vids = [mockUser("chef.nova").videos[3].id, mockUser("dance.mike").videos[7].id];
  const v = await derive(a, { viewId: "video", urls: [`${url}/@chef.nova/video/${vids[0]}`, `${url}/@dance.mike/video/${vids[1]}`], outDir, patch: patch("video") });
  for (const r of [p, v]) console.log(`${r.report.view}: inference ${JSON.stringify((r.report.refine as any)?.inference)}`);
  for (const r of [p, v]) if (!(r.report.refine as any)?.applied) throw new Error(`patch not applied: ${JSON.stringify(r.report.refine)}`);
  profile = p.view; video = v.view; reports = [p.report, v.report];
} finally {
  await a.close();
  server.close();
}

// ---- CURATE ---------------------------------------------------------------------------------
const pv = (profile.model["/videos"] as any).fields;
// tile links: href shape is a stronger contract than the emotion class the DOM pass preferred
pv.id.sel = pv.url.sel = 'a[href*="/video/"]';
// live tiles render the poster as a bare <picture><img> (no ImgPoster class) — verified on tiktok.com
pv.cover.sel = "picture img";
const vm = (video.model["/video"] as any).fields;
// byline is "Nickname · 2024-12-17": split it (the vision pass flagged it; extractors are ours to edit)
vm.nickname = { sel: 'span[data-e2e="browser-nickname"] > span:first-child', get: "text" };
vm.createTimeText = { sel: 'span[data-e2e="browser-nickname"] > span:last-child', get: "text" };
// hashtags as Apify-style [{name}] instead of ["#tag"]
vm.hashtags = { each: 'a[data-e2e="search-common-link"]', fields: { name: { get: "text", re: "^#?(.+)$" } } };
for (const c of video.components) if (c.id === "hashtag") c.text = { path: "name" };
// duration is only *rendered* into the canvas (vision note) — read it from the SSR payload.
// On tiktok.com SPA navigation this payload can be stale, so it is best-effort (null-able).
vm.duration = { sel: "script#__UNIVERSAL_DATA_FOR_REHYDRATION__", get: "json:/__DEFAULT_SCOPE__/webapp.video-detail/itemInfo/itemStruct/video/duration", as: "int" };
// Live contract (tiktok.com "cinema" video view, verified 2026-10-06): selector lists cover both the
// classic browse layout (mock) and the current one. querySelector returns the first match in DOM order.
const either = (...sels: string[]) => sels.join(", ");
vm.desc.sel = either('div[data-e2e="video-desc"]', vm.desc.sel);
vm.collectCount.sel = either('strong[data-e2e="favorite-count"]', vm.collectCount.sel);
vm.hashtags = { each: 'a[data-e2e="search-common-link"]', key: "name", fields: { name: { get: "text", re: "^#(.+)$" } } }; // @mentions → no key → skipped
vm.durationText = { sel: 'span[data-e2e="cinema-playback-time"]', get: "text", re: "/\\s*([\\d:]+)", as: "seconds" };
video.match.selector = 'strong[data-e2e="like-count"]';
// identity from the address bar (works for SPA navigation, where SSR payloads go stale)
vm.id = { get: "location", re: "/video/(\\d+)" };
vm.url = { get: "location" };
profile.model["/page"] = { fields: { url: { get: "location" } } };
// FAST PATH: the grid is fed by the page's own item_list XHR, which carries every field the detail page shows.
// Observed passively (CDP), transformed with JSONata into the A2UI data model — no per-video navigation.
profile.model["/feed"] = { net: {
  url: "/api/post/item_list", method: "GET", when: "$exists(itemList)", key: "id", mode: "append",
  select: `itemList.{ "id": id, "desc": desc, "createTime": createTime, "stats": stats, "music": music.title,
    "duration": video.duration, "cover": video.cover, "hashtags": [textExtra.hashtagName], "author": author.uniqueId }`,
} };
// end of grid: an explicit end marker where the site has one (mock: emptied #loader); otherwise stall detection
profile.model["/grid"] = { fields: { hasLoader: { sel: "#loader", get: "attr:id" }, loaderText: { sel: "#loader", get: "text" } } };

/** Outcome states: terminal for a unit, recognised by path + page text, declared before the views they shadow. */
const outcome = (title: string, path: string, text: string): ViewSpec => ({
  title, outcome: true, match: { path, text },
  components: [
    { id: "root", component: "Column", children: ["outcome_message", "back"] },
    { id: "outcome_message", component: "Text", text: { path: "/outcome/message" }, variant: "h4" },
    { id: "back", component: "Button", child: "back_label", action: { event: { name: "back" } } },
    { id: "back_label", component: "Text", text: "Back" },
  ],
  model: { "/outcome": { fields: { message: { sel: "main", get: "text" } } } },
  anchors: { outcome_message: { model: "/outcome/message" } },
  actions: { back: { op: "back", intent: "Go back to the previous page" } },
  settle: { quietMs: 250, timeoutMs: 20000 },
});
const notFound = outcome("Account not found", "^/@[^/]+/?$", "couldn.?t find this account");
const privateAccount = outcome("Private account", "^/@[^/]+/?$", "this account is private");
const videoUnavailable = outcome("Video unavailable", "^/@[^/]+/video/\\d+/?$", "video (is )?(currently )?unavailable");
/** Interrupt: TikTok's login prompt. Its own A2UI surface over the page; the machine's INTERRUPT branch dismisses it. */
const loginModal: ViewSpec = {
  title: "Login prompt", interrupt: true,
  match: { selector: '[data-e2e="modal-mask"][style*="flex"]' },
  components: [
    { id: "root", component: "Card", child: "modal_col" },
    { id: "modal_col", component: "Column", children: ["modal_title", "dismiss"] },
    { id: "modal_title", component: "Text", text: { path: "/modal/title" }, variant: "h4" },
    { id: "dismiss", component: "Button", child: "dismiss_label", action: { event: { name: "dismiss" } } },
    { id: "dismiss_label", component: "Text", text: "Close" },
  ],
  model: { "/modal": { fields: { title: { sel: '[data-e2e="modal-mask"] p, [role="dialog"] h2', get: "text", default: "Log in" } } } },
  anchors: { modal_title: { model: "/modal/title" }, dismiss: { sel: '[data-e2e="modal-close-inner-button"]' } },
  actions: { dismiss: { op: "click", anchor: "dismiss", intent: "Close the login prompt" } },
  settle: { quietMs: 150, timeoutMs: 4000 },
};
// ---------------------------------------------------------------------------------------------

const nullable = (t: string) => ({ type: [t, "null"] });
const manifest: FlowManifest = {
  $schema: "../schema/a2flow.schema.json",
  a2flow: "0.2",
  id: "tiktok.profile",
  title: "TikTok profile scraper (Apify clockworks/tiktok-scraper · profiles flow)",
  description: "User input arrives as an A2UI form (control surface); an XState machine then, per profile, emits the author, dispatches A2UI loadMore until resultsPerPage tiles are projected, and opens/emits/closes each video — every page interaction is an A2UI action on the projected surface.",
  a2ui: { version: "v0.9", catalogId: BASIC_CATALOG_ID, theme: { primaryColor: "#FE2C55", agentDisplayName: "TikTok · a2flow" } },
  target: { baseUrl, viewport: { width: 1280, height: 900 }, browser: { humanize: true, headless: true } },
  inputs: {
    type: "object",
    required: ["profiles"],
    properties: {
      profiles: { type: "array", items: { type: "string" }, minItems: 1, description: "Usernames, with or without @" },
      resultsPerPage: { type: "integer", minimum: 1, maximum: 200, default: 10 },
    },
  },
  routes: {
    "tiktok.author": {
      description: "One profile (Apify authorMeta shape). Read from the A2UI stream: final state of each profile surface.",
      key: "name",
      from: { view: "profile", on: "close" },
      extract: `author.{ "name": uniqueId, "nickName": nickname, "signature": signature, "avatar": avatar,
        "fans": fans, "following": following, "heart": heart, "profileUrl": $model.page.url }`,
      schema: {
        type: "object", required: ["name"],
        properties: {
          name: { type: "string" }, nickName: nullable("string"), signature: nullable("string"), avatar: nullable("string"),
          fans: nullable("integer"), following: nullable("integer"), heart: nullable("integer"), profileUrl: { type: "string" },
        },
      },
    },
    "tiktok.video": {
      description: "FAST: one record per item of the profile's network-sourced /feed (the page's own item_list XHRs), capped at the run's resultsPerPage.",
      key: "id",
      from: { view: "profile", on: "item", each: "feed[[0..($surfaces.control.run.resultsPerPage - 1)]]" },
      extract: `(
        $a := author;
        {
          "id": $item.id, "text": $item.desc, "webVideoUrl": page.url & "/video/" & $item.id,
          "playCount": $item.stats.playCount, "diggCount": $item.stats.diggCount, "commentCount": $item.stats.commentCount,
          "shareCount": $item.stats.shareCount, "collectCount": $item.stats.collectCount,
          "createTime": $item.createTime, "createTimeISO": $fromMillis($item.createTime * 1000),
          "hashtags": [$item.hashtags.{ "name": $ }],
          "authorMeta": { "name": $a.uniqueId, "nickName": $a.nickname, "fans": $a.fans },
          "musicMeta": { "musicName": $item.music },
          "videoMeta": { "coverUrl": $item.cover, "duration": $item.duration }
        }
      )`,
      schema: {
        type: "object", required: ["id", "webVideoUrl"],
        properties: {
          id: { type: "string" }, text: nullable("string"), webVideoUrl: { type: "string" },
          playCount: nullable("integer"), diggCount: nullable("integer"), commentCount: nullable("integer"),
          shareCount: nullable("integer"), collectCount: nullable("integer"), createTime: nullable("integer"), createTimeISO: nullable("string"),
          hashtags: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
          authorMeta: { type: "object" }, musicMeta: { type: "object" }, videoMeta: { type: "object" },
        },
      },
    },
    "tiktok.video.detail": {
      dataset: "tiktok.video",
      description: "FALLBACK (feed unavailable): final state of each opened video surface, joined to its grid tile on the last profile surface.",
      key: "id",
      from: { view: "video", on: "close" },
      extract: `(
        $v := video;
        $tile := $surfaces.profile.videos[id = $v.id];
        $a := $surfaces.profile.author;
        {
          "id": $v.id, "text": $v.desc, "webVideoUrl": $v.url, "playCount": $tile.playCount,
          "diggCount": $v.diggCount, "commentCount": $v.commentCount, "shareCount": $v.shareCount, "collectCount": $v.collectCount,
          "createTimeText": $v.createTimeText,
          "hashtags": [$v.hashtags],
          "authorMeta": { "name": $a.uniqueId, "nickName": $v.nickname ? $v.nickname : $a.nickname, "fans": $a.fans },
          "musicMeta": { "musicName": $v.musicName },
          "videoMeta": { "coverUrl": $tile.cover, "duration": $v.duration ? $v.duration : $v.durationText }
        }
      )`,
      schema: {
        type: "object", required: ["id", "webVideoUrl"],
        properties: {
          id: { type: "string" }, text: nullable("string"), webVideoUrl: { type: "string" },
          playCount: nullable("integer"), diggCount: nullable("integer"), commentCount: nullable("integer"),
          shareCount: nullable("integer"), collectCount: nullable("integer"), createTimeText: nullable("string"),
          hashtags: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
          authorMeta: { type: "object" }, musicMeta: { type: "object" }, videoMeta: { type: "object" },
        },
      },
    },
  },
  // declaration order = match priority: outcomes shadow the views they look like
  views: { loginModal, notFound, privateAccount, videoUnavailable, profile, video },
  // ---- v0.2: user input is an A2UI surface; automation is an XState machine over A2UI actions ----
  policies: {
    timeouts: { navigate: 45000, await: 25000, action: 20000, input: 10000 },
    retry: { attempts: 4, baseMs: 800, maxMs: 10000, jitter: 0.3 },
    rateLimit: { minDelayMs: 250, jitterMs: 400 },
    // close login/promo modals (TikTok: modal-close-inner-button); never accept terms or log in
    dismiss: [{ sel: '[data-e2e="modal-close-inner-button"]', intent: "Close the login prompt" }],
    blocked: { selectors: ['#captcha-verify-container', '[id*="captcha_container"]', 'iframe[src*="captcha"]'], textPatterns: ["verify to continue", "drag the slider"], action: "fail" },
    http: { retry: [408, 425, 429, 500, 502, 503, 504], fatal: [401, 403, 404, 410] },
  },
  control: {
    dataModel: { inputs: { profiles: "", resultsPerPage: 10 } },
    components: [
      { id: "root", component: "Column", children: ["form_card", "work_card"] },
      { id: "form_card", component: "Card", child: "form" },
      { id: "form", component: "Column", children: ["form_title", "profiles_field", "rpp_slider", "start_button", "status_text", "attention_text", "resume_button"] },
      { id: "form_title", component: "Text", text: "TikTok profile scraper", variant: "h3" },
      { id: "profiles_field", component: "TextField", label: "Profiles (comma separated)", value: { path: "/inputs/profiles" }, variant: "shortText" },
      { id: "rpp_slider", component: "Slider", label: "Videos per profile", min: 1, max: 50, value: { path: "/inputs/resultsPerPage" } },
      {
        id: "start_button", component: "Button", variant: "primary", child: "start_label",
        checks: [{ condition: { call: "required", args: { value: { path: "/inputs/profiles" } } }, message: "Enter at least one profile" }],
        action: { event: { name: "start", context: { profiles: { path: "/inputs/profiles" }, resultsPerPage: { path: "/inputs/resultsPerPage" } } } },
      },
      { id: "start_label", component: "Text", text: "Scrape" },
      { id: "status_text", component: "Text", variant: "caption",
        text: { call: "formatString", args: { value: "${/status/state} · authors ${/status/tiktok_author} · videos ${/status/tiktok_video}" }, returnType: "string" } },
      { id: "attention_text", component: "Text", variant: "body", text: { path: "/attention/message" } },
      { id: "resume_button", component: "Button", child: "resume_label", action: { event: { name: "resume" } } },
      { id: "resume_label", component: "Text", text: "Resume" },
      // operator view of the unit-of-work ledger
      { id: "work_card", component: "Card", child: "work" },
      { id: "work", component: "Column", children: ["work_title", "work_totals", "work_list"] },
      { id: "work_title", component: "Text", text: "Units of work", variant: "h4" },
      { id: "work_totals", component: "Text", variant: "caption",
        text: { call: "formatString", args: { value: "profiles ${/work/totals/profile/done}✓ ${/work/totals/profile/failed}✗ · videos ${/work/totals/video/done}✓ ${/work/totals/video/failed}✗ ${/work/totals/video/running}…" }, returnType: "string" } },
      { id: "work_list", component: "List", direction: "vertical", children: { path: "/work/units", componentId: "work_row" } },
      { id: "work_row", component: "Row", justify: "spaceBetween", children: ["work_row_id", "work_row_status"] },
      { id: "work_row_id", component: "Text", variant: "caption", text: { path: "id" } },
      { id: "work_row_status", component: "Text", variant: "caption",
        text: { call: "formatString", args: { value: "${status} ×${attempts} ${error}" }, returnType: "string" } },
    ],
  },
  machine: {
    id: "tiktok.profile",
    initial: "idle",
    context: { profiles: [], resultsPerPage: 10, handle: null, author: null, queue: [], v: null, stall: 0, done: 0, error: null },
    // Interrupts (login prompt, banners) from anywhere: dismiss via the interrupt surface's A2UI action, then resume
    // exactly where we were (deep history). The interrupted op is re-run on re-entry, which is idempotent.
    on: { INTERRUPT: { target: ".interrupted" } },
    states: {
      interrupted: {
        description: "An interrupt view is over the page: press its `dismiss` button (A2UI action), then resume.",
        entry: [{ type: "log", params: { text: "interrupt: {{ event.view }}" } }],
        invoke: { src: "a2ui.act", input: { on: "dismiss" }, onDone: { target: "resume" }, onError: { target: "resume" } },
      },
      resume: { type: "history", history: "deep" },
      idle: {
        description: "Waiting for the control surface's `start` event (A2UI action from any client).",
        on: { start: { target: "nextProfile", actions: [
          { type: "ctx.set", params: { profiles: "{{ event.context.profiles | csv }}", resultsPerPage: "{{ event.context.resultsPerPage | int }}" } },
          // publish the run's inputs into the stream so stream-native routes (and replays) can use them
          { type: "a2ui.write", params: { path: "/run", value: { profiles: "{{ event.context.profiles | csv }}", resultsPerPage: "{{ event.context.resultsPerPage | int }}" } } },
        ] } },
      },
      // ---------- profile units ----------
      nextProfile: {
        always: [
          { guard: { type: "cond", params: { empty: "{{ profiles }}" } }, target: "done" },
          { target: "profileUnit", actions: [{ type: "ctx.shift", params: { from: "profiles", to: "handle" } }, { type: "ctx.set", params: { done: 0, stall: 0 } }] },
        ],
      },
      profileUnit: {
        description: "Unit `profile:<handle>`; already-completed units (ledger) are skipped — reruns are idempotent.",
        always: [
          { guard: { type: "work.done", params: { type: "profile", key: "{{ handle | trimAt }}" } }, target: "nextProfile",
            actions: [{ type: "log", params: { text: "skip profile {{ handle }} (done in ledger)" } }] },
          { target: "openProfile", actions: [{ type: "work.start", params: { type: "profile", key: "{{ handle | trimAt }}" } }] },
        ],
      },
      openProfile: { invoke: { src: "browser.navigate", input: { url: "/@{{ handle | trimAt }}" }, onDone: "awaitProfile", onError: "profileFailed" } },
      awaitProfile: {
        description: "Branch on which state the page is actually in: profile, not found, or private.",
        invoke: { src: "view.await", input: { views: ["profile", "notFound", "privateAccount"] }, onError: "profileFailed",
          onDone: [
            { guard: { type: "cond", params: { eq: ["{{ event.output.view }}", "notFound"] } }, target: "nextProfile",
              actions: [{ type: "work.skip", params: { type: "profile", key: "{{ handle | trimAt }}", reason: "not found" } }] },
            { guard: { type: "cond", params: { eq: ["{{ event.output.view }}", "privateAccount"] } }, target: "nextProfile",
              actions: [{ type: "work.skip", params: { type: "profile", key: "{{ handle | trimAt }}", reason: "private account" } }] },
            { target: "loadGrid", actions: [
              { type: "route.emit", params: { route: "tiktok.author" } },
              { type: "ctx.set", params: { author: { $model: "/author" } } },
            ] },
          ] },
      },
      loadGrid: {
        description: "Dispatch the A2UI `loadMore` action until enough tiles are projected or the grid stops growing.",
        always: [
          { guard: { type: "cond", params: { or: [
            { gte: [{ count: "/feed" }, "{{ resultsPerPage }}"] },                              // network feed is authoritative when present
            { and: [{ not: { exists: "/feed/0" } }, { gte: [{ count: "/videos" }, "{{ resultsPerPage }}"] }] },
            { and: [{ exists: "/grid/hasLoader" }, { not: { exists: "/grid/loaderText" } }] }, // explicit end of grid
            { stalled: 3 },                                                                      // implicit end of grid
          ] } }, target: "gridLoaded" },
          { target: "loadingMore" },
        ],
      },
      loadingMore: {
        invoke: { src: "a2ui.act", input: { on: "load_more", action: "loadMore" },
          onError: { target: "gridLoaded", actions: [{ type: "log", params: { text: "loadMore gave up; continuing with the tiles we have" } }] },
          onDone: { target: "loadGrid", actions: [{ type: "ctx.stall", params: { count: { $count: "/videos" } } }] } },
      },
      gridLoaded: {
        description: "Prefer the network feed (one emit, no navigation); fall back to opening each video.",
        always: [
          { guard: { type: "cond", params: { exists: "/feed/0" } }, target: "syncFeed" },
          { guard: { type: "cond", params: { eq: [{ count: "/videos" }, 0] } }, target: "profileComplete",
            actions: [{ type: "log", params: { text: "{{ handle }}: no videos" } }] },
          { target: "queueVideos", actions: [{ type: "log", params: { text: "{{ handle }}: feed unavailable — opening videos (slow path)" } }] },
        ],
      },
      syncFeed: {
        description: "Response bodies are parsed asynchronously: let the feed catch up with the rendered tiles, then emit once.",
        invoke: { src: "view.await", input: { view: "profile", until: { gte: [{ count: "/feed" }, { count: "/videos" }] }, timeoutMs: 5000 },
          onDone: { target: "profileComplete", actions: [{ type: "route.emit", params: { route: "tiktok.video" } }] },
          onError: { target: "profileComplete", actions: [{ type: "log", params: { text: "feed lagging tiles; emitting what was captured" } }, { type: "route.emit", params: { route: "tiktok.video" } }] } },
      },
      queueVideos: { entry: [{ type: "ctx.set", params: { queue: { $model: "/videos" } } }], always: { target: "nextVideo" } },
      // ---------- video units ----------
      nextVideo: {
        always: [
          { guard: { type: "cond", params: { or: [{ empty: "{{ queue }}" }, { gte: ["{{ done }}", "{{ resultsPerPage }}"] }] } }, target: "profileComplete" },
          { target: "videoUnit", actions: [{ type: "ctx.shift", params: { from: "queue", to: "v" } }] },
        ],
      },
      videoUnit: {
        always: [
          { guard: { type: "work.done", params: { type: "video", key: "{{ v.id }}" } }, target: "nextVideo", actions: [{ type: "ctx.inc", params: { key: "done" } }] },
          { target: "openingVideo", actions: [{ type: "work.start", params: { type: "video", key: "{{ v.id }}", parent: "profile:{{ handle | trimAt }}" } }] },
        ],
      },
      openingVideo: {
        invoke: { src: "a2ui.act", input: { on: "video_tile", action: "openVideo", item: { id: "{{ v.id }}" }, expect: ["video", "videoUnavailable"], within: 15000 }, onDone: "awaitVideo", onError: "videoFailed" },
      },
      awaitVideo: {
        invoke: { src: "view.await", input: { views: ["video", "videoUnavailable"] }, onError: "videoFailed",
          onDone: [
          { guard: { type: "cond", params: { eq: ["{{ event.output.view }}", "videoUnavailable"] } }, target: "closingVideo",
            actions: [{ type: "work.skip", params: { type: "video", key: "{{ v.id }}", reason: "unavailable" } }] },
          { target: "closingVideo", actions: [
            { type: "route.emit", params: { route: "tiktok.video.detail" } },
            { type: "work.complete", params: { type: "video", key: "{{ v.id }}" } },
            { type: "ctx.inc", params: { key: "done" } },
          ] }] },
      },
      closingVideo: { invoke: { src: "a2ui.act", input: { on: "back", action: "back", expect: "profile" }, onDone: "awaitBack", onError: "recoverProfile" } },
      awaitBack: { invoke: { src: "view.await", input: { view: "profile" }, onDone: "nextVideo", onError: "recoverProfile" } },
      videoFailed: {
        description: "Isolate the failure to this unit, then get back to a known state.",
        entry: [{ type: "work.fail", params: { type: "video", key: "{{ v.id }}", error: "{{ event.error.message }}" } }],
        always: { target: "recoverProfile" },
      },
      recoverProfile: { invoke: { src: "browser.navigate", input: { url: "/@{{ handle | trimAt }}" }, onDone: "awaitRecovered", onError: "profileFailed" } },
      awaitRecovered: { invoke: { src: "view.await", input: { view: "profile" }, onDone: "nextVideo", onError: "profileFailed" } },
      profileComplete: {
        entry: [{ type: "work.complete", params: { type: "profile", key: "{{ handle | trimAt }}" } }],
        always: { target: "nextProfile" },
      },
      profileFailed: {
        entry: [{ type: "work.fail", params: { type: "profile", key: "{{ handle | trimAt }}", error: "{{ event.error.message }}" } }],
        always: { target: "nextProfile" },
      },
      done: { type: "final" },
    },
  },
  provenance: {
    derivedAt: new Date().toISOString(),
    derivedFrom: "fixtures/tiktok-mock (mirrors tiktok.com data-e2e contract); 2 samples per view",
    refinement: "flows/tiktok-profile/*.patch.json — vision review of out/derive/*.annotated.png + canvas frames",
    reports,
  },
};

const errors = checkManifest(manifest);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
const out = join(here, "../tiktok-profile.a2flow.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${out} (${Object.keys(manifest.views).length} views, ${manifest.views.profile.components.length + manifest.views.video.components.length} components)`);
