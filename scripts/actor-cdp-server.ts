/**
 * Standalone /actor/cdp proxy (no Studio session) — for tests and for running the in-browser actor without
 * the full session server:  npx tsx scripts/actor-cdp-server.ts [port=7811]
 */
import { createServer } from "node:http";
import { attachActorCdpProxy } from "../src/studio/actor-cdp.js";

const port = Number(process.argv[2] ?? 7811);
const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
const proxy = attachActorCdpProxy(server, { maxRuntimeMs: Number(process.env.ACTOR_MAX_MS ?? 15 * 60_000) });
server.listen(port, "127.0.0.1", () => console.log(`actor CDP proxy on ws://127.0.0.1:${port}/actor/cdp`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await proxy.closeAll(); process.exit(0); });
