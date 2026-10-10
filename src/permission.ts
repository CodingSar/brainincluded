import type { ToolCall } from "./types.js";
import type { Tool } from "./tools/types.js";

export type ApprovalMode = "ask" | "auto-edit" | "full-auto";

/** Prompts the user; resolves true to approve. Injected so the loop is TUI-agnostic. */
export type ApprovalPrompt = (call: ToolCall, tool: Tool) => Promise<boolean>;

/**
 * Decide whether a tool call may run (PRD §3.7 / BI-008).
 * Read-only tools never prompt. `full-auto`/`auto-edit` bypass per policy.
 * Returns true if the call may execute; false → caller feeds back "denied by user".
 */
export async function gate(
  call: ToolCall,
  tool: Tool,
  mode: ApprovalMode,
  prompt: ApprovalPrompt,
): Promise<boolean> {
  if (!tool.needsApproval) return true;
  if (mode === "full-auto") return true;
  // auto-edit auto-approves file edits/writes but still gates command execution.
  if (mode === "auto-edit" && tool.kind === "edit") return true;
  return prompt(call, tool);
}
