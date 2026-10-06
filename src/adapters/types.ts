/**
 * The portable browser surface a flow manifest needs. Everything the runtime does goes through
 * this interface + string-evaluated in-page JS, so the same manifest runs on Playwright,
 * Puppeteer or a bare CDP websocket (e.g. a CloakBrowser Manager profile endpoint).
 */
export interface Rect { x: number; y: number; width: number; height: number }

export interface BrowserAdapter {
  readonly kind: "playwright" | "puppeteer" | "cdp";
  /** Navigate; resolves with the main document HTTP status when the client can see it. */
  goto(url: string): Promise<{ status?: number }>;
  url(): Promise<string>;
  /** Evaluate a JS *expression string* (never a closure) and return its JSON value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Run on every new document before page scripts, and once now. */
  addInitScript(source: string): Promise<void>;
  /** Expose `window[name](payload: string)` to the page. */
  exposeBinding(name: string, fn: (payload: string) => void): Promise<void>;
  click(selector: string): Promise<void>;
  /** Raw pointer click at viewport coordinates (the "multimodal" lane uses only this). */
  mouseClick(x: number, y: number): Promise<void>;
  wheel(dy: number, at?: { x: number; y: number }): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  back(): Promise<void>;
  screenshot(opts?: { fullPage?: boolean; clip?: Rect; type?: "png" | "jpeg" }): Promise<Buffer>;
  /** Raw CDP command on this page's target. */
  cdp<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  onCdp(event: string, fn: (params: any) => void): void;
  close(): Promise<void>;
}

export interface LaunchSpec {
  adapter: "playwright" | "puppeteer" | "cdp";
  headless?: boolean;
  humanize?: boolean;
  viewport?: { width: number; height: number };
  /** Attach to an existing CDP endpoint (ws:// or http://host:port) instead of launching. cdp adapter only. */
  endpoint?: string;
  proxy?: string;
  locale?: string;
  timezone?: string;
}
