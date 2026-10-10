import { parseToolCalls } from "./parser.js";
import { gate, type ApprovalMode, type ApprovalPrompt } from "./permission.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Gateway, Message, ToolCall } from "./types.js";

export type LoopEvent =
  | { type: "assistant"; text: string; finishReason: string }
  | { type: "tool-start"; call: ToolCall }
  | { type: "tool-result"; name: string; result: string; approved: boolean }
  | { type: "malformed"; reasons: string[] }
  | { type: "max-iterations" };

export interface AgentOptions {
  gateway: Gateway;
  registry: ToolRegistry;
  model: string;
  maxIterations: number;
  approval: ApprovalMode;
  approvalPrompt: ApprovalPrompt;
  /** Cap on consecutive ask_user calls before the loop forces a best-guess answer. */
  askUserCap?: number;
  onDelta?: (delta: string) => void;
  onEvent?: (event: LoopEvent) => void;
  signal?: AbortSignal;
}

const ASK_USER = "ask_user";

/** The ReAct turn loop (PRD §3.1, BI-009). Holds the transcript across turns. */
export class Agent {
  readonly messages: Message[] = [];
  private consecutiveAsks = 0;

  constructor(private readonly opts: AgentOptions) {}

  /** Seed the transcript prefix (system prompt + any session context). */
  seed(messages: Message[]): void {
    this.messages.push(...messages);
  }

  /** Run one user turn to completion; returns the final assistant prose. */
  async send(userText: string): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const { maxIterations } = this.opts;

    for (let i = 0; i < maxIterations; i++) {
      const raw = await this.streamAssistant();
      const parsed = parseToolCalls(raw.text);
      this.messages.push({ role: "assistant", content: raw.text });
      this.opts.onEvent?.({ type: "assistant", text: parsed.prose, finishReason: raw.finishReason });

      if (raw.finishReason === "length") {
        // Truncation = context overflow (§3.4.1). Feed back; compaction is M2 (BI-018).
        this.feedback("Your previous response was cut off at the context limit. Be more concise.");
        continue;
      }

      if (parsed.calls.length === 0) {
        if (parsed.malformed.length > 0) {
          this.opts.onEvent?.({ type: "malformed", reasons: parsed.malformed });
          this.feedback(
            `Your tool call didn't parse (${parsed.malformed.join("; ")}). Re-emit it exactly per the format.`,
          );
          continue;
        }
        return parsed.prose; // ← no tool call: turn complete
      }

      for (const call of parsed.calls) {
        await this.executeCall(call);
      }
      if (parsed.malformed.length > 0) {
        this.opts.onEvent?.({ type: "malformed", reasons: parsed.malformed });
        this.feedback(`Also, a malformed tool call was ignored: ${parsed.malformed.join("; ")}`);
      }
    }

    this.opts.onEvent?.({ type: "max-iterations" });
    return `Stopped after ${maxIterations} iterations without completing.`;
  }

  private async streamAssistant(): Promise<{ text: string; finishReason: string }> {
    const stream = this.opts.gateway.stream(this.opts.model, this.messages, this.opts.signal);
    let text = "";
    for await (const delta of stream.deltas) {
      text += delta;
      this.opts.onDelta?.(delta);
    }
    const result = await stream.done;
    return { text, finishReason: result.finishReason };
  }

  private async executeCall(call: ToolCall): Promise<void> {
    const tool = this.opts.registry.get(call.name);
    if (!tool) {
      this.toolResult(call.name, `Error: unknown tool '${call.name}'`, true);
      this.consecutiveAsks = 0;
      return;
    }

    this.opts.onEvent?.({ type: "tool-start", call });

    if (call.name === ASK_USER) {
      const forced = this.forcedAskAnswer();
      if (forced !== null) {
        this.toolResult(call.name, forced, true);
        return;
      }
      this.consecutiveAsks++;
    } else {
      this.consecutiveAsks = 0;
    }

    const approved = await gate(call, tool, this.opts.approval, this.opts.approvalPrompt);
    if (!approved) {
      this.toolResult(call.name, "Denied by user.", false);
      return;
    }

    let result: string;
    try {
      result = await tool.run(call.args);
    } catch (err) {
      // Error-as-feedback (§3.1): never throw out of the loop.
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.toolResult(call.name, result, true);
  }

  /** Returns a forced answer string when ask_user must be short-circuited, else null. */
  private forcedAskAnswer(): string | null {
    if (this.opts.approval === "full-auto") {
      return "Proceed with your best guess (full-auto mode: no user is available).";
    }
    const cap = this.opts.askUserCap ?? 3;
    if (this.consecutiveAsks >= cap) {
      return "Ask limit reached. Proceed with your best guess without asking again.";
    }
    return null;
  }

  private toolResult(name: string, result: string, approved: boolean): void {
    this.opts.onEvent?.({ type: "tool-result", name, result, approved });
    this.messages.push({
      role: "user",
      content: `<tool_result name="${name}">\n${result}\n</tool_result>`,
    });
  }

  private feedback(text: string): void {
    this.messages.push({ role: "user", content: `<system>${text}</system>` });
  }
}
