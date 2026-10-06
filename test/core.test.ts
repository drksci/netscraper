import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diff, getAt, setAt } from "../src/a2ui/pointer.ts";
import { SurfaceStore, buildAction, instancesOf, renderTree } from "../src/a2ui/surface.ts";
import { msg } from "../src/a2ui/types.ts";
import { checkManifest, validateClientMessage, validateServerMessage } from "../src/manifest/load.ts";
import { evalCond, tmpl } from "../src/runtime/expr.ts";
import { applyRefinement } from "../src/derive/refine.ts";
import { dhash, hamming, structureKey } from "../src/derive/cache.ts";
import { PNG } from "pngjs";
import type { FlowManifest } from "../src/manifest/types.ts";

const manifest: FlowManifest = JSON.parse(readFileSync(new URL("../flows/tiktok-profile.a2flow.json", import.meta.url), "utf8"));

const profileModel = {
  author: { uniqueId: "chef.nova", nickname: "Chef Nova", avatar: "https://x/a.svg", following: 1, fans: 7200000, heart: 3, signature: "hi" },
  videos: [
    { id: "7300000000000000001", url: "https://x/@chef.nova/video/7300000000000000001", cover: "https://x/c1.svg", playCount: 12 },
    { id: "7300000000000000002", url: "https://x/@chef.nova/video/7300000000000000002", cover: "https://x/c2.svg", playCount: 34 },
  ],
};

test("pointer diff streams appends as per-item patches", () => {
  const a = { videos: [{ id: 1 }], n: 1 };
  const b = { videos: [{ id: 1 }, { id: 2 }, { id: 3 }], n: 2 };
  assert.deepEqual(diff(a, b), [
    { path: "/videos/1", value: { id: 2 } }, { path: "/videos/2", value: { id: 3 } }, { path: "/n", value: 2 },
  ]);
  let m: unknown = structuredClone(a);
  for (const p of diff(a, b)) m = setAt(m, p.path, p.value);
  assert.deepEqual(m, b);
  assert.equal(getAt(b, "/videos/2/id"), 3);
});

test("shipped manifest passes schema, A2UI catalog and cross-reference checks", () => {
  assert.deepEqual(checkManifest(manifest), []);
});

test("projected stream conforms to the official A2UI v0.9 server_to_client schema", () => {
  for (const [vid, v] of Object.entries(manifest.views)) {
    for (const m of [msg.createSurface(`${vid}-1`, manifest.a2ui.catalogId, manifest.a2ui.theme), msg.updateComponents(`${vid}-1`, v.components),
      msg.updateDataModel(`${vid}-1`, "/", profileModel), msg.updateDataModel(`${vid}-1`, "/videos/2", { id: "x" }), msg.deleteSurface(`${vid}-1`)]) {
      assert.deepEqual(validateServerMessage(m), [], `${vid}: ${Object.keys(m)[1]}`);
    }
  }
});

test("driver resolves template-scoped action context and emits a valid client action", () => {
  const store = new SurfaceStore();
  store.apply(msg.createSurface("profile-1"));
  store.apply(msg.updateComponents("profile-1", manifest.views.profile.components));
  store.apply(msg.updateDataModel("profile-1", "/", profileModel));
  const s = store.current()!;
  const tiles = instancesOf(s, "video_tile");
  assert.equal(tiles.length, 2);
  assert.equal(tiles[1].scope, "/videos/1");
  const a = buildAction(s, tiles[1]);
  assert.equal(a.action.name, "openVideo");
  assert.deepEqual(a.action.context, { id: "7300000000000000002" });
  assert.deepEqual(validateClientMessage(a), []);
  // formatNumber-bound stat renders from the raw count
  const fans = [...walkNodes(renderTree(s))].find((n) => n.id === "fans_value");
  assert.equal(fans?.props.text, "7,200,000");
});

function* walkNodes(n: any): Generator<any> { if (!n) return; yield n; for (const c of n.children) yield* walkNodes(c); }

test("conditions and templates", () => {
  const scope = { inputs: { resultsPerPage: 2 }, handle: "@chef.nova" };
  assert.equal(tmpl("/@{{ handle | trimAt }}", scope), "/@chef.nova");
  assert.equal(tmpl("{{ inputs.resultsPerPage }}", scope), 2);
  const c = { or: [{ gte: [{ count: "/videos" }, "{{ inputs.resultsPerPage }}"] }, { stalled: 3 }] } as const;
  assert.equal(evalCond(c as any, { model: profileModel, scope, view: "profile", stalled: 0 }), true);
  assert.equal(evalCond(c as any, { model: { videos: [] }, scope, view: "profile", stalled: 3 }), true);
  assert.equal(evalCond(c as any, { model: { videos: [] }, scope, view: "profile", stalled: 1 }), false);
});

test("refinement patch rewrites every reference and stays catalog-valid", () => {
  const v = manifest.views.profile;
  const { view, errors } = applyRefinement(v, {
    models: { "/videos": "/posts" }, fields: { "/videos": { playCount: "plays" } },
    components: { video_tile: "post_tile" }, actions: { openVideo: "openPost" }, drop: ["author_bio"],
  });
  assert.deepEqual(errors, []);
  assert.ok(view.model["/posts"] && !view.model["/videos"]);
  assert.ok((view.model["/posts"] as any).fields.plays);
  assert.equal((view.model["/author"] as any).fields.signature, undefined, "dropped component takes its field");
  const tile = view.components.find((c) => c.id === "post_tile")!;
  assert.equal((tile.action as any).event.name, "openPost");
  assert.deepEqual(view.anchors.post_tile, { model: "/posts" });
  assert.equal(view.actions.openPost.anchor, "post_tile");
  const grid = view.components.find((c) => c.id === "video_grid")!;
  assert.deepEqual(grid.children, { path: "/posts", componentId: "post_tile" });
});

test("inference cache: structure key ignores titles/intents; dHash tracks visual drift", () => {
  const v = manifest.views.video;
  const k = structureKey("video", v);
  assert.equal(structureKey("video", { ...v, title: "x", actions: { back: { ...v.actions.back, intent: "y" } } }), k);
  assert.notEqual(structureKey("video", { ...v, match: { ...v.match, path: "^/x$" } }), k);
  const img = (f: (x: number, y: number) => number) => {
    const p = new PNG({ width: 90, height: 80 });
    for (let y = 0; y < 80; y++) for (let x = 0; x < 90; x++) { const i = (y * 90 + x) * 4; p.data[i] = p.data[i + 1] = p.data[i + 2] = f(x, y); p.data[i + 3] = 255; }
    return PNG.sync.write(p);
  };
  const a = dhash(img((x) => x * 2)), a2 = dhash(img((x) => x * 2 + 3)), b = dhash(img((x) => 255 - x * 2));
  assert.ok(hamming(a, a2) <= 4, "brightness shift ≈ same");
  assert.ok(hamming(a, b) > 40, "inverted gradient = drift");
});

test("v0.2: control surface is catalog-valid, start action resolves bound context, machine lints clean", async () => {
  const { lintMachine } = await import("../src/machine/lint.ts");
  assert.equal(manifest.a2flow, "0.2");
  assert.deepEqual(lintMachine(manifest), []);
  const store = new SurfaceStore();
  store.apply(msg.createSurface("control-1"));
  store.apply(msg.updateComponents("control-1", manifest.control!.components));
  store.apply(msg.updateDataModel("control-1", "/", manifest.control!.dataModel));
  // write contract: the client writes locally, then the event context resolves from the local model
  store.apply(msg.updateDataModel("control-1", "/inputs/profiles", "chef.nova, dance.mike"));
  const s = store.current()!;
  const a = buildAction(s, instancesOf(s, "start_button")[0]);
  assert.deepEqual(a.action.context, { profiles: "chef.nova, dance.mike", resultsPerPage: 10 });
  assert.deepEqual(validateClientMessage(a), []);
  assert.deepEqual(tmpl("{{ p | csv }}", { p: a.action.context.profiles }), ["chef.nova", "dance.mike"]);
  // lint catches bad references
  const bad = structuredClone(manifest);
  (bad.machine!.states as any).idle.on.start.actions[0].type = "ctx.nope";
  (bad.machine!.states as any).openProfile.invoke.onDone = "nowhere";
  const errs = lintMachine(bad);
  assert.ok(errs.some((e) => e.includes('unknown action "ctx.nope"')), errs.join("\n"));
  assert.ok(errs.some((e) => e.includes('unknown target "nowhere"')), errs.join("\n"));
});

test("model-facing sanitiser strips blobs, data URLs, fingerprints and caps size", async () => {
  const { sanitize, forModel } = await import("../src/studio/sanitize.ts");
  const blob = "A".repeat(5000);
  const v = sanitize({
    cover: "data:image/jpeg;base64," + blob, token: (await import("node:crypto")).randomBytes(300).toString("base64"), hash: "ab".repeat(80),
    text: "hello", long: "y".repeat(2000), items: Array.from({ length: 100 }, (_, i) => ({ i })),
    fingerprint: { simhash: "1", shape: ["0:a"] }, nested: { deep: { thumb: "data:image/png;base64,iVBOR" + blob } },
  }) as any;
  assert.match(v.cover, /^<image\/jpeg data URL, .* omitted>$/);
  assert.match(v.token, /^<encoded blob, \d+ chars omitted>$/);
  assert.match(v.hash, /^<encoded blob/);
  assert.equal(v.text, "hello");
  assert.ok(v.long.length < 700 && v.long.includes("<+1400 chars>"));
  assert.equal(v.items.length, 26);
  assert.equal(v.fingerprint, "<omitted>");
  assert.match(v.nested.deep.thumb, /data URL/);
  assert.ok(forModel({ big: Array.from({ length: 5000 }, () => "z".repeat(50)) }).length < 25_000);
});
