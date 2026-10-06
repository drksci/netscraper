import type { BrowserContext, CDPSession, Page } from "playwright-core";
import type { BrowserAdapter, LaunchSpec } from "./types.js";

export class PlaywrightAdapter implements BrowserAdapter {
  readonly kind = "playwright" as const;
  private session?: Promise<CDPSession>;
  constructor(readonly page: Page, private owner?: { close(): Promise<void> }) {}

  static async launch(spec: LaunchSpec): Promise<PlaywrightAdapter> {
    const { launchContext } = await import("cloakbrowser");
    const ctx: BrowserContext = await launchContext({
      headless: spec.headless ?? true,
      humanize: spec.humanize ?? false,
      viewport: spec.viewport ?? { width: 1280, height: 900 },
      proxy: spec.proxy,
      locale: spec.locale,
      timezone: spec.timezone,
    });
    const page = await ctx.newPage();
    return new PlaywrightAdapter(page, { close: async () => { await ctx.close(); await ctx.browser()?.close(); } });
  }

  async goto(url: string) { const r = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); return { status: r?.status() }; }
  async url() { return this.page.url(); }
  async evaluate<T>(expression: string): Promise<T> { return this.page.evaluate(expression) as Promise<T>; }
  async addInitScript(source: string) {
    await this.page.addInitScript({ content: source });
    await this.page.evaluate(source).catch(() => {});
  }
  private bindings = new Map<string, (payload: string) => void>();
  /** Idempotent per page: re-exposing a name just swaps the handler (repeated runs in one session). */
  async exposeBinding(name: string, fn: (payload: string) => void) {
    const had = this.bindings.has(name);
    this.bindings.set(name, fn);
    if (!had) await this.page.exposeBinding(name, (_src, payload: string) => this.bindings.get(name)?.(payload));
  }
  async click(selector: string) { await this.page.click(selector, { timeout: 15_000 }); }
  async mouseClick(x: number, y: number) { await this.page.mouse.click(x, y); }
  async wheel(dy: number, at?: { x: number; y: number }) {
    if (at) await this.page.mouse.move(at.x, at.y);
    await this.page.mouse.wheel(0, dy);
  }
  async type(selector: string, text: string) { await this.page.fill(selector, ""); await this.page.type(selector, text); }
  async press(key: string) { await this.page.keyboard.press(key); }
  async back() { await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null); }
  async screenshot(opts: { fullPage?: boolean; clip?: any; type?: "png" | "jpeg" } = {}) {
    return this.page.screenshot({ fullPage: opts.fullPage, clip: opts.clip, type: opts.type ?? "png" });
  }
  private sess() { return (this.session ??= this.page.context().newCDPSession(this.page)); }
  async cdp<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return (await this.sess()).send(method as any, params as any) as Promise<T>;
  }
  onCdp(event: string, fn: (p: any) => void) { this.sess().then((s) => s.on(event as any, fn)); }
  async close() { await (this.owner?.close() ?? this.page.close()); }
}
