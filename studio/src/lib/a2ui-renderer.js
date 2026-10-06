// @ts-nocheck
// Minimal A2UI v0.9 web renderer (basic catalog subset) — consumes the server→client stream,
// renders surfaces, and emits v0.9 client→server `action` messages when Buttons are pressed.
// Dependency-free ES module; used by the live viewer and the static test report.

const ptr = (p) => (p === "/" || p === "" ? [] : p.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")));
const getAt = (o, p) => ptr(p).reduce((c, k) => (c == null ? undefined : c[k]), o);
function setAt(root, p, v) {
  const parts = ptr(p);
  if (!parts.length) return v === undefined ? {} : v;
  root = root && typeof root === "object" ? root : {};
  let c = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (c[parts[i]] == null || typeof c[parts[i]] !== "object") c[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    c = c[parts[i]];
  }
  if (v === undefined) delete c[parts[parts.length - 1]]; else c[parts[parts.length - 1]] = v;
  return root;
}
const resolvePath = (p, scope) => (p.startsWith("/") ? p : `${scope === "/" ? "" : scope}/${p}`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const str = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function resolve(v, model, scope = "/") {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (typeof v.path === "string" && Object.keys(v).length === 1) return getAt(model, resolvePath(v.path, scope));
    if (typeof v.call === "string") {
      const a = (k) => resolve(v.args?.[k], model, scope);
      if (v.call === "formatNumber") { const n = Number(a("value")); return Number.isFinite(n) ? n.toLocaleString("en-US") : ""; }
      if (v.call === "formatString") return String(a("value") ?? "").replace(/\$\{([^}]+)\}/g, (_, p) => str(getAt(model, resolvePath(p.trim(), scope))));
      return "";
    }
  }
  return v;
}

const ICONS = { close: "✕", arrowBack: "←", favorite: "♥", search: "⌕", play: "▶", share: "↗", mail: "✉", home: "⌂" };

export class A2UIClient {
  constructor({ onAction } = {}) { this.surfaces = new Map(); this.order = []; this.onAction = onAction; }

  apply(m) {
    if (m.createSurface) {
      const { surfaceId, catalogId, theme } = m.createSurface;
      this.surfaces.set(surfaceId, { surfaceId, catalogId, theme: theme || {}, components: new Map(), model: {} });
      this.order.push(surfaceId);
    } else if (m.updateComponents) {
      const s = this.surfaces.get(m.updateComponents.surfaceId);
      if (s) for (const c of m.updateComponents.components) s.components.set(c.id, c);
    } else if (m.updateDataModel) {
      const s = this.surfaces.get(m.updateDataModel.surfaceId);
      if (s) s.model = setAt(s.model, m.updateDataModel.path || "/", m.updateDataModel.value);
    } else if (m.deleteSurface) {
      this.surfaces.delete(m.deleteSurface.surfaceId);
      this.order = this.order.filter((x) => x !== m.deleteSurface.surfaceId);
    }
  }

  /** Render the latest surface into `el`, wiring Button clicks to `onAction`. */
  mount(el, surfaceId = this.order[this.order.length - 1]) {
    const s = this.surfaces.get(surfaceId);
    if (!s) { el.innerHTML = `<div class="a2-empty">no surface</div>`; return; }
    const keep = el.scrollTop;
    el.style.setProperty("--a2-primary", s.theme.primaryColor || "#2563eb");
    el.innerHTML = `<div class="a2-surface" data-surface="${esc(s.surfaceId)}">${this.node(s, "root", "/", new Set())}</div>`;
    el.scrollTop = keep;
    // Write contract: input components write to the local data model immediately (no network)
    el.querySelectorAll("[data-a2-bind]").forEach((inp) => inp.addEventListener("input", () => {
      const v = inp.type === "range" || inp.type === "number" ? Number(inp.value) : inp.type === "checkbox" ? inp.checked : inp.value;
      s.model = setAt(s.model, resolvePath(inp.dataset.a2Bind, inp.closest("[data-scope]")?.dataset.scope || "/"), v);
      this.refreshChecks(el, s);
    }));
    this.refreshChecks(el, s);
    el.querySelectorAll("[data-a2-action]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      const c = s.components.get(b.dataset.cid);
      const ev = c.action.event;
      const context = {};
      for (const [k, v] of Object.entries(ev.context || {})) context[k] = resolve(v, s.model, b.dataset.scope);
      this.onAction?.({ version: "v0.9", action: { name: ev.name, surfaceId: s.surfaceId, sourceComponentId: c.id, timestamp: new Date().toISOString(), context } });
    }));
  }

  /** Basic-catalog `checks`: a failing check disables the Button (UX only — the agent still validates). */
  refreshChecks(el, s) {
    el.querySelectorAll("[data-a2-action]").forEach((b) => {
      const c = s.components.get(b.dataset.cid);
      const failed = (c.checks || []).find((k) => {
        const cond = k.condition;
        if (cond && cond.call === "required") { const v = resolve(cond.args?.value, s.model, b.dataset.scope); return v == null || v === "" || (Array.isArray(v) && !v.length); }
        return resolve(cond, s.model, b.dataset.scope) === false;
      });
      b.disabled = !!failed;
      b.title = failed ? failed.message : "";
    });
  }

  kids(s, c, scope, seen) {
    const ch = c.children;
    if (Array.isArray(ch)) return ch.map((id) => this.node(s, id, scope, seen)).join("");
    if (ch && typeof ch === "object") {
      const list = resolvePath(ch.path, scope);
      const items = getAt(s.model, list);
      return Array.isArray(items) ? items.map((_, i) => this.node(s, ch.componentId, `${list === "/" ? "" : list}/${i}`, seen)).join("") : "";
    }
    return "";
  }

  node(s, id, scope, seen) {
    const c = s.components.get(id);
    const key = id + "@" + scope;
    if (!c || seen.has(key)) return "";
    seen.add(key);
    const r = (v) => resolve(v, s.model, scope);
    const attrs = `data-cid="${esc(id)}" data-scope="${esc(scope)}"`;
    const flex = (dir) => `style="flex-direction:${dir};justify-content:${{ spaceBetween: "space-between", spaceAround: "space-around", spaceEvenly: "space-evenly", start: "flex-start", end: "flex-end" }[c.justify] || c.justify || "flex-start"};align-items:${{ start: "flex-start", end: "flex-end" }[c.align] || c.align || "stretch"}"`;
    switch (c.component) {
      case "Column": return `<div class="a2-col" ${attrs} ${flex("column")}>${this.kids(s, c, scope, seen)}</div>`;
      case "Row": return `<div class="a2-row" ${attrs} ${flex("row")}>${this.kids(s, c, scope, seen)}</div>`;
      case "List": return `<div class="a2-list a2-${c.direction || "vertical"}" ${attrs}>${this.kids(s, c, scope, seen)}</div>`;
      case "Card": return `<div class="a2-card" ${attrs}>${this.node(s, c.child, scope, seen)}</div>`;
      case "Divider": return `<hr class="a2-divider" ${attrs}>`;
      case "Icon": return `<span class="a2-icon" ${attrs}>${ICONS[r(c.name)] || "•"}</span>`;
      case "Text": {
        const t = str(r(c.text));
        const v = c.variant || "body";
        const tag = /^h[1-5]$/.test(v) ? v : "p";
        return `<${tag} class="a2-text a2-${v}" ${attrs}>${esc(t)}</${tag}>`;
      }
      case "Image": {
        const u = str(r(c.url));
        return u ? `<img class="a2-img a2-${c.variant || "mediumFeature"}" style="object-fit:${c.fit || "cover"}" src="${esc(u)}" alt="${esc(str(r(c.description)))}" ${attrs}>` : `<div class="a2-img a2-${c.variant || "mediumFeature"} a2-placeholder" ${attrs}></div>`;
      }
      case "Button": return `<button class="a2-btn a2-${c.variant || "default"}" data-a2-action="1" ${attrs}>${this.node(s, c.child, scope, seen)}</button>`;
      case "TextField": return `<label class="a2-field" ${attrs}><span>${esc(str(r(c.label)))}</span><input ${c.value?.path ? `data-a2-bind="${esc(c.value.path)}"` : ""} type="${c.variant === "number" ? "number" : c.variant === "obscured" ? "password" : "text"}" value="${esc(str(r(c.value)))}"></label>`;
      case "Slider": return `<label class="a2-field" ${attrs}><span>${esc(str(r(c.label)))} <output>${esc(str(r(c.value)))}</output></span><input type="range" min="${c.min ?? 0}" max="${c.max ?? 100}" ${c.value?.path ? `data-a2-bind="${esc(c.value.path)}"` : ""} value="${esc(str(r(c.value)))}" oninput="this.previousElementSibling.querySelector('output').textContent=this.value"></label>`;
      case "CheckBox": return `<label class="a2-check" ${attrs}><input type="checkbox" ${c.value?.path ? `data-a2-bind="${esc(c.value.path)}"` : ""} ${r(c.value) ? "checked" : ""}> ${esc(str(r(c.label)))}</label>`;
      default: return `<div class="a2-unknown" ${attrs}>[${esc(c.component)}]</div>`;
    }
  }
}

export const A2UI_CSS = `
.a2-surface{font:14px/1.4 system-ui,sans-serif;color:var(--a2-fg,#111)}
.a2-col,.a2-row{display:flex;gap:8px}.a2-row{flex-wrap:wrap}
.a2-list.a2-vertical{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.a2-list.a2-horizontal{display:flex;gap:6px;flex-wrap:wrap}
.a2-card{border:1px solid var(--a2-line,#e5e7eb);border-radius:10px;padding:10px;background:var(--a2-card,#fff)}
.a2-text{margin:0}.a2-h1{font-size:24px}.a2-h2{font-size:20px}.a2-h3{font-size:17px}.a2-h4{font-size:15px;font-weight:700}.a2-caption{font-size:12px;opacity:.7}
.a2-img{display:block;background:#0001;border-radius:6px}.a2-avatar{width:56px;height:56px;border-radius:50%}
.a2-smallFeature{width:96px;height:96px}.a2-mediumFeature{width:100%;aspect-ratio:3/4}.a2-largeFeature{width:100%;aspect-ratio:16/9}
.a2-btn{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--a2-line,#d1d5db);background:var(--a2-card,#fff);padding:6px 10px;text-align:left;color:inherit}
.a2-btn.a2-primary{background:var(--a2-primary);color:#fff;border:0}.a2-btn.a2-borderless{border:0;background:none;padding:0}
.a2-btn.a2-borderless:hover .a2-card{outline:2px solid var(--a2-primary)}
.a2-field{display:flex;flex-direction:column;gap:4px;font-size:12px}.a2-field input[type=text],.a2-field input[type=number]{font:inherit;font-size:14px;padding:6px 8px;border-radius:6px;border:1px solid var(--a2-line,#d1d5db);background:var(--a2-card,#fff);color:inherit}
.a2-btn:disabled{opacity:.45;cursor:not-allowed}
.a2-placeholder{background:repeating-linear-gradient(45deg,#0001 0 6px,transparent 6px 12px)}
`;
