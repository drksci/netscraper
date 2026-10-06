/**
 * Fault tolerance for every page-touching operation (navigate / await / act / input):
 * timeouts, error classification, retries with exponential backoff + jitter, per-class recovery,
 * overlay dismissal, rate limiting and block detection. Declared in the manifest's `policies`.
 */
export interface Policies {
  /** Per-operation timeout (ms). */
  timeouts?: Partial<Record<OpKind, number>>;
  /** Attempts per operation (1 = no retry) and backoff schedule. */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number; jitter?: number };
  /** Minimum spacing between page operations, with random jitter (politeness / anti-burst). */
  rateLimit?: { minDelayMs?: number; jitterMs?: number };
  /** Overlays (login prompts, cookie banners) to close before each operation if visible. Prefer "decline" buttons. */
  dismiss?: { sel: string; intent: string }[];
  /** Signals that we're blocked (captcha/interstitial). `pause` waits for a `resume` A2UI action; `fail` fails the unit. */
  blocked?: { selectors?: string[]; textPatterns?: string[]; action?: "pause" | "fail" };
  /** HTTP statuses on navigation treated as transient (retry) vs fatal for the unit. */
  http?: { retry?: number[]; fatal?: number[] };
}
export type OpKind = "navigate" | "await" | "action" | "input";
export type ErrorClass = "timeout" | "network" | "crash" | "missing" | "blocked" | "http-fatal" | "unexpected" | "drift" | "unknown";

export const DEFAULT_POLICIES: Required<Pick<Policies, "timeouts" | "retry" | "rateLimit" | "http">> = {
  timeouts: { navigate: 45_000, await: 30_000, action: 20_000, input: 10_000 },
  retry: { attempts: 3, baseMs: 1000, maxMs: 15_000, jitter: 0.3 },
  rateLimit: { minDelayMs: 0, jitterMs: 0 },
  http: { retry: [408, 425, 429, 500, 502, 503, 504], fatal: [401, 403, 404, 410] },
};

export class OpError extends Error {
  constructor(readonly cls: ErrorClass, message: string, readonly status?: number) { super(message); }
}

export function classify(e: unknown): ErrorClass {
  if (e instanceof OpError) return e.cls;
  const m = String((e as Error)?.message ?? e);
  if (/timed? ?out|Timeout \d+ms exceeded|TimeoutError/i.test(m)) return "timeout";
  if (/Target (page, context or browser )?(has been )?closed|crash|Session closed|Browser has been closed|Protocol error|WebSocket is not open|Execution context was destroyed|Connection closed/i.test(m)) return "crash";
  if (/net::ERR_|NS_ERROR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(m)) return "network";
  if (/not found|not rendered|no element|not visible|detached|intercepts pointer events|not on page|no active/i.test(m)) return "missing";
  return "unknown";
}

export function backoff(attempt: number, p: Policies["retry"] = {}): number {
  const base = p.baseMs ?? 1000, max = p.maxMs ?? 15_000, jitter = p.jitter ?? 0.3;
  const d = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(d * (1 - jitter + Math.random() * jitter * 2));
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new OpError("timeout", `${what} timed out after ${ms}ms`)), ms); }),
  ]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
