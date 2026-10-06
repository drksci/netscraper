/**
 * Transport-agnostic CDP adapter core: no Node imports, so the same code runs in Node (over `ws`), in a
 * browser/Worker (over a WebSocket) and inside QuickJS-wasm (over a host-bridged socket).
 *
 * Two attachment modes:
 *   - browser endpoint + flat session (Node launcher: Target.createTarget/attachToTarget, sessionId on every frame)
 *   - page-scoped socket (the Studio's /actor/cdp proxy: frames carry no sessionId; Target/Browser are not reachable)
 */
import type { BrowserAdapter } from "./types.js";

/** The minimal socket the core needs: send text frames, receive text frames. */
export interface CdpSocket {
  send(data: string): void;
  onMessage(fn: (data: string) => void): void;
  onClose?(fn: (reason?: string) => void): void;
  close(): void;
}

export class CdpConnection {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Map<string, Set<(p: any, sessionId?: string) => void>>();
  private closedWith?: string;
  constructor(private sock: CdpSocket) {
    sock.onMessage((raw) => {
      const m = JSON.parse(raw);
      if (m.id != null) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
        else p?.resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) ?? []) fn(m.params, m.sessionId);
      }
    });
    sock.onClose?.((reason) => {
      this.closedWith = reason ?? "closed";
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: Connection closed (${this.closedWith})`));
      this.pending.clear();
    });
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closedWith) return Promise.reject(new Error(`${method}: Connection closed (${this.closedWith})`));
    const id = ++this.seq;
    this.sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(event: string, fn: (p: any, sessionId?: string) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: (p: any, sessionId?: string) => void) { this.listeners.get(event)?.delete(fn); }
  close() { this.sock.close(); }
}

function b64bytes(b64: string): Uint8Array {
  const B = (globalThis as any).Buffer;
  if (B) return B.from(b64, "base64");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class CdpAdapterCore implements BrowserAdapter {
  readonly kind = "cdp" as const;
  private bindings = new Map<string, (p: string) => void>();
  private docStatus?: number;

  /** `sessionId` undefined = page-scoped socket (frames carry no sessionId). */
  protected constructor(
    protected conn: CdpConnection,
    protected sessionId: string | undefined,
    private cleanup: () => Promise<void>,
  ) {
    conn.on("Runtime.bindingCalled", (p, sid) => { if (sid === this.sessionId) this.bindings.get(p.name)?.(p.payload); });
    conn.on("Network.responseReceived", (p, sid) => { if (sid === this.sessionId && p.type === "Document") this.docStatus = p.response?.status; });
  }

  /** Attach to a page-scoped CDP socket (e.g. the Studio's /actor/cdp proxy). */
  static async overPageSocket(sock: CdpSocket, opts: { viewport?: { width: number; height: number } } = {}): Promise<CdpAdapterCore> {
    const conn = new CdpConnection(sock);
    for (const d of ["Page", "Runtime", "DOM", "Network"]) await conn.send(`${d}.enable`);
    if (opts.viewport) {
      await conn.send("Emulation.setDeviceMetricsOverride", { width: opts.viewport.width, height: opts.viewport.height, deviceScaleFactor: 1, mobile: false });
    }
    return new CdpAdapterCore(conn, undefined, async () => conn.close());
  }

  cdp<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.conn.send<T>(method, params ?? {}, this.sessionId);
  }
  onCdp(event: string, fn: (p: any) => void) {
    this.conn.on(event, (p, sid) => { if (sid === this.sessionId) fn(p); });
  }
  private waitEvent(event: string, timeoutMs = 30_000): Promise<void> {
    return new Promise((res) => {
      const h = (_: any, sid?: string) => { if (sid === this.sessionId) { this.conn.off(event, h); clearTimeout(t); res(); } };
      const t = setTimeout(() => { this.conn.off(event, h); res(); }, timeoutMs);
      this.conn.on(event, h);
    });
  }

  async goto(url: string) {
    this.docStatus = undefined;
    const loaded = this.waitEvent("Page.domContentEventFired", 60_000);
    const r = await this.cdp("Page.navigate", { url });
    if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
    await loaded;
    return { status: this.docStatus };
  }
  async url() { return this.evaluate<string>("location.href"); }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  async addInitScript(source: string) {
    await this.cdp("Page.addScriptToEvaluateOnNewDocument", { source });
    await this.evaluate(source).catch(() => {});
  }
  async exposeBinding(name: string, fn: (payload: string) => void) {
    this.bindings.set(name, fn);
    await this.cdp("Runtime.addBinding", { name });
  }
  private async center(selector: string) {
    const r = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
      e.scrollIntoView({block:"center"}); const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!r) throw new Error(`no element for ${selector}`);
    return r;
  }
  async click(selector: string) { const { x, y } = await this.center(selector); await this.mouseClick(x, y); }
  async mouseClick(x: number, y: number) {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  async wheel(dy: number, at = { x: 400, y: 400 }) {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: dy });
  }
  async type(selector: string, text: string) {
    await this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.value = ""; })()`);
    await this.cdp("Input.insertText", { text });
  }
  async press(key: string) {
    const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, PageDown: 34, End: 35 };
    for (const type of ["keyDown", "keyUp"]) {
      await this.cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0, ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) });
    }
  }
  async back() {
    const h = await this.cdp("Page.getNavigationHistory");
    if (h.currentIndex <= 0) return;
    const loaded = this.waitEvent("Page.domContentEventFired", 15_000);
    await this.cdp("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
    await loaded;
  }
  async screenshot(opts: { fullPage?: boolean; clip?: any; type?: "png" | "jpeg" } = {}) {
    const r = await this.cdp("Page.captureScreenshot", {
      format: opts.type ?? "png",
      captureBeyondViewport: !!opts.fullPage,
      ...(opts.clip ? { clip: { ...opts.clip, scale: 1 } } : {}),
    });
    return b64bytes(r.data) as Buffer;
  }
  async close() { await this.cleanup(); }
}
