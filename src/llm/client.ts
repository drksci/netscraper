/**
 * Multimodal LLM client for the authoring loop, with a content-addressed cache: identical
 * (model, system, prompt, images) → identical answer from disk, so re-running an authoring
 * session (or a replay of one) costs nothing for steps that didn't change.
 *
 *   backend "sdk": @anthropic-ai/sdk (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN), Claude Opus 5.5 by default
 *   backend "cli": the local `claude` CLI (headless `-p`), images passed as files it may Read
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export interface LlmImage { data: Buffer; mediaType: "image/png" | "image/jpeg"; label?: string }
export interface LlmRequest {
  system: string;
  prompt: string;
  images?: LlmImage[];
  /** Tag for logs/cost accounting (e.g. "explore", "synthesize", "refine"). */
  purpose?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}
export interface LlmResponse { text: string; json?: any; cached: boolean; costUsd?: number; ms: number; key: string }

export const DEFAULT_MODEL = "claude-opus-5-5";

export class LlmClient {
  readonly calls: { purpose?: string; cached: boolean; ms: number; costUsd?: number }[] = [];
  constructor(private opts: { backend?: "sdk" | "cli"; cacheDir?: string; model?: string; log?: (s: string) => void } = {}) {
    mkdirSync(this.cacheDir, { recursive: true });
  }
  get cacheDir() { return this.opts.cacheDir ?? ".a2flow-cache/llm"; }
  get backend(): "sdk" | "cli" { return this.opts.backend ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "sdk" : "cli"); }

  key(req: LlmRequest): string {
    const h = createHash("sha256");
    h.update(JSON.stringify([req.model ?? this.opts.model ?? DEFAULT_MODEL, req.effort ?? "", req.system, req.prompt]));
    for (const im of req.images ?? []) h.update(createHash("sha256").update(im.data).digest());
    return h.digest("hex").slice(0, 32);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = this.key(req);
    const file = join(this.cacheDir, `${key}.json`);
    const t0 = Date.now();
    if (existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, "utf8"));
      this.calls.push({ purpose: req.purpose, cached: true, ms: 0 });
      return { ...hit, cached: true, ms: 0, key };
    }
    this.opts.log?.(`llm ${req.purpose ?? ""} (${this.backend}) …`);
    const { text, costUsd } = this.backend === "sdk" ? await this.viaSdk(req) : await this.viaCli(req);
    const out = { text, json: parseJson(text), costUsd };
    writeFileSync(file, JSON.stringify({ ...out, purpose: req.purpose, at: new Date().toISOString() }, null, 1));
    const ms = Date.now() - t0;
    this.calls.push({ purpose: req.purpose, cached: false, ms, costUsd });
    this.opts.log?.(`llm ${req.purpose ?? ""} done in ${(ms / 1000).toFixed(1)}s${costUsd ? ` ($${costUsd.toFixed(3)})` : ""}`);
    return { ...out, cached: false, ms, key };
  }

  private async viaSdk(req: LlmRequest): Promise<{ text: string; costUsd?: number }> {
    const client = new Anthropic();
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(req.images ?? []).flatMap((im): Anthropic.Beta.BetaContentBlockParam[] => [
        ...(im.label ? [{ type: "text" as const, text: im.label }] : []),
        { type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data.toString("base64") } },
      ]),
      { type: "text", text: req.prompt },
    ];
    const msg = await client.beta.messages.stream({
      model: req.model ?? this.opts.model ?? DEFAULT_MODEL,
      max_tokens: 32000,
      system: req.system,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: req.effort ?? "high" },
      messages: [{ role: "user", content }],
    } as any).finalMessage();
    if (msg.stop_reason === "refusal") throw new Error(`LLM declined (${req.purpose})`);
    return { text: msg.content.map((b) => (b.type === "text" ? b.text : "")).join("") };
  }

  private viaCli(req: LlmRequest): Promise<{ text: string; costUsd?: number }> {
    const dir = join(tmpdir(), "a2flow-llm");
    mkdirSync(dir, { recursive: true });
    const files = (req.images ?? []).map((im, i) => {
      const f = join(dir, `${this.key(req)}-${i}.${im.mediaType === "image/png" ? "png" : "jpg"}`);
      writeFileSync(f, im.data);
      return { f, label: im.label };
    });
    const prompt = (files.length ? `First Read these images:\n${files.map((x) => `- ${x.f}${x.label ? ` (${x.label})` : ""}`).join("\n")}\n\n` : "") + req.prompt;
    const args = ["-p", prompt, "--output-format", "json", "--system-prompt", req.system, "--no-session-persistence",
      ...(files.length ? ["--tools", "Read", "--allowedTools", "Read"] : ["--tools", ""]),
      ...(req.model || this.opts.model ? ["--model", req.model ?? this.opts.model!] : []),
      ...(req.effort ? ["--effort", req.effort] : [])];
    return new Promise((res, rej) => {
      const p = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => { p.kill(); rej(new Error(`claude CLI timed out (${req.purpose})`)); }, 600_000);
      p.on("close", (code) => {
        clearTimeout(t);
        try {
          const r = JSON.parse(out);
          if (r.is_error || code !== 0) return rej(new Error(`claude CLI error: ${r.result ?? err}`.slice(0, 500)));
          res({ text: String(r.result ?? ""), costUsd: r.total_cost_usd });
        } catch { rej(new Error(`claude CLI output unparsable (exit ${code}): ${(err || out).slice(0, 400)}`)); }
      });
    });
  }

  summary() {
    const live = this.calls.filter((c) => !c.cached);
    return { calls: this.calls.length, cached: this.calls.length - live.length, seconds: +(live.reduce((a, c) => a + c.ms, 0) / 1000).toFixed(1),
      costUsd: +live.reduce((a, c) => a + (c.costUsd ?? 0), 0).toFixed(3) };
  }
}

/** First JSON object/array in a reply (tolerates prose or ```json fences). */
export function parseJson(text: string): any {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const src = fence ? fence[1] : text;
  const start = src.search(/[[{]/);
  if (start < 0) return undefined;
  for (let end = src.length; end > start; end--) {
    const ch = src[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(src.slice(start, end)); } catch { /* shrink */ }
  }
  return undefined;
}
