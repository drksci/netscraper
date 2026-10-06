import type { Browser, CDPSession, Page } from "puppeteer-core";
import type { BrowserAdapter, LaunchSpec } from "./types.js";

export class PuppeteerAdapter implements BrowserAdapter {
  readonly kind = "puppeteer" as const;
  private session?: Promise<CDPSession>;
  constructor(readonly page: Page, private browser?: Browser) {}

  static async launch(spec: LaunchSpec): Promise<PuppeteerAdapter> {
    const { launch } = await import("cloakbrowser/puppeteer");
    const browser = (await launch({
      headless: spec.headless ?? true,
      humanize: spec.humanize ?? false,
      proxy: spec.proxy,
      locale: spec.locale,
      timezone: spec.timezone,
    })) as unknown as Browser;
    const page = await browser.newPage();
    await page.setViewport(spec.viewport ?? { width: 1280, height: 900 });
    return new PuppeteerAdapter(page, browser);
  }

  async goto(url: string) { const r = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); return { status: r?.status() }; }
  async url() { return this.page.url(); }
  async evaluate<T>(expression: string): Promise<T> { return this.page.evaluate(expression) as Promise<T>; }
  async addInitScript(source: string) {
    await this.page.evaluateOnNewDocument(source);
    await this.page.evaluate(source).catch(() => {});
  }
  private bindings = new Map<string, (payload: string) => void>();
  async exposeBinding(name: string, fn: (payload: string) => void) {
    const had = this.bindings.has(name);
    this.bindings.set(name, fn);
    if (!had) await this.page.exposeFunction(name, (p: string) => this.bindings.get(name)?.(p));
  }
  async click(selector: string) { await this.page.click(selector); }
  async mouseClick(x: number, y: number) { await this.page.mouse.click(x, y); }
  async wheel(dy: number, at?: { x: number; y: number }) {
    if (at) await this.page.mouse.move(at.x, at.y);
    await this.page.mouse.wheel({ deltaY: dy });
  }
  async type(selector: string, text: string) {
    await this.page.$eval(selector, (e: any) => { e.value = ""; });
    await this.page.type(selector, text);
  }
  async press(key: string) { await this.page.keyboard.press(key as any); }
  async back() { await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null); }
  async screenshot(opts: { fullPage?: boolean; clip?: any; type?: "png" | "jpeg" } = {}) {
    return Buffer.from(await this.page.screenshot({ fullPage: opts.fullPage, clip: opts.clip, type: opts.type ?? "png" }));
  }
  private sess() { return (this.session ??= this.page.createCDPSession()); }
  async cdp<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return (await this.sess()).send(method as any, params as any) as Promise<T>;
  }
  onCdp(event: string, fn: (p: any) => void) { this.sess().then((s) => s.on(event as any, fn)); }
  async close() { await (this.browser ? this.browser.close() : this.page.close()); }
}
