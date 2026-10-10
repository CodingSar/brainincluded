/** Conversation roles. Tool results re-enter as `user` text (PRD §3.4.2). */
export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/** A parsed tool invocation extracted from raw assistant text (PRD §3.2). */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Result of parsing one assistant message. */
export interface ParseResult {
  /** Prose outside of <tool_call>/<think> blocks. */
  prose: string;
  calls: ToolCall[];
  /** Human-readable reasons a <tool_call> block failed to parse (fed back, §3.1). */
  malformed: string[];
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface Usage {
  prompt: number;
  completion: number;
}

export interface StreamResult {
  finishReason: FinishReason;
  usage?: Usage;
}

/** A streaming text source that also resolves terminal metadata when done. */
export interface Stream {
  deltas: AsyncIterable<string>;
  done: Promise<StreamResult>;
}

export interface Gateway {
  stream(modelName: string, messages: Message[], signal?: AbortSignal): Stream;
}
