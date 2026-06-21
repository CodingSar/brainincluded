import type { ToolRegistry } from "./tools/registry.js";

/** Stable persona + format spec. Volatile data (cwd/time) goes in the tail, not here (§3.6). */
const PERSONA = `You are an agentic coding assistant operating in a terminal. You complete real coding tasks by reading, searching, editing files and running shell commands — iterating until the task is done.

Be terse. Prefer doing over explaining. Take initiative, but ask the user when genuinely ambiguous.`;

const FORMAT_SPEC = `# Tool calls
To use a tool, emit EXACTLY this XML (optionally preceded by a <think> block with your reasoning):

<think>your reasoning — not shown to tools, not executed</think>
<tool_call>
  <name>TOOL_NAME</name>
  <args>{"json": "arguments"}</args>
</tool_call>

Rules:
- <args> must be a single valid JSON object. Emit one or more <tool_call> blocks per turn.
- After a tool runs, its output is returned to you wrapped in <tool_result>. Read it, then continue.
- When the task is complete, reply with a normal message and NO tool call. That ends the turn.
- If a tool returns an error, adapt and try again — do not give up silently.`;

/** Build the stable system-prompt prefix (§3.2, §3.6, BI-011). */
export function buildSystemPrompt(registry: ToolRegistry): string {
  return [PERSONA, "# Tools", registry.describe(), FORMAT_SPEC].join("\n\n");
}

/** Volatile per-session context — appended AFTER the stable prefix so it never breaks caching. */
export function buildSessionContext(cwd: string): string {
  return `<session>\nworking directory: ${cwd}\n</session>`;
}
