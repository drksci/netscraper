/**
 * Portability (single-manifest) e2e: the same flows/tiktok-profile.a2flow.json runs on
 * Playwright, Puppeteer and raw CDP against the deterministic mock and yields identical records.
 * Set A2FLOW_SKIP_E2E=1 to skip (launches CloakBrowser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock, mockUser } from "../fixtures/tiktok-mock/server.ts";
import { launchAdapter } from "../src/adapters/index.ts";
import { loadManifest, validateServerMessage } from "../src/manifest/load.ts";
import { createRunner } from "../src/runtime/index.ts";

const skip = !!process.env.A2FLOW_SKIP_E2E;

test("same manifest, three clients, identical output", { skip, timeout: 600_000 }, async () => {
  const { server, url } = await startMock();
  const results: Record<string, unknown> = {};
  try {
    for (const adapter of ["playwright", "puppeteer", "cdp"] as const) {
      const m = loadManifest(new URL("../flows/tiktok-profile.a2flow.json", import.meta.url).pathname);
      m.target.baseUrl = url;
      const a = await launchAdapter({ adapter, headless: true, humanize: false, viewport: m.target.viewport });
      try {
        const r = createRunner(m, a, { profiles: ["@chef.nova"], resultsPerPage: 3 });
        const res = await r.run();
        for (const msg of r.projector.log) assert.deepEqual(validateServerMessage(msg), [], adapter);
        results[adapter] = res;
      } finally { await a.close(); }
    }
  } finally { server.close(); }
  const pw: any = results.playwright;
  assert.equal(pw["tiktok.author"].length, 1);
  assert.equal(pw["tiktok.video"].length, 3);
  const truth = mockUser("chef.nova");
  assert.equal(pw["tiktok.author"][0].fans, Math.round(Number((truth.user.stats.followerCount / 1e6).toFixed(1)) * 1e6), "abbreviated count round-trips");
  assert.deepEqual(pw["tiktok.video"].map((v: any) => v.id), truth.videos.slice(0, 3).map((v) => v.id));
  assert.equal(pw["tiktok.video"][0].videoMeta.duration, truth.videos[0].duration);
  assert.deepEqual(results.puppeteer, results.playwright);
  assert.deepEqual(results.cdp, results.playwright);
});
