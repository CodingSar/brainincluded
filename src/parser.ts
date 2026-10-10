import type { ParseResult, ToolCall } from "./types.js";

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const NAME_RE = /<name>\s*([\s\S]*?)\s*<\/name>/i;
const ARGS_RE = /<args>\s*([\s\S]*?)\s*<\/args>/i;

/**
 * Extract tool calls from raw assistant text (PRD §3.2, BI-004).
 *
 * - Ignores <think> blocks entirely (not executed, not prose).
 * - Tolerates markdown code fences wrapping the tags (common model drift).
 * - Never throws: malformed blocks are reported as strings to feed back (§3.1).
 */
export function parseToolCalls(raw: string): ParseResult {
  const calls: ToolCall[] = [];
  const malformed: string[] = [];

  // Strip reasoning first so it never leaks into calls or prose.
  const withoutThink = raw.replace(THINK_RE, "");

  let match: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(withoutThink)) !== null) {
    const inner = match[1] ?? "";
    const nameMatch = NAME_RE.exec(inner);
    const name = nameMatch?.[1]?.trim() ?? "";
    if (!name) {
      malformed.push("tool_call missing a non-empty <name>");
      continue;
    }

    const argsMatch = ARGS_RE.exec(inner);
    let args: Record<string, unknown> = {};
    if (argsMatch) {
      const rawArgs = argsMatch[1]?.trim() ?? "";
      if (rawArgs.length > 0) {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            malformed.push(`tool_call '${name}' <args> must be a JSON object`);
            continue;
          }
          args = parsed as Record<string, unknown>;
        } catch {
          malformed.push(`tool_call '${name}' <args> is not valid JSON`);
          continue;
        }
      }
    }
    calls.push({ name, args });
  }

  // Detect a dangling, unclosed <tool_call> (model got cut off mid-call).
  const consumed = withoutThink.replace(TOOL_CALL_RE, "");
  if (/<tool_call>/i.test(consumed)) {
    malformed.push("unclosed <tool_call> block (missing </tool_call>)");
  }

  const prose = consumed.replace(/<tool_call>[\s\S]*$/i, "").trim();

  return { prose, calls, malformed };
}
