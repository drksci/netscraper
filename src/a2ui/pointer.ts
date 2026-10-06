/** RFC 6901 JSON Pointer helpers plus A2UI relative-path scoping and a minimal structural diff. */

export function parsePointer(p: string): string[] {
  if (p === "" || p === "/") return [];
  if (!p.startsWith("/")) throw new Error(`not an absolute JSON pointer: ${p}`);
  return p.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function joinPointer(parts: (string | number)[]): string {
  return parts.length ? "/" + parts.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "/";
}

/** Resolve a (possibly relative) A2UI path against a scope pointer. */
export function resolvePath(path: string, scope = "/"): string {
  if (path.startsWith("/")) return path;
  const base = scope === "/" ? "" : scope;
  return `${base}/${path}`;
}

export function getAt(root: unknown, pointer: string): unknown {
  let cur: any = root;
  for (const k of parsePointer(pointer)) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Upsert semantics per A2UI updateDataModel; `undefined` removes the key. Returns the new root. */
export function setAt(root: unknown, pointer: string, value: unknown): unknown {
  const parts = parsePointer(pointer);
  if (!parts.length) return value === undefined ? {} : structuredClone(value);
  const out: any = root && typeof root === "object" ? root : {};
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur[Number(last)] = undefined;
    else delete cur[last];
  } else cur[last] = structuredClone(value);
  return out;
}

export interface Patch { path: string; value: unknown }

/**
 * Minimal patch list turning `a` into `b`. Arrays that only grew emit one patch per appended
 * item (the infinite-scroll case streams as appends); any other array change replaces the array.
 */
export function diff(a: unknown, b: unknown, path: (string | number)[] = []): Patch[] {
  if (deepEqual(a, b)) return [];
  const p = joinPointer(path);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (b.length > a.length && a.every((x, i) => deepEqual(x, b[i]))) {
      return b.slice(a.length).map((v, i) => ({ path: joinPointer([...path, a.length + i]), value: v }));
    }
    if (a.length === b.length && a.length > 0) {
      return a.flatMap((x, i) => diff(x, b[i], [...path, i]));
    }
    return [{ path: p, value: b }];
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: Patch[] = [];
    for (const k of keys) out.push(...diff(a[k], b[k], [...path, k]));
    return out;
  }
  return [{ path: p, value: b }];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}
