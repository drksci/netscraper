"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { applyPatch, isStreaming, type Authoring, type DocKind } from "@/lib/authoring";
import { componentFacets } from "@/lib/component-facets";
import { hoverId, norm, useHover } from "@/lib/facet-hover";
import { colorOfPath, colorOfSchema, facetKey, facetOfManifestPath, listPointers, schemaKey } from "@/lib/facets";
import { useSession } from "@/lib/session-store";
import { useBrowserView } from "@/lib/playback";
import { MachineView } from "./machine-view";
import { A2UILog } from "./a2ui-log";
import { FacetJson, type FacetInfo, type FacetResolver } from "./facet-json";
import { Segmented } from "./segmented";
import { Retro } from "./retro";
import { cn } from "@/lib/utils";

type Tab = DocKind | "machine" | "a2ui";
const TABS: { id: Tab; label: string }[] = [
  { id: "schema", label: "Schema" },
  { id: "expected", label: "Expected" },
  { id: "manifest", label: "Manifest" },
  { id: "machine", label: "Machine" },
  { id: "a2ui", label: "A2UI" },
];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const schemaInfo = (route: string, field?: string): FacetInfo => ({ color: colorOfSchema(route, field), key: schemaKey(route, field) });
const pathInfo = (path: string): FacetInfo => ({ color: colorOfPath(path), key: facetKey(path) });

function schemaResolver(): FacetResolver {
  return (keys, value) => {
    if (keys[0] !== "outputs") return null;
    if (keys.length === 2) return schemaInfo(String(keys[1]));
    if (keys.length === 4 && keys[2] === "fields" && isObj(value) && typeof value.name === "string") return schemaInfo(String(keys[1]), value.name);
    return null;
  };
}

function expectedResolver(doc: unknown): FacetResolver {
  const routeOf = (i: unknown) => { const r = Array.isArray(doc) ? doc[Number(i)]?.route : null; return typeof r === "string" ? r : null; };
  return (keys) => {
    const route = routeOf(keys[0]);
    if (!route) return null;
    if (keys.length === 1) return schemaInfo(route);
    if (keys.length === 3 && keys[1] === "record") return schemaInfo(route, String(keys[2]));
    return null;
  };
}

function manifestResolver(doc: any): FacetResolver {
  const views = isObj(doc?.views) ? doc.views : {};
  const lists = new Map<string, Set<string>>();
  const listsOf = (v: string) => { let s = lists.get(v); if (!s) { s = listPointers(views[v]?.model); lists.set(v, s); } return s; };
  const comps = new Map<string, (string | null)[]>();
  const compsOf = (v: string) => { let s = comps.get(v); if (!s) { s = componentFacets(views[v]?.components).map((c) => c.path); comps.set(v, s); } return s; };

  return (keys, value) => {
    if (keys[0] === "views" && typeof keys[1] === "string") {
      const v = keys[1];
      if (keys[2] === "model") {
        const path = facetOfManifestPath(keys, listsOf(v));
        if (!path) return null;
        if (keys.length > 4 && facetOfManifestPath(keys.slice(0, -1), listsOf(v)) === path) return null;
        return { ...pathInfo(path), pill: isObj(value) && value.net ? "net" : undefined };
      }
      if (keys[2] === "components" && keys.length === 4) {
        const p = compsOf(v)[Number(keys[3])];
        return p ? pathInfo(p) : null;
      }
      if (keys[2] === "anchors" && keys.length === 4) {
        const ptr = typeof value === "string" ? value : isObj(value) ? Object.values(value).find((x) => typeof x === "string" && x.startsWith("/")) : null;
        return typeof ptr === "string" && ptr.startsWith("/") ? pathInfo(ptr) : null;
      }
    }
    if (keys[0] === "routes" && keys.length === 2) {
      const name = isObj(value) ? (value.name ?? value.id ?? value.route) : null;
      return schemaInfo(typeof name === "string" ? name : String(keys[1]));
    }
    return null;
  };
}

/** Code half of the stage: Schema · Expected · Manifest · Machine, facet-linked, following the stream. */
export function CodePane({ authoring, className, headerEnd }: { authoring: Authoring; className?: string; headerEnd?: React.ReactNode }) {
  const schema = useSession((s) => s.schema);
  const expected = useSession((s) => s.expected);
  const manifest = useSession((s) => s.manifest);
  const [tab, setTab] = useState<Tab>("schema");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { active } = authoring;

  // follow whichever document is streaming; otherwise land on the most advanced one that exists
  useEffect(() => { if (active) setTab(active); }, [active]);
  const hasAny = { schema: !!(schema || authoring.schema), expected: expected.length > 0 || !!authoring.expected, manifest: !!(manifest?.doc || authoring.manifest) };
  useEffect(() => {
    setTab((t) => (t === "machine" || t === "a2ui" || hasAny[t] ? t : hasAny.manifest ? "manifest" : hasAny.expected ? "expected" : "schema"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAny.schema, hasAny.expected, hasAny.manifest]);

  const m = authoring.manifest;
  const streamingManifest = isStreaming(m);
  const isPatch = !!m?.toolName.endsWith("patch_manifest");

  // the manifest as it stands: streamed write, a streamed patch merged into the written doc, else the written doc
  const manifestDoc = useMemo(() => {
    if (streamingManifest) return isPatch ? applyPatch(manifest?.doc, m?.input?.patch) : m?.input?.manifest;
    return manifest?.doc ?? m?.input?.manifest;
  }, [streamingManifest, isPatch, m, manifest?.doc]);
  const machine = isObj(manifestDoc) ? manifestDoc.machine : undefined;

  // while write_manifest streams and `machine` is the key being written, follow it
  const writingMachine = streamingManifest && !isPatch && isObj(m?.input?.manifest) && Object.keys(m.input.manifest).at(-1) === "machine";
  useEffect(() => { if (writingMachine) setTab("machine"); }, [writingMachine]);

  const doc = useMemo(() => {
    if (tab === "machine" || tab === "a2ui") return undefined;
    if (tab === "schema") return isStreaming(authoring.schema) ? authoring.schema?.input : (schema ?? authoring.schema?.input);
    if (tab === "expected") return isStreaming(authoring.expected) ? authoring.expected?.input?.records : expected.length ? expected : authoring.expected?.input?.records;
    return manifestDoc;
  }, [tab, authoring.schema, authoring.expected, schema, expected, manifestDoc]);
  const deferred = useDeferredValue(doc);

  // focus mode: only what's linked to the page right now stays unfolded
  const [focus, setFocus] = useState<"linked" | "all">("linked");
  const snap = useBrowserView().snap;
  // keyed on the set's content so playback ticks that don't change what's on screen don't re-render the code
  const onScreenKey = useMemo(() => {
    if (!snap) return null;
    const ids = new Set<string>();
    for (const f of snap.facets) {
      if (!f.rects.length) continue;
      const k = facetKey(f.path);
      ids.add(hoverId(k));
      ids.add(hoverId({ family: k.family, leaf: null }));
    }
    return [...ids].sort().join("\n");
  }, [snap]);
  const onScreen = useMemo(() => (onScreenKey === null ? null : new Set(onScreenKey ? onScreenKey.split("\n") : [])), [onScreenKey]);
  const resolve = useMemo<FacetResolver>(() => {
    if (tab === "schema") return schemaResolver();
    if (tab === "expected") return expectedResolver(deferred);
    return manifestResolver(deferred);
  }, [tab, deferred]);

  const streaming = active === tab;
  useEffect(() => {
    const el = scroller.current;
    if (el && streaming && stick.current) el.scrollTop = el.scrollHeight;
  }, [deferred, streaming]);

  // hovering a facet on the page scrolls its block into view
  const { key, source } = useHover();
  useEffect(() => {
    const el = scroller.current;
    if (!el || !key || source !== "page") return;
    const target = el.querySelector(`[data-facet="${hoverId(key)}"]`) ?? el.querySelector(`[data-facet^="${norm(key.family)}|"]`);
    target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [key, source]);

  const tabs = TABS.map((t) => ({ ...t, live: active === t.id || (t.id === "machine" && writingMachine) }));

  return (
    <div className={cn("flex size-full min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <Segmented label="Document" value={tab} onChange={setTab} items={tabs} />
        <div className="flex-1" />
        {tab !== "machine" && tab !== "schema" && tab !== "a2ui" && (
          <Segmented
            label="Focus"
            value={focus}
            onChange={setFocus}
            items={[{ id: "linked", label: "Linked", hint: "Fold what isn't on the page" }, { id: "all", label: "All", hint: "Show everything" }]}
          />
        )}
        {headerEnd}
      </div>
      <div className="relative min-h-0 flex-1">
        {tab === "machine" ? (
          <MachineView machine={machine} />
        ) : tab === "a2ui" ? (
          <A2UILog />
        ) : (
          <div
            ref={scroller}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
            className="size-full overflow-auto px-5 py-3"
          >
            {deferred === undefined || deferred === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-2.5 text-xs text-muted-foreground">
                <Retro name={tab === "schema" ? "schema" : tab === "expected" ? "expected" : "manifest"} size={32} />
                Nothing written yet
              </div>
            ) : (
              <FacetJson value={deferred} resolve={resolve} streaming={streaming} focus={focus === "linked" && tab !== "schema"} onScreen={tab === "manifest" ? onScreen : null} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
