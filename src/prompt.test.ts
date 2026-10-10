import { describe, expect, it } from "vitest";
import { buildSessionContext, buildSystemPrompt } from "./prompt.js";
import { readTool } from "./tools/read.js";
import { bashTool } from "./tools/bash.js";
import { ToolRegistry } from "./tools/registry.js";

function reg(): ToolRegistry {
  return new ToolRegistry().register(readTool).register(bashTool);
}

describe("system prompt", () => {
  it("is byte-identical across builds with the same registry (cache-stable)", () => {
    expect(buildSystemPrompt(reg())).toBe(buildSystemPrompt(reg()));
  });

  it("reflects the registry's tools and the XML format spec", () => {
    const p = buildSystemPrompt(reg());
    expect(p).toContain("read:");
    expect(p).toContain("bash:");
    expect(p).toContain("<tool_call>");
    expect(p).toContain("[needs approval]");
  });

  it("volatile session context is separate from the stable prefix", () => {
    const p = buildSystemPrompt(reg());
    expect(p).not.toContain("working directory");
    expect(buildSessionContext("/tmp/x")).toContain("/tmp/x");
  });
});
