import type { Tool } from "./types.js";

/** User-input function injected by the TUI; resolves the user's typed answer. */
export type AskFn = (question: string) => Promise<string>;

/**
 * ask_user — pause and ask the user a clarifying question (PRD §3.12, BI-023).
 * The consecutive-ask cap and full-auto auto-answer are enforced by the loop, not here.
 */
export function makeAskUserTool(ask: AskFn): Tool {
  return {
    name: "ask_user",
    description: "Pause and ask the user a clarifying question before acting on an ambiguous task.",
    argsHint: `{"question": string}`,
    kind: "read",
    needsApproval: false,
    async run(args) {
      const question = args["question"];
      if (typeof question !== "string" || question.length === 0) {
        return "Error: 'question' (string) is required";
      }
      const answer = await ask(question);
      return answer.length > 0 ? answer : "(no answer given)";
    },
  };
}
