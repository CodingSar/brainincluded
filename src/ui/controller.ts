import { Agent } from "../loop.js";
import type { LoopEvent } from "../loop.js";
import { type ApprovalMode } from "../permission.js";
import { makeAskUserTool } from "../tools/ask-user.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Gateway, Message } from "../types.js";

export type LineKind = "user" | "assistant" | "tool" | "info" | "error";
export interface LogLine {
  id: number;
  kind: LineKind;
  text: string;
}

export type Pending =
  | { kind: "approval"; prompt: string; resolve: (approved: boolean) => void }
  | { kind: "ask"; prompt: string; resolve: (answer: string) => void };

export interface ControllerOptions {
  gateway: Gateway;
  /** Base registry WITHOUT ask_user — the controller injects ask_user bound to its own prompt. */
  registry: ToolRegistry;
  model: string;
  maxIterations: number;
  approval: ApprovalMode;
  askUserCap?: number;
  seed: Message[];
  /** Throttle window for streaming re-renders (ms). Avoids Ink jank (§D13 gotcha). */
  throttleMs?: number;
}

const RESULT_PREVIEW = 400;

/** Bridges the Agent loop to the TUI: holds render state, routes approval/ask to the user. */
export class Controller {
  lines: LogLine[] = [];
  live = "";
  busy = false;
  pending: Pending | null = null;

  private readonly agent: Agent;
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  private notifyScheduled = false;
  private readonly throttleMs: number;

  constructor(opts: ControllerOptions) {
    this.throttleMs = opts.throttleMs ?? 50;
    opts.registry.register(makeAskUserTool((q) => this.requestAsk(q)));
    this.agent = new Agent({
      gateway: opts.gateway,
      registry: opts.registry,
      model: opts.model,
      maxIterations: opts.maxIterations,
      approval: opts.approval,
      askUserCap: opts.askUserCap,
      approvalPrompt: (call, tool) =>
        this.requestApproval(`Run ${tool.name} ${JSON.stringify(call.args)}? [y/n]`),
      onDelta: (d) => {
        this.live += d;
        this.scheduleNotify();
      },
      onEvent: (e) => this.handleEvent(e),
    });
    this.agent.seed(opts.seed);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run a user turn. Safe to ignore the returned promise (UI updates via subscribe). */
  async send(input: string): Promise<void> {
    if (this.busy) return;
    this.pushLine("user", input);
    this.busy = true;
    this.notify();
    try {
      await this.agent.send(input);
    } catch (err) {
      this.pushLine("error", err instanceof Error ? err.message : String(err));
    } finally {
      this.flushLive();
      this.busy = false;
      this.notify();
    }
  }

  /** Resolve a pending approval/ask interaction with the user's answer. */
  answer(value: boolean | string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.kind === "approval" && typeof value === "boolean") p.resolve(value);
    else if (p.kind === "ask") p.resolve(String(value));
    this.notify();
  }

  private requestApproval(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending = { kind: "approval", prompt, resolve };
      this.notify();
    });
  }

  private requestAsk(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.pending = { kind: "ask", prompt: question, resolve };
      this.notify();
    });
  }

  private handleEvent(e: LoopEvent): void {
    switch (e.type) {
      case "assistant":
        this.flushLive();
        if (e.text.trim().length > 0) this.pushLine("assistant", e.text.trim());
        break;
      case "tool-start":
        this.pushLine("tool", `→ ${e.call.name} ${JSON.stringify(e.call.args)}`);
        break;
      case "tool-result":
        this.pushLine("tool", `  ${truncate(e.result)}`);
        break;
      case "malformed":
        this.pushLine("info", `malformed tool call: ${e.reasons.join("; ")}`);
        break;
      case "max-iterations":
        this.pushLine("info", "stopped: hit max iterations");
        break;
    }
  }

  private flushLive(): void {
    if (this.live.length === 0) return;
    // The 'assistant' event already pushes finalized prose; live holds raw stream remnants only.
    this.live = "";
  }

  private pushLine(kind: LineKind, text: string): void {
    // New array ref each time so Ink's <Static> (React.memo on `items`) picks up the change.
    this.lines = [...this.lines, { id: this.nextId++, kind, text }];
    this.notify();
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setTimeout(() => {
      this.notifyScheduled = false;
      this.notify();
    }, this.throttleMs);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

function truncate(s: string): string {
  const flat = s.replace(/\n/g, " ");
  return flat.length > RESULT_PREVIEW ? flat.slice(0, RESULT_PREVIEW) + " …" : flat;
}
