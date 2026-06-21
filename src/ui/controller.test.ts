import { describe, expect, it, vi } from "vitest";
import { Controller } from "./controller.js";
import { ToolRegistry } from "../tools/registry.js";
import type { FinishReason, Gateway, Message, Stream } from "../types.js";

class FakeGateway implements Gateway {
  calls = 0;
  constructor(private scripts: { text: string; finishReason?: FinishReason }[]) {}
  stream(_m: string, _msgs: Message[]): Stream {
    const s = this.scripts[this.calls++] ?? { text: "done" };
    async function* gen(): AsyncGenerator<string> {
      for (const ch of s.text.match(/.{1,3}/g) ?? []) yield ch;
    }
    return { deltas: gen(), done: Promise.resolve({ finishReason: s.finishReason ?? "stop" }) };
  }
}

const tc = (name: string, args: object = {}) =>
  `<tool_call><name>${name}</name><args>${JSON.stringify(args)}</args></tool_call>`;

function make(scripts: { text: string; finishReason?: FinishReason }[], over = {}) {
  return new Controller({
    gateway: new FakeGateway(scripts),
    registry: new ToolRegistry(),
    model: "test",
    maxIterations: 25,
    approval: "ask",
    seed: [{ role: "system", content: "sys" }],
    throttleMs: 0,
    ...over,
  });
}

describe("Controller", () => {
  it("a turn produces user + assistant lines, busy clears", async () => {
    const c = make([{ text: "Hello there" }]);
    await c.send("hi");
    expect(c.busy).toBe(false);
    const kinds = c.lines.map((l) => l.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    expect(c.lines.find((l) => l.kind === "assistant")!.text).toBe("Hello there");
  });

  it("notifies subscribers as state changes", async () => {
    const c = make([{ text: "yo" }]);
    const sub = vi.fn();
    c.subscribe(sub);
    await c.send("hi");
    expect(sub).toHaveBeenCalled();
  });

  it("tool call renders tool lines", async () => {
    const reg = new ToolRegistry().register({
      name: "read",
      description: "",
      kind: "read",
      needsApproval: false,
      run: async () => "contents",
    });
    const c = make([{ text: tc("read", { path: "a" }) }, { text: "fin" }], { registry: reg });
    await c.send("go");
    const tools = c.lines.filter((l) => l.kind === "tool");
    expect(tools[0]!.text).toContain("→ read");
    expect(tools.some((l) => l.text.includes("contents"))).toBe(true);
  });

  it("approval request surfaces as pending; answer(false) denies", async () => {
    const ran = vi.fn(async () => "ran");
    const reg = new ToolRegistry().register({
      name: "bash",
      description: "",
      kind: "exec",
      needsApproval: true,
      run: ran,
    });
    const c = make([{ text: tc("bash", { cmd: "ls" }) }, { text: "fin" }], { registry: reg });
    const turn = c.send("go");
    await vi.waitFor(() => expect(c.pending?.kind).toBe("approval"));
    expect(c.pending!.prompt).toContain("bash");
    c.answer(false);
    await turn;
    expect(ran).not.toHaveBeenCalled();
    expect(c.lines.some((l) => l.text.includes("Denied by user"))).toBe(true);
  });

  it("ask_user request surfaces as pending; answer injects the reply", async () => {
    const c = make([{ text: tc("ask_user", { question: "lang?" }) }, { text: "fin" }]);
    const turn = c.send("go");
    await vi.waitFor(() => expect(c.pending?.kind).toBe("ask"));
    expect(c.pending!.prompt).toBe("lang?");
    c.answer("rust");
    await turn;
    expect(c.lines.some((l) => l.kind === "assistant" && l.text === "fin")).toBe(true);
  });
});
