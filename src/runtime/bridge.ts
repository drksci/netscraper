/**
 * ActionBridge — the A2UI "server" side for a browser-backed surface. It receives v0.9 client
 * `action` messages and realises them on the page via the view's action map + anchors.
 */
import type { BrowserAdapter } from "../adapters/types.js";
import type { ClientAction } from "../a2ui/types.js";
import type { ActionMap, FlowManifest } from "../manifest/types.js";
import type { Projector } from "../render/projector.js";
import { tmpl } from "./expr.js";

interface Located { selector: string; rect: { x: number; y: number; width: number; height: number }; visible: boolean }

export class ActionBridge {
  constructor(public adapter: BrowserAdapter, private manifest: FlowManifest, private projector: Projector) {}

  async handle(a: ClientAction): Promise<void> {
    const view = (a.action.surfaceId && this.projector.viewOfSurface(a.action.surfaceId)) || this.projector.view;
    if (!view) throw new Error(`action ${a.action.name}: no active view`);
    const v = this.manifest.views[view];
    if (a.action.name === "input") {
      const anchor = v.anchors[a.action.sourceComponentId];
      if (!anchor) throw new Error(`no anchor for input ${a.action.sourceComponentId}`);
      const loc = await this.locate(view, a.action.sourceComponentId);
      if (!loc) throw new Error(`input target ${a.action.sourceComponentId} not on page`);
      await this.adapter.type(loc.selector, String(a.action.context.value ?? ""));
      return;
    }
    const am = v.actions[a.action.name];
    if (!am) throw new Error(`view ${view} has no mapping for action "${a.action.name}"`);
    await this.perform(view, am, a.action.context);
  }

  private async perform(view: string, am: ActionMap, ctx: Record<string, unknown>, depth = 0): Promise<void> {
    const v = this.manifest.views[view];
    switch (am.op) {
      case "click": {
        const key = am.key ? ctx[am.key] : undefined;
        let loc = await this.locate(view, am.anchor!, key);
        for (let i = 0; !loc && am.reveal && i < (am.revealMax ?? 8) && depth === 0; i++) {
          await this.perform(view, v.actions[am.reveal], ctx, depth + 1);
          await this.projector.settle(400, 5000);
          loc = await this.locate(view, am.anchor!, key);
        }
        if (!loc) throw new Error(`click target ${am.anchor}${key != null ? `[${am.key}=${key}]` : ""} not found`);
        await this.adapter.click(loc.selector);
        return;
      }
      case "scroll": {
        const [vw, vh] = await this.adapter.evaluate<[number, number]>("[innerWidth, innerHeight]");
        const point = { x: Math.round(vw / 2), y: Math.round(vh * 0.6) };
        const total = am.by === "end" ? 4 : 1;
        const dy = typeof am.by === "number" ? am.by : Math.round(vh * 0.9);
        for (let i = 0; i < total; i++) { await this.adapter.wheel(dy, point); await sleep(250); }
        return;
      }
      case "type": {
        const loc = await this.locate(view, am.anchor!);
        if (!loc) throw new Error(`type target ${am.anchor} not found`);
        await this.adapter.type(loc.selector, String(tmpl(am.text ?? "{{ value }}", ctx)));
        return;
      }
      case "press": await this.adapter.press(am.text ?? "Enter"); return;
      case "back": await this.adapter.back(); return;
      case "navigate": await this.adapter.goto(new URL(String(tmpl(am.url!, ctx)), this.manifest.target.baseUrl).href); return;
    }
  }

  locate(view: string, componentId: string, key?: unknown, index?: number): Promise<Located | null> {
    const anchor = this.manifest.views[view].anchors[componentId];
    if (!anchor) throw new Error(`no anchor for component ${componentId} in view ${view}`);
    return this.adapter.evaluate<Located | null>(
      `window.__a2flow.locate(${JSON.stringify(view)}, ${JSON.stringify(anchor)}, ${JSON.stringify(key ?? null)}, ${index ?? "null"})`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
