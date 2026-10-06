/**
 * Unit-of-work ledger (a request-queue in the Crawlee sense, but for *machine-defined* units).
 * Append-only JSONL event log: the last record per unit id wins, so a crash mid-write loses at most
 * one event and a rerun over the same directory resumes — completed units are skipped (idempotent).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type UnitStatus = "running" | "done" | "failed" | "skipped";
export interface Unit {
  id: string; type: string; key: string; parent?: string;
  status: UnitStatus; attempts: number; error?: string;
  startedAt?: string; finishedAt?: string; run: string;
}

export class Ledger {
  readonly units = new Map<string, Unit>();
  private file?: string;
  readonly run = new Date().toISOString();

  constructor(dir?: string) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "ledger.jsonl");
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const u = JSON.parse(line) as Unit; this.units.set(u.id, u); } catch { /* torn last line */ }
      }
      // anything left "running" by a crashed run is retried
      for (const u of this.units.values()) if (u.status === "running") u.status = "failed", u.error ??= "interrupted";
    }
  }

  static id(type: string, key: string) { return `${type}:${key}`; }

  private write(u: Unit) {
    this.units.set(u.id, u);
    if (this.file) appendFileSync(this.file, JSON.stringify(u) + "\n");
  }

  /** Completed = done, or skipped because of a definitive outcome (not found, private, unavailable). */
  isDone(type: string, key: string) { const s = this.units.get(Ledger.id(type, key))?.status; return s === "done" || s === "skipped"; }

  start(type: string, key: string, parent?: string): Unit {
    const id = Ledger.id(type, key);
    const prev = this.units.get(id);
    const u: Unit = { id, type, key, parent, status: "running", attempts: (prev?.attempts ?? 0) + 1, startedAt: new Date().toISOString(), run: this.run };
    this.write(u);
    return u;
  }

  finish(type: string, key: string, status: "done" | "failed" | "skipped", error?: string) {
    const id = Ledger.id(type, key);
    const prev = this.units.get(id) ?? { id, type, key, attempts: 0, run: this.run } as Unit;
    this.write({ ...prev, status, error: status === "failed" ? error ?? "failed" : undefined, finishedAt: new Date().toISOString(), run: this.run });
  }

  /** For the A2UI view: totals per type/status + the most recent units. */
  summary(recent = 15) {
    const totals: Record<string, Record<string, number>> = {};
    for (const u of this.units.values()) {
      totals[u.type] ??= { running: 0, done: 0, failed: 0, skipped: 0 };
      totals[u.type][u.status]++;
    }
    const units = [...this.units.values()].sort((a, b) => String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)))
      .slice(0, recent).map((u) => ({ id: u.id, status: u.status, attempts: u.attempts, error: u.error ?? "" }));
    return { totals, units };
  }
}
