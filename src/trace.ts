import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StreamResult } from "./types.js";

export interface TraceEntry {
  model: string;
  msgCount: number;
  output: string;
  finishReason: StreamResult["finishReason"] | "error";
  usage?: StreamResult["usage"];
  latencyMs: number;
  error?: string;
}

/** Append-only JSONL trace of gateway calls (PRD §3.4.2, BI-029). No-op when disabled. */
export class Tracer {
  constructor(private readonly logFile?: string) {}

  log(entry: TraceEntry): void {
    if (!this.logFile) return;
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      // Only whitelisted fields are written — secrets (keys/headers) never reach here.
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
    } catch {
      // Tracing must never break a turn.
    }
  }
}
