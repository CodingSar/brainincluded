import type { Tool } from "./types.js";

/** Extensible tool registry (PRD §3.5 / D17 / BI-005). Adding a tool = one register call. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Tools in registration order — keeps the prompt prefix stable for caching (§3.6). */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Stable, ordered tool-description block for the system prompt (§3.6 / BI-011). */
  describe(): string {
    return this.list()
      .map((t) => {
        const hint = t.argsHint ? ` args: ${t.argsHint}` : "";
        const gate = t.needsApproval ? " [needs approval]" : "";
        return `- ${t.name}: ${t.description}${hint}${gate}`;
      })
      .join("\n");
  }
}
