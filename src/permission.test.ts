import { describe, expect, it, vi } from "vitest";
import { gate } from "./permission.js";
import type { Tool } from "./tools/types.js";
import type { ToolCall } from "./types.js";

const readT: Tool = { name: "read", description: "", kind: "read", needsApproval: false, run: async () => "" };
const bashT: Tool = { name: "bash", description: "", kind: "exec", needsApproval: true, run: async () => "" };
const editT: Tool = { name: "edit", description: "", kind: "edit", needsApproval: true, run: async () => "" };
const call: ToolCall = { name: "x", args: {} };

describe("gate", () => {
  it("read-only tool never prompts, any mode", async () => {
    const prompt = vi.fn();
    expect(await gate(call, readT, "ask", prompt)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("ask mode: deny → false, tool not approved", async () => {
    const prompt = vi.fn(async () => false);
    expect(await gate(call, bashT, "ask", prompt)).toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("ask mode: approve → true", async () => {
    const prompt = vi.fn(async () => true);
    expect(await gate(call, bashT, "ask", prompt)).toBe(true);
  });

  it("full-auto: no prompt, executes", async () => {
    const prompt = vi.fn();
    expect(await gate(call, bashT, "full-auto", prompt)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("auto-edit: approves edits but still prompts for exec", async () => {
    const prompt = vi.fn(async () => false);
    expect(await gate(call, editT, "auto-edit", prompt)).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(await gate(call, bashT, "auto-edit", prompt)).toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
  });
});
