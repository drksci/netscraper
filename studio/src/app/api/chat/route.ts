import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const MCP_URL = process.env.A2FLOW_MCP_URL ?? "http://127.0.0.1:7801/mcp";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// chatId -> claude CLI session_id (module-level; survives HMR via globalThis)
const g = globalThis as unknown as { __claudeSessions?: Map<string, string> };
const sessions = (g.__claudeSessions ??= new Map<string, string>());

type Json = Record<string, any>;

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
  }
  return "";
}

function resultText(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.filter((c) => c?.type === "text").map((c) => c.text);
    if (texts.length === content.length) {
      const joined = texts.join("\n");
      try { return JSON.parse(joined); } catch { return joined; }
    }
  }
  return content;
}

export async function POST(req: Request) {
  const body = (await req.json()) as { id?: string; messages: UIMessage[]; system?: string };
  const chatId = body.id ?? "default";
  const prompt = lastUserText(body.messages);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const send = (c: UIMessageChunk) => writer.write(c);
      if (!prompt) { send({ type: "error", errorText: "Empty prompt" }); return; }

      const args = [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--mcp-config", JSON.stringify({ mcpServers: { a2flow: { type: "http", url: MCP_URL } } }),
        "--strict-mcp-config",
        "--allowedTools", "mcp__a2flow__*",
        // the agent acts only through the a2flow tools: no built-ins (Bash, Read, …)
        "--tools", "",
        "--effort", process.env.A2FLOW_EFFORT ?? "medium",
      ];
      if (process.env.A2FLOW_MODEL) args.push("--model", process.env.A2FLOW_MODEL);
      if (body.system?.trim()) args.push("--system-prompt", body.system);
      const resume = sessions.get(chatId);
      if (resume) args.push("--resume", resume);

      const child = spawn(/*turbopackIgnore: true*/ CLAUDE_BIN, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ENABLE_TOOL_SEARCH: "false", MCP_TOOL_TIMEOUT: "600000" } }); // research/run tools take minutes
      const kill = () => { if (!child.killed) child.kill("SIGTERM"); };
      req.signal.addEventListener("abort", kill);

      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      // per-block state
      const blocks = new Map<number, { kind: "text" | "reasoning" | "tool"; id: string }>();
      const startedTools = new Set<string>();
      const toolInputs = new Set<string>(); // tools with input-available sent
      let streamedAny = false;
      let sawError: string | null = null;

      const onEvent = (ev: Json) => {
        if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
          sessions.set(chatId, ev.session_id);
        } else if (ev.type === "stream_event") {
          const e = ev.event as Json;
          if (e.type === "message_start") { blocks.clear(); }
          else if (e.type === "content_block_start") {
            const cb = e.content_block as Json;
            const id = `${ev.uuid}-${e.index}`;
            if (cb.type === "text") { blocks.set(e.index, { kind: "text", id }); send({ type: "text-start", id }); streamedAny = true; }
            else if (cb.type === "thinking") { blocks.set(e.index, { kind: "reasoning", id }); send({ type: "reasoning-start", id }); streamedAny = true; }
            else if (cb.type === "tool_use") {
              blocks.set(e.index, { kind: "tool", id: cb.id });
              startedTools.add(cb.id);
              send({ type: "tool-input-start", toolCallId: cb.id, toolName: cb.name, dynamic: true });
            }
          } else if (e.type === "content_block_delta") {
            const b = blocks.get(e.index); const d = e.delta as Json;
            if (!b) return;
            if (d.type === "text_delta") send({ type: "text-delta", id: b.id, delta: d.text });
            else if (d.type === "thinking_delta") send({ type: "reasoning-delta", id: b.id, delta: d.thinking });
            else if (d.type === "input_json_delta" && d.partial_json) send({ type: "tool-input-delta", toolCallId: b.id, inputTextDelta: d.partial_json });
          } else if (e.type === "content_block_stop") {
            const b = blocks.get(e.index);
            if (b?.kind === "text") send({ type: "text-end", id: b.id });
            else if (b?.kind === "reasoning") send({ type: "reasoning-end", id: b.id });
            blocks.delete(e.index);
          }
        } else if (ev.type === "assistant") {
          // Complete message: finalises tool inputs (and covers text if partial events were not emitted).
          const content = (ev.message?.content ?? []) as Json[];
          for (const c of content) {
            if (c.type === "tool_use" && !toolInputs.has(c.id)) {
              toolInputs.add(c.id);
              if (!startedTools.has(c.id)) { startedTools.add(c.id); send({ type: "tool-input-start", toolCallId: c.id, toolName: c.name, dynamic: true }); }
              send({ type: "tool-input-available", toolCallId: c.id, toolName: c.name, input: c.input ?? {}, dynamic: true });
            } else if (!streamedAny && c.type === "text" && c.text) {
              const id = `${ev.uuid ?? Math.random()}-t`;
              send({ type: "text-start", id }); send({ type: "text-delta", id, delta: c.text }); send({ type: "text-end", id });
            } else if (!streamedAny && c.type === "thinking" && c.thinking) {
              const id = `${ev.uuid ?? Math.random()}-r`;
              send({ type: "reasoning-start", id }); send({ type: "reasoning-delta", id, delta: c.thinking }); send({ type: "reasoning-end", id });
            }
          }
        } else if (ev.type === "user") {
          const content = ev.message?.content;
          if (Array.isArray(content)) for (const c of content as Json[]) {
            if (c.type !== "tool_result") continue;
            if (c.is_error) {
              const r = resultText(c.content);
              send({ type: "tool-output-error", toolCallId: c.tool_use_id, errorText: typeof r === "string" ? r : JSON.stringify(r), dynamic: true });
            }
            else send({ type: "tool-output-available", toolCallId: c.tool_use_id, output: resultText(c.content), dynamic: true });
          }
        } else if (ev.type === "result") {
          if (ev.session_id) sessions.set(chatId, ev.session_id);
          if (ev.is_error) sawError = String(ev.result ?? ev.subtype ?? "claude error");
        }
      };

      await new Promise<void>((resolve) => {
        let buf = "";
        child.stdout.on("data", (d) => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            try { onEvent(JSON.parse(line)); } catch { /* ignore non-JSON line */ }
          }
        });
        child.on("error", (err) => { sawError = `Failed to start claude CLI: ${err.message}`; resolve(); });
        child.on("close", (code) => {
          if (code && !sawError && !req.signal.aborted) sawError = `claude exited with code ${code}${stderr ? `: ${stderr.trim().slice(-800)}` : ""}`;
          resolve();
        });
      });
      req.signal.removeEventListener("abort", kill);
      if (sawError) send({ type: "error", errorText: sawError });
    },
    onError: (e) => (e instanceof Error ? e.message : String(e)),
  });

  return createUIMessageStreamResponse({ stream });
}
