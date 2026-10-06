/**
 * Source text of the in-page runtime (./runtime.js). Node reads it from disk; the in-browser actor build
 * (scripts/build-actor.mjs) replaces this module with the file's contents inlined as a string.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INPAGE_RUNTIME: string = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "runtime.js"), "utf8");
