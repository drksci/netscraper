import type { BrowserAdapter, LaunchSpec } from "./types.js";

export type { BrowserAdapter, LaunchSpec, Rect } from "./types.js";

/** Launch CloakBrowser behind the requested client library. */
export async function launchAdapter(spec: LaunchSpec): Promise<BrowserAdapter> {
  switch (spec.adapter) {
    case "playwright": return (await import("./playwright.js")).PlaywrightAdapter.launch(spec);
    case "puppeteer": return (await import("./puppeteer.js")).PuppeteerAdapter.launch(spec);
    case "cdp": return (await import("./cdp.js")).CdpAdapter.launch(spec);
    default: throw new Error(`unknown adapter ${(spec as LaunchSpec).adapter}`);
  }
}

/** Stream JPEG frames of the page via CDP Page.startScreencast (works on all three adapters). */
export async function startScreencast(a: BrowserAdapter, onFrame: (jpegBase64: string) => void, maxWidth = 640, opts: { everyNthFrame?: number; quality?: number } = {}): Promise<() => Promise<void>> {
  a.onCdp("Page.screencastFrame", (p: any) => {
    onFrame(p.data);
    a.cdp("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  await a.cdp("Page.startScreencast", { format: "jpeg", quality: opts.quality ?? 60, maxWidth, everyNthFrame: opts.everyNthFrame ?? 1 });
  return async () => { await a.cdp("Page.stopScreencast").catch(() => {}); };
}
