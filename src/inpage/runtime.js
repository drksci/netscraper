/*
 * a2flow in-page runtime. Plain ES2020, no imports: injected verbatim by every adapter
 * (Playwright / Puppeteer / raw CDP) via addInitScript + evaluate, so behaviour is identical
 * regardless of the automation client. Installs `window.__a2flow`.
 */
(function install() {
  if (window.__a2flow && window.__a2flow.__v === 1) return;

  const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  const qs = (root, sel) => { try { return root.querySelector(sel); } catch { return null; } };
  const qsa = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } };

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01;
  }

  function jsonAt(obj, ptr) {
    if (!ptr || ptr === "/") return obj;
    return ptr.slice(1).split("/").reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), obj);
  }

  function getVal(el, get) {
    if (get === "text") return norm(el.innerText != null && el.innerText !== "" ? el.innerText : el.textContent);
    if (get === "src") {
      const img = el.tagName === "IMG" || el.tagName === "VIDEO" ? el : qs(el, "img,video");
      if (!img) return null;
      return img.currentSrc || img.src || img.poster || (img.getAttribute("srcset") || "").split(/\s+/)[0] || null;
    }
    if (get === "bg") { const m = /url\(["']?([^"')]+)/.exec(getComputedStyle(el).backgroundImage || ""); return m ? m[1] : null; }
    if (get === "html") return el.innerHTML;
    if (get === "location") return location.href;
    if (get === "canvas") return captureCanvas(el.tagName === "CANVAS" || el.tagName === "VIDEO" ? el : qs(el, "canvas,video"), 160);
    if (get.startsWith("attr:")) return el.getAttribute(get.slice(5));
    if (get.startsWith("prop:")) return el[get.slice(5)];
    if (get.startsWith("json:")) { try { return jsonAt(JSON.parse(el.textContent), get.slice(5)); } catch { return null; } }
    return null;
  }

  function conv(v, as) {
    if (v == null) return null;
    if (!as || as === "string") return typeof v === "string" ? v : typeof v === "object" ? v : String(v);
    if (as === "count") {
      const m = /([\d.,]+)\s*([KMB])?/i.exec(String(v));
      if (!m) return null;
      const n = parseFloat(m[1].replace(/,/g, ""));
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
      return Math.round(n * mult);
    }
    if (as === "int") { const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10); return Number.isFinite(n) ? n : null; }
    if (as === "float") { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
    if (as === "bool") return !!v && v !== "false";
    if (as === "seconds") { // "01:08" | "1:02:03" | "43" → seconds
      const parts = String(v).trim().split(":").map(Number);
      return parts.some((x) => !Number.isFinite(x)) ? null : parts.reduce((a, x) => a * 60 + x, 0);
    }
    if (as === "url") { try { return new URL(String(v), location.href).href; } catch { return null; } }
    return v;
  }

  function applyRe(v, re) {
    if (!re || v == null) return v;
    const m = new RegExp(re).exec(String(v));
    return m ? (m[1] !== undefined ? m[1] : m[0]) : null;
  }

  function extractField(spec, root) {
    const els = spec.sel ? (spec.all ? qsa(root, spec.sel) : [qs(root, spec.sel)].filter(Boolean)) : [root];
    const vals = [];
    for (const el of els) {
      const v = conv(applyRe(getVal(el, spec.get || "text"), spec.re), spec.as);
      if (v != null && v !== "") vals.push(v);
    }
    if (spec.all) return vals;
    return vals.length ? vals[0] : (spec.default !== undefined ? spec.default : null);
  }

  function extractFields(fields, root) {
    const o = {};
    for (const k of Object.keys(fields)) o[k] = extractNode(fields[k], root);
    return o;
  }

  function extractNode(spec, root) {
    if (spec.each) {
      const out = [], seen = new Set();
      for (const el of qsa(root, spec.each)) {
        const o = extractFields(spec.fields || {}, el);
        if (spec.key) {
          const k = o[spec.key];
          if (k == null || seen.has(k)) continue;
          seen.add(k);
        }
        out.push(o);
        if (spec.limit && out.length >= spec.limit) break;
      }
      return out;
    }
    if (spec.fields) {
      const scope = spec.scope ? qs(root, spec.scope) : root;
      return scope ? extractFields(spec.fields, scope) : null;
    }
    return extractField(spec, root);
  }

  function setPtr(obj, ptr, v) {
    const parts = ptr.slice(1).split("/");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = cur[parts[i]] || {};
    cur[parts[parts.length - 1]] = v;
  }

  // ---------- views ----------
  const state = { views: {}, lastSent: null, observer: null };

  function viewMatches(id) {
    const m = state.views[id].match || {};
    if (m.path && !new RegExp(m.path).test(location.pathname)) return false;
    if (m.selector && !qs(document, m.selector)) return false;
    if (m.absent && qs(document, m.absent)) return false;
    if (m.text && !new RegExp(m.text, "i").test(((document.body && document.body.innerText) || "").slice(0, 8000))) return false;
    return true;
  }
  /** Interrupt views (modals, banners, captchas) currently over the page, with their projected models. */
  function interrupts() {
    return Object.keys(state.views).filter((id) => state.views[id].interrupt && viewMatches(id)).map((id) => ({ id, model: extract(id) }));
  }
  function matchView() {
    for (const id of Object.keys(state.views)) {
      if (state.views[id].interrupt) continue;
      const m = state.views[id].match || {};
      if (m.path && !new RegExp(m.path).test(location.pathname)) continue;
      if (m.selector && !qs(document, m.selector)) continue;
      if (m.absent && qs(document, m.absent)) continue;
      if (m.text && !new RegExp(m.text, "i").test(((document.body && document.body.innerText) || "").slice(0, 8000))) continue;
      return id;
    }
    return null;
  }

  function extract(viewId) {
    const v = state.views[viewId];
    const model = {};
    if (!v) return model;
    for (const ptr of Object.keys(v.model || {})) setPtr(model, ptr, extractNode(v.model[ptr], document));
    return model;
  }

  function snapshot() {
    const view = matchView();
    return { url: location.href, path: location.pathname, view, model: view ? extract(view) : {}, interrupts: interrupts(), ts: Date.now() };
  }

  /** Resolve an extractor pointer (e.g. "/videos" or "/author/name") to its DOM selector chain. */
  function anchorElements(viewId, ptr) {
    const v = state.views[viewId];
    if (!v) return [];
    const parts = ptr.split("/").filter(Boolean);
    // top-level model keys may themselves be multi-segment pointers; find the longest prefix
    let spec = null, rest = [];
    for (let i = parts.length; i > 0; i--) {
      const head = "/" + parts.slice(0, i).join("/");
      if (v.model[head]) { spec = v.model[head]; rest = parts.slice(i); break; }
    }
    if (!spec) return [];
    let roots = [document];
    for (;;) {
      if (spec.each) return roots.flatMap((r) => qsa(r, spec.each)).map((el) => ({ el, spec }));
      if (spec.fields) {
        if (spec.scope) roots = roots.map((r) => qs(r, spec.scope)).filter(Boolean);
        if (!rest.length) return roots.map((el) => ({ el, spec }));
        spec = spec.fields[rest.shift()];
        if (!spec) return [];
        continue;
      }
      return roots.map((r) => (spec.sel ? qs(r, spec.sel) : r)).filter(Boolean).map((el) => ({ el, spec }));
    }
  }

  let hitSeq = 0;
  /**
   * Locate an anchored element. For list anchors, pick the item whose extracted `key` field equals
   * `keyValue` (or the `index`th). Tags it with data-a2flow-hit so any client can address it by selector.
   */
  function locate(viewId, anchor, keyValue, index) {
    let el = null;
    if (anchor.sel) el = qs(document, anchor.sel);
    else {
      const found = anchorElements(viewId, anchor.model);
      if (!found.length) return null;
      const spec = found[0].spec;
      if (spec.each && keyValue != null && spec.key) {
        const hit = found.find(({ el }) => String(extractNode(spec.fields[spec.key], el)) === String(keyValue));
        el = hit && hit.el;
      } else el = found[index || 0] && found[index || 0].el;
      if (el && anchor.sel_within) el = qs(el, anchor.sel_within) || el;
    }
    if (!el) return null;
    const token = "h" + ++hitSeq;
    qsa(document, "[data-a2flow-hit]").forEach((e) => e.removeAttribute("data-a2flow-hit"));
    el.setAttribute("data-a2flow-hit", token);
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    return { selector: `[data-a2flow-hit="${token}"]`, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, visible: visible(el) };
  }

  /** Report snapshots to `bindingName` whenever the projected model changes. */
  function observe(bindingName, quietMs, maxWaitMs) {
    if (state.observer) return;
    let t = null, first = 0;
    const flush = () => {
      t = null; first = 0;
      const snap = snapshot();
      const key = JSON.stringify([snap.url, snap.view, snap.model]);
      if (key === state.lastSent) return;
      state.lastSent = key;
      try { window[bindingName](JSON.stringify(snap)); } catch (e) { /* binding not ready */ }
    };
    const schedule = () => {
      const now = Date.now();
      if (!first) first = now;
      clearTimeout(t);
      t = setTimeout(flush, now - first > maxWaitMs ? 0 : quietMs);
    };
    const start = () => {
      state.observer = new MutationObserver(schedule);
      state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "href", "srcset", "data-e2e", "aria-label"] });
      for (const fn of ["pushState", "replaceState"]) {
        const orig = history[fn];
        history[fn] = function () { const r = orig.apply(this, arguments); schedule(); return r; };
      }
      addEventListener("popstate", schedule);
      schedule();
    };
    if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
  }

  // ---------- multimodal capture (derivation + perception lane) ----------
  const STABLE_ATTRS = ["data-e2e", "data-testid", "data-test", "data-qa", "aria-label", "name", "role", "itemprop"];
  const isRound = (el, r) => {
    const br = getComputedStyle(el).borderRadius || "";
    return /%/.test(br) ? parseFloat(br) >= 50 : parseFloat(br) >= Math.min(r.width, r.height) / 2 - 1;
  };
  const isHashy = (s) => /\d/.test(s) && /[a-z]/i.test(s) && s.length >= 5 && !/^[a-z]+(-[a-z]+)*\d*$/i.test(s);

  function classTokens(el) {
    const out = [];
    for (const c of Array.from(el.classList || [])) {
      // emotion: css-<hash>-SemanticName, or css-<hash>-<deployhash>--SemanticName (tiktok.com, hash rotates per deploy)
      const m = /^css-[a-z0-9]+-(?:[a-z0-9]+-)*-?([A-Za-z][A-Za-z0-9]*)$/.exec(c);
      if (m) out.push(`[class*="-${m[1]}"]`);
      else if (!isHashy(c) && c.length < 40) out.push("." + CSS.escape(c));
    }
    return out;
  }

  function localSelectors(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    if (el.id && !isHashy(el.id) && !/^\d/.test(el.id)) out.push("#" + CSS.escape(el.id));
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 60 && !(a === "aria-label" && /\d{3,}/.test(v))) out.push(`${tag}[${a}="${CSS.escape(v)}"]`);
    }
    for (const c of classTokens(el)) out.push(tag + c);
    return out;
  }

  /** Shortest stable selector unique within `scope` (default document). */
  function stableSelector(el, scope) {
    scope = scope || document;
    const unique = (s) => { const r = qsa(scope, s); return r.length === 1 && r[0] === el; };
    for (const s of localSelectors(el)) if (unique(s)) return s;
    // climb to a stable ancestor and descend
    let chain = [], cur = el;
    for (let depth = 0; cur && cur !== scope && depth < 6; depth++) {
      const parent = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      const own = localSelectors(cur)[0];
      let seg = own || tag;
      if (!own && parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg = `${tag}:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      chain.unshift(seg);
      const sel = chain.join(" > ");
      if (unique(sel) || (scope !== document && unique(":scope " + sel))) return scope !== document && !unique(sel) ? ":scope " + sel : sel;
      cur = parent;
    }
    return chain.join(" > ");
  }

  function signature(el) {
    const tag = el.tagName.toLowerCase();
    const a = STABLE_ATTRS.map((k) => (el.getAttribute(k) && k !== "aria-label" ? `[${k}="${el.getAttribute(k)}"]` : "")).join("");
    return tag + (a || classTokens(el).slice(0, 1).join(""));
  }

  function captureCanvas(el, maxW) {
    if (!el) return null;
    try {
      const w = el.videoWidth || el.width || el.clientWidth, h = el.videoHeight || el.height || el.clientHeight;
      if (!w || !h) return null;
      const scale = Math.min(1, maxW / w);
      const c = document.createElement("canvas");
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.7);
    } catch { return null; } // tainted (cross-origin) canvas
  }

  /** Flat, visible element list with geometry + text + stable selectors: the DOM half of the multimodal capture. */
  function visual(opts) {
    opts = opts || {};
    const max = opts.max || 2500;
    const els = [];
    const idx = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n && els.length < max; n = walker.nextNode()) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(n.tagName)) continue;
      if (!visible(n)) continue;
      const r = n.getBoundingClientRect();
      const ownText = norm(Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "));
      const cs = getComputedStyle(n);
      const rec = {
        i: els.length, tag: n.tagName.toLowerCase(),
        parent: idx.has(n.parentElement) ? idx.get(n.parentElement) : -1,
        rect: [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)],
        text: ownText.slice(0, 200), sig: signature(n),
        attrs: {},
        font: [parseFloat(cs.fontSize), cs.fontWeight],
        round: isRound(n, r),
      };
      for (const a of ["href", "src", "alt", "title", "role", "aria-label", "data-e2e", "type", "placeholder"]) {
        const v = n.getAttribute(a);
        if (v) rec.attrs[a] = v.slice(0, 300);
      }
      if (n.tagName === "IMG") rec.attrs.currentSrc = n.currentSrc || n.src;
      if (opts.selectors) rec.sel = stableSelector(n);
      idx.set(n, rec.i);
      els.push(rec);
    }
    const canvases = opts.canvas === false ? [] : qsa(document, "canvas,video").filter(visible).slice(0, 8).map((c) => {
      const r = c.getBoundingClientRect();
      return { tag: c.tagName.toLowerCase(), sel: stableSelector(c), rect: [r.x, r.y + scrollY, r.width, r.height], dataUrl: captureCanvas(c, 320) };
    });
    return {
      url: location.href, title: document.title,
      viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY], docHeight: document.documentElement.scrollHeight,
      elements: els, canvases,
    };
  }

  /**
   * Repeated-structure detection: containers whose children share a signature (cards, rows, tiles).
   * Returns item selectors plus per-item leaf fields that are consistently present.
   */
  function repeats(minCount) {
    minCount = minCount || 3;
    const out = [];
    for (const parent of qsa(document.body, "*")) {
      const kids = Array.from(parent.children).filter(visible);
      if (kids.length < minCount) continue;
      const groups = {};
      for (const k of kids) (groups[signature(k)] = groups[signature(k)] || []).push(k);
      for (const sig of Object.keys(groups)) {
        const items = groups[sig];
        if (items.length < minCount) continue;
        const area = items.reduce((a, k) => { const r = k.getBoundingClientRect(); return a + r.width * r.height; }, 0) / items.length;
        if (area < 1500) continue;
        const parentSel = stableSelector(parent);
        const ownSel = localSelectors(items[0])[0];
        const itemSel = ownSel && qsa(document, ownSel).length >= items.length ? ownSel : `${parentSel} > ${sig.replace(/^([a-z0-9]+)$/, "$1")}`;
        // leaf fields: text-bearing leaves, images and links, keyed by their relative selector
        const fields = {};
        items.slice(0, 12).forEach((item) => {
          const leaves = [item, ...qsa(item, "*")].filter((e) => visible(e) || e.tagName === "IMG");
          for (const leaf of leaves) {
            const own = norm(Array.from(leaf.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "));
            const kind = leaf.tagName === "IMG" ? "image" : leaf.tagName === "A" ? "link" : own ? "text" : null;
            if (!kind) continue;
            const rel = leaf === item ? "" : stableSelector(leaf, item).replace(/^:scope /, "");
            const key = kind + "|" + rel;
            const f = (fields[key] = fields[key] || { kind, sel: rel, hits: 0, samples: [], font: parseFloat(getComputedStyle(leaf).fontSize) });
            f.hits++;
            const sample = kind === "image" ? (leaf.currentSrc || leaf.src) : kind === "link" ? leaf.getAttribute("href") : own;
            if (f.samples.length < 4) f.samples.push(sample);
          }
        });
        const n = Math.min(items.length, 12);
        const r0 = items[0].getBoundingClientRect();
        out.push({
          parentSel, itemSel, sig, count: items.length, area: Math.round(area),
          rect: [r0.x, r0.y + scrollY, r0.width, r0.height],
          fields: Object.values(fields).filter((f) => f.hits >= Math.ceil(n * 0.8)),
        });
      }
    }
    // drop candidates nested inside a better (larger) candidate's items
    out.sort((a, b) => b.count * b.area - a.count * a.area);
    return out.slice(0, 10);
  }

  /**
   * Salient non-repeated fields: elements with a stable local selector (data-e2e, aria, semantic
   * class) or large-font text, outside page chrome and outside the given list item selectors.
   * Selectors matching 2..12 small elements become multi-valued (`all`) fields (e.g. hashtags).
   */
  function singletons(itemSels) {
    itemSels = itemSels || [];
    const out = [], taken = new Set();
    const inChrome = (el) => !!el.closest("header,nav,footer,form,[role=banner],[role=navigation],[class*=Header],[class*=Nav]");
    const inList = (el) => itemSels.some((s) => { try { return !!el.closest(s); } catch { return false; } });
    for (const el of qsa(document.body, "*")) {
      if (!visible(el) || inChrome(el) || inList(el) || el.closest(".__a2flow_ann")) continue;
      const tag = el.tagName;
      if (["SCRIPT", "STYLE", "SVG", "PATH", "BUTTON", "INPUT"].includes(tag)) continue;
      const text = norm(el.innerText);
      const isImg = tag === "IMG";
      const isCanvas = tag === "CANVAS" || tag === "VIDEO";
      const locals = localSelectors(el);
      const font = parseFloat(getComputedStyle(el).fontSize);
      const ownText = norm(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "));
      const salient = locals.length || (ownText && font >= 20);
      if (!salient || (!isImg && !isCanvas && (!text || text.length > 400))) continue;
      if (!isImg && !isCanvas && qsa(el, "img,canvas").length && !text) continue;
      let sel = null, all = false;
      for (const s of locals) {
        const n = qsa(document, s).length;
        if (n === 1) { sel = s; break; }
        if (n > 1 && n <= 12 && !all) { sel = s; all = true; }
      }
      if (!sel) sel = stableSelector(el);
      if (taken.has(sel)) continue;
      taken.add(sel);
      const r = el.getBoundingClientRect();
      out.push({
        sel, all, tag: tag.toLowerCase(),
        kind: isImg ? "image" : isCanvas ? "canvas" : "text",
        text: all ? qsa(document, sel).map((e) => norm(e.innerText)) : text.slice(0, 200),
        src: isImg ? el.currentSrc || el.src : null,
        href: el.closest("a") ? el.closest("a").getAttribute("href") : null,
        font, round: isRound(el, r),
        rect: [r.x, r.y + scrollY, r.width, r.height],
        attr: el.getAttribute("data-e2e") || el.getAttribute("aria-label") || null,
      });
    }
    // Drop wrappers: text candidates that contain another candidate or a list item (keep the most specific).
    const els = out.map((c) => (c.all ? null : qs(document, c.sel)));
    return out.filter((c, i) => {
      if (c.kind !== "text" || c.all || !els[i]) return true;
      if (itemSels.some((s) => qs(els[i], s))) return false;
      return !els.some((o, j) => j !== i && o && o !== els[i] && els[i].contains(o));
    });
  }

  /** Draw labelled boxes over anchored components (for the annotated screenshot). */
  function annotate(boxes) {
    clearAnnotations();
    for (const b of boxes) {
      const d = document.createElement("div");
      d.className = "__a2flow_ann";
      d.style.cssText = `position:absolute;left:${b.rect[0]}px;top:${b.rect[1]}px;width:${b.rect[2]}px;height:${b.rect[3]}px;outline:2px solid ${b.color || "#e11d48"};z-index:2147483647;pointer-events:none;font:11px monospace;color:#fff`;
      const l = document.createElement("span");
      l.textContent = b.label;
      l.style.cssText = `background:${b.color || "#e11d48"};padding:1px 3px;position:absolute;top:-14px;left:-2px;white-space:nowrap`;
      d.appendChild(l);
      document.body.appendChild(d);
    }
  }
  function clearAnnotations() { qsa(document, ".__a2flow_ann").forEach((e) => e.remove()); }

  /**
   * Studio facet feed: every model pointer of a (possibly partial/draft) view → viewport rects of its
   * visible instances + short extracted values. Lists yield "<ptr>/[*]" item facets and per-item field
   * facets ("<ptr>/[*]/<field>"); net sources yield rect-less facets. Doesn't touch configured state.
   */
  function facets(views, opts) {
    opts = opts || {};
    const margin = opts.margin == null ? 150 : opts.margin, cap = opts.cap || 60;
    const vw = innerWidth, vh = innerHeight;
    const ids = Object.keys(views || {});
    const ok = (m) => { m = m || {};
      try {
        if (m.path && !new RegExp(m.path).test(location.pathname)) return false;
        if (m.selector && !qs(document, m.selector)) return false;
        if (m.absent && qs(document, m.absent)) return false;
        if (m.text && !new RegExp(m.text, "i").test(((document.body && document.body.innerText) || "").slice(0, 8000))) return false;
      } catch { return false; }
      return true; };
    const out = [];
    const short = (v) => { if (v == null) return null; if (typeof v === "object") v = JSON.stringify(v); v = String(v);
      if (/^(https?:|data:)/.test(v)) v = v.startsWith("data:") ? "<data>" : (v.split("?")[0].split("/").pop() || v).slice(0, 40);
      return v.length > 80 ? v.slice(0, 79) + "…" : v; };
    const rectOf = (el) => { if (!el || !el.getBoundingClientRect) return null; const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < -margin || r.top > vh + margin || r.right < 0 || r.left > vw) return null;
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    const facet = (path, kind, parent, depth) => { let f = out.find((x) => x.path === path);
      if (!f) { f = { path, kind, parent, depth, rects: [], values: [] }; out.push(f); } return f; };
    const walk = (spec, root, path, parent, depth, idx) => {
      if (!spec || typeof spec !== "object") return;
      if (spec.net) { facet(path, "net", parent, depth).net = [].concat(spec.net).map((n) => n.url).join(" | "); return; }
      if (spec.each) {
        const list = facet(path, "list", parent, depth);
        const items = qsa(root, spec.each);
        list.count = (list.count || 0) + items.length;
        const ip = path + "/*";
        const itemF = facet(ip, "item", path, depth + 1);
        let n = 0;
        items.forEach((el, i) => {
          const r = rectOf(el);
          if (!r || n >= cap) return; n++;
          itemF.rects.push(r); itemF.values.push(null); (itemF.idx = itemF.idx || []).push(i);
          for (const [k, fs] of Object.entries(spec.fields || {})) walk(fs, el, ip + "/" + k, ip, depth + 2, i);
        });
        if (!n) for (const k of Object.keys(spec.fields || {})) facet(ip + "/" + k, spec.fields[k].each ? "list" : spec.fields[k].fields ? "group" : "field", ip, depth + 2);
        return;
      }
      if (spec.fields) {
        const scope = spec.scope ? qs(root, spec.scope) : null;
        const g = facet(path, "group", parent, depth);
        if (scope) { const r = rectOf(scope); if (r) { g.rects.push(r); g.values.push(null); } }
        for (const [k, fs] of Object.entries(spec.fields)) walk(fs, scope || (spec.scope ? null : root), path + "/" + k, path, depth + 1, idx);
        return;
      }
      const f = facet(path, "field", parent, depth);
      if (!root) return;
      let el = null;
      try { el = spec.sel ? qs(root, spec.sel) : root; } catch {}
      const r = el && rectOf(el);
      if (!r || f.rects.length >= cap) return;
      let v = null; try { v = extractField(spec, root); } catch {}
      f.rects.push(r); f.values.push(short(v)); if (idx != null) (f.idx = f.idx || []).push(idx);
    };
    const usable = ids.filter((id) => !views[id].outcome);
    let view = ids.find((id) => ok(views[id].match)) || null;
    if (!view) { // drafts may not have a match yet: pick the view whose model hits the most elements
      let best = -1;
      for (const id of usable) { out.length = 0;
        for (const [ptr, spec] of Object.entries(views[id].model || {})) walk(spec, document, ptr, null, 0);
        const hits = out.reduce((a, f) => a + f.rects.length, 0);
        if (hits > best) { best = hits; view = id; } }
    }
    out.length = 0;
    if (view) for (const [ptr, spec] of Object.entries(views[view].model || {})) walk(spec, document, ptr, null, 0);
    return { view, url: location.href, viewport: [vw, vh], scroll: [scrollX, scrollY], docHeight: document.documentElement.scrollHeight, facets: out };
  }

  /**
   * Generic interrupt detection (no manifest needed): dialogs / aria-modal / fixed or sticky layers covering a
   * large part of the viewport, plus cookie/consent/login/captcha wording. Returns a stable selector for each
   * and close-button candidates, so the authoring agent can declare an interrupt view.
   */
  function detectOverlays() {
    const vw = innerWidth, vh = innerHeight, out = [];
    const seen = new Set();
    const kindOf = (t) => /captcha|verify you are human|drag the slider|puzzle/i.test(t) ? "captcha"
      : /cookie|consent|gdpr|privacy choices/i.test(t) ? "cookie-banner"
      : /log ?in|sign ?in|sign ?up|continue with/i.test(t) ? "login"
      : /notification|allow|install the app|open app/i.test(t) ? "prompt" : "modal";
    const cands = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]')];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= vw * vh * 0.18 && (parseInt(cs.zIndex) || 0) >= 1) cands.push(el);
    }
    for (const el of cands) {
      if ([...seen].some((s) => s.contains(el) || el.contains(s))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 30 || !visible(el)) continue;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!text && !el.querySelector("iframe")) continue;
      seen.add(el);
      const closers = [...el.querySelectorAll('button,[role="button"],a')].filter((b) => {
        const l = ((b.getAttribute("aria-label") || "") + " " + (b.innerText || "") + " " + (b.getAttribute("data-e2e") || "")).toLowerCase();
        return /close|dismiss|not now|no thanks|reject|decline|accept|got it|later|skip|✕|×|^x$/.test(l.trim()) && visible(b);
      }).slice(0, 3).map((b) => ({ selector: stableSelector(b), label: ((b.getAttribute("aria-label") || b.innerText || "").trim()).slice(0, 40) }));
      out.push({ kind: kindOf(text), selector: stableSelector(el), text, coverage: Math.round((Math.min(r.width, vw) * Math.min(r.height, vh)) / (vw * vh) * 100), closers });
    }
    return out.slice(0, 4);
  }

  function configure(views) { state.views = views || {}; state.lastSent = null; }

  window.__a2flow = {
    __v: 1, configure, matchView, interrupts, detectOverlays, extract, snapshot, locate, observe,
    visual, repeats, singletons, stableSelector: (sel) => stableSelector(qs(document, sel)), annotate, clearAnnotations, facets,
    settled: () => document.readyState === "complete",
  };
})();
