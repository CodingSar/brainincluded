/** A registered tool (PRD §3.3, BI-005). `run` returns a string fed back to the model. */
/** Coarse risk category — drives which approval mode auto-approves it (§3.7). */
export type ToolKind = "read" | "edit" | "exec";

export interface Tool {
  name: string;
  description: string;
  /** One-line arg hint shown in the system prompt, e.g. `{"path": string, "start"?: number}`. */
  argsHint?: string;
  kind: ToolKind;
  needsApproval: boolean;
  run(args: Record<string, unknown>): Promise<string>;
}
