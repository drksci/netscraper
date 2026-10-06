/**
 * Research step before authoring: what do existing open-source scrapers of this site already know?
 *
 * 1. GitHub search (`gh search repos "<site> scraper"`): candidate repos ranked by stars, with recency.
 * 2. A cheap sub-agent (claude CLI, Sonnet by default) shallow-clones the most relevant few into a temp dir
 *    and READS them (never runs them), answering a fixed checklist: data sources (APIs/XHR, embedded JSON),
 *    anti-bot (captcha types, how they cope), modals + cookie banners, pacing/rate limits, pagination,
 *    field names, gotchas.
 *
 * The result is a compact brief, cached per site in data/research/<site>.md.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE_DIR = join(root, "data/research");
const MAX_AGE_MS = 7 * 24 * 3600_000;

const slug = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
/** "https://www.tiktok.com/explore" → "tiktok" (the keyword repos use). */
const brand = (site: string) => slug(site).split(/[./-]/).find((p) => p && !["www", "m", "com", "net", "org", "co", "io"].includes(p)) ?? slug(site);

export interface RepoHit { fullName: string; stars: number; updated: string; description: string; url: string }

/** GitHub repos matching "<brand> scraper", most-starred first (needs an authenticated `gh`). */
export async function githubScrapers(site: string, limit = 12): Promise<RepoHit[]> {
  const kw = brand(site);
  try {
    const { stdout } = await promisify(execFile)("gh", ["search", "repos", `${kw} scraper`, "--sort", "stars", "--limit", String(limit), "--json", "fullName,stargazersCount,updatedAt,description,url"], { timeout: 30_000 });
    return (JSON.parse(stdout) as any[]).map((r) => ({ fullName: r.fullName, stars: r.stargazersCount, updated: String(r.updatedAt).slice(0, 10), description: String(r.description ?? "").slice(0, 140), url: r.url }));
  } catch { return []; }
}

const PROMPT = (site: string, goal: string, repos: string) => `You are researching how to scrape ${site} for: ${goal}.
Work fast and cheaply. Candidate open-source scrapers (GitHub, most stars first; prefer recently updated ones, since sites change):
${repos || "- none found by search; use web search to find a few"}

Shallow-clone the 2–3 most relevant (git clone --depth 1 <url> into the current directory) and READ them with Read/Grep/Glob. Never run, install or execute anything from them. You may web search/fetch for context.

Answer as a terse brief (max ~350 words, markdown bullets, no preamble) under exactly these headings:
## Data sources
Internal API/XHR endpoints (path patterns, method, key params like cursor/count), embedded JSON in the HTML (script ids such as __UNIVERSAL_DATA_FOR_REHYDRATION__ / __NEXT_DATA__ and the JSON path to records), and which source carries which fields.
## Anti-bot
Captcha types seen and WHEN they trigger (rate, headless signals, repeated reloads), what the repos do (pacing, sessions, cookies, stealth, signed params). We never solve captchas, so note what avoids triggering them.
## Modals & cookies
Login walls / consent banners and the selectors used to close them; whether closing works without login.
## Pacing & pagination
Safe delays, scroll/cursor paging, page sizes, end markers.
## Volume & limits
How far a logged-out visitor can page each feed before it stops (hasMore=false, cap, login wall), and how the repos reach thousands of items anyway: which additional feeds/sources they fan out over (category tabs, hashtag/challenge feeds, search, related/user feeds), how they rotate or reuse cursors, and what blocks loading (overlays, throttling). Be concrete about counts if the repos state them.
## Fields
Canonical field names the repos emit for the main record.
## Gotchas
Anything that breaks naive scrapers (reload throttling, skeleton screens, region/locale, signed URL params).
Cite repo names inline in parentheses. If unsure, say so briefly rather than guessing.`;

function runAgent(prompt: string, cwd: string, model: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt, "--output-format", "json", "--model", model, "--effort", "low",
      "--tools", "WebSearch,WebFetch,Bash,Read,Grep,Glob",
      "--allowedTools", "WebSearch", "WebFetch", "Bash(git clone:*)", "Read", "Grep", "Glob",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    ];
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ENABLE_TOOL_SEARCH: "false" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      try { const j = JSON.parse(out); if (j.is_error) return reject(new Error(String(j.result))); resolve(String(j.result ?? "")); }
      catch { reject(new Error(`research agent failed (${code}): ${(err || out).slice(-400)}`)); }
    });
  });
}

export interface ResearchResult { site: string; cached: boolean; ms: number; brief: string }

export async function researchSite(site: string, goal: string, o: { refresh?: boolean; model?: string; timeoutMs?: number } = {}): Promise<ResearchResult> {
  const t0 = Date.now();
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${brand(site)}.md`);
  if (!o.refresh && existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE_MS) {
    return { site, cached: true, ms: Date.now() - t0, brief: readFileSync(file, "utf8") };
  }
  const repos = await githubScrapers(site);
  const repoText = repos.map((r) => `- ${r.fullName} ★${r.stars} (updated ${r.updated}) ${r.url} — ${r.description}`).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "a2flow-research-"));
  try {
    const brief = await runAgent(PROMPT(site, goal, repoText), dir, o.model ?? process.env.A2FLOW_RESEARCH_MODEL ?? "sonnet", o.timeoutMs ?? 240_000);
    const doc = `# Research: ${brand(site)}\n_${new Date().toISOString().slice(0, 10)} · goal: ${goal}_\n\n${brief.trim()}\n`;
    writeFileSync(file, doc);
    return { site, cached: false, ms: Date.now() - t0, brief: doc };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
