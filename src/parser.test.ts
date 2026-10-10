import { describe, expect, it } from "vitest";
import { parseToolCalls } from "./parser.js";

describe("parseToolCalls", () => {
  it("returns prose only when there are zero calls", () => {
    const r = parseToolCalls("Just a plain answer, no tools.");
    expect(r.calls).toHaveLength(0);
    expect(r.malformed).toHaveLength(0);
    expect(r.prose).toBe("Just a plain answer, no tools.");
  });

  it("parses a single tool call with JSON args", () => {
    const r = parseToolCalls(
      `<tool_call><name>read</name><args>{"path":"src/x.ts"}</args></tool_call>`,
    );
    expect(r.calls).toEqual([{ name: "read", args: { path: "src/x.ts" } }]);
    expect(r.malformed).toHaveLength(0);
  });

  it("parses multiple tool calls in one message in order", () => {
    const r = parseToolCalls(
      `<tool_call><name>read</name><args>{"path":"a"}</args></tool_call>
       <tool_call><name>bash</name><args>{"cmd":"ls"}</args></tool_call>`,
    );
    expect(r.calls.map((c) => c.name)).toEqual(["read", "bash"]);
  });

  it("ignores <think> blocks", () => {
    const r = parseToolCalls(
      `<think>I should read the file <tool_call>not real</tool_call></think>` +
        `<tool_call><name>read</name><args>{"path":"a"}</args></tool_call>`,
    );
    expect(r.calls).toEqual([{ name: "read", args: { path: "a" } }]);
    expect(r.malformed).toHaveLength(0);
  });

  it("allows a tool call with no <args> (treated as empty object)", () => {
    const r = parseToolCalls(`<tool_call><name>list</name></tool_call>`);
    expect(r.calls).toEqual([{ name: "list", args: {} }]);
  });

  it("parses through markdown code fences (common drift)", () => {
    const r = parseToolCalls(
      "```xml\n<tool_call><name>grep</name><args>{\"q\":\"foo\"}</args></tool_call>\n```",
    );
    expect(r.calls).toEqual([{ name: "grep", args: { q: "foo" } }]);
  });

  it("tolerates whitespace and newlines inside tags", () => {
    const r = parseToolCalls(
      `<tool_call>\n  <name>  read  </name>\n  <args>\n  {"path": "a"}\n  </args>\n</tool_call>`,
    );
    expect(r.calls).toEqual([{ name: "read", args: { path: "a" } }]);
  });

  describe("malformed (never throws, always flagged)", () => {
    it("missing </tool_call>", () => {
      const r = parseToolCalls(`<tool_call><name>read</name><args>{}</args>`);
      expect(r.calls).toHaveLength(0);
      expect(r.malformed.join(" ")).toMatch(/unclosed/i);
    });

    it("invalid JSON args", () => {
      const r = parseToolCalls(`<tool_call><name>read</name><args>{not json}</args></tool_call>`);
      expect(r.calls).toHaveLength(0);
      expect(r.malformed.join(" ")).toMatch(/not valid JSON/i);
    });

    it("empty <name>", () => {
      const r = parseToolCalls(`<tool_call><name></name><args>{}</args></tool_call>`);
      expect(r.calls).toHaveLength(0);
      expect(r.malformed.join(" ")).toMatch(/name/i);
    });

    it("args that is a JSON array, not an object", () => {
      const r = parseToolCalls(`<tool_call><name>x</name><args>[1,2]</args></tool_call>`);
      expect(r.calls).toHaveLength(0);
      expect(r.malformed.join(" ")).toMatch(/object/i);
    });

    it("a valid call alongside a malformed one keeps the valid one", () => {
      const r = parseToolCalls(
        `<tool_call><name>read</name><args>{"path":"a"}</args></tool_call>` +
          `<tool_call><name></name></tool_call>`,
      );
      expect(r.calls).toEqual([{ name: "read", args: { path: "a" } }]);
      expect(r.malformed).toHaveLength(1);
    });
  });
});
