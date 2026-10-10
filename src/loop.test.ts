import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentOptions } from "./loop.js";
import { ToolRegistry } from "./tools/registry.js";
import type { Tool } from "./tools/types.js";
import type { FinishReason, Gateway, Message, Stream } from "./types.js";

interface Script {
  text: string;
  finishReason?: FinishReason;
}

class FakeGateway implements Gateway {
  calls = 0;
  seen: Message[][] = [];
  constructor(private scripts: Script[]) {}
  stream(_model: string, messages: Message[]): Stream {
    this.seen.push(messages.map((m) => ({ ...m })));
    const script = this.scripts[this.calls++] ?? { text: "fallback final answer" };
    async function* gen(): AsyncGenerator<string> {
      yield script.text;
    }
    return { deltas: gen(), done: Promise.resolve({ finishReason: script.finishReason ?? "stop" }) };
  }
}

function call(name: string, args: object = {}): string {
  return `<tool_call><name>${name}</name><args>${JSON.stringify(args)}</args></tool_call>`;
}

function makeAgent(scripts: Script[], reg: ToolRegistry, over: Partial<AgentOptions> = {}): {
  agent: Agent;
  gw: FakeGateway;
} {
  const gw = new FakeGateway(scripts);
  const agent = new Agent({
    gateway: gw,
    registry: reg,
    model: "test",
    maxIterations: 25,
    approval: "full-auto",
    approvalPrompt: async () => true,
    ...over,
  });
  agent.seed([{ role: "system", content: "sys" }]);
  return { agent, gw };
}

describe("Agent loop", () => {
  it("single tool call → result → final text", async () => {
    const ran = vi.fn(async () => "file contents");
    const reg = new ToolRegistry().register({
      name: "read",
      description: "",
      kind: "read",
      needsApproval: false,
      run: ran,
    });
    const { agent } = makeAgent([{ text: call("read", { path: "a" }) }, { text: "All done." }], reg);
    const out = await agent.send("read file a");
    expect(out).toBe("All done.");
    expect(ran).toHaveBeenCalledWith({ path: "a" });
    // transcript: system, user, assistant(call), tool_result, assistant(final)
    const roles = agent.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(agent.messages[3]!.content).toContain("<tool_result name=\"read\">");
    expect(agent.messages[3]!.content).toContain("file contents");
  });

  it("three sequential tool calls then finish, in order", async () => {
    const order: string[] = [];
    const mk = (name: string): Tool => ({
      name,
      description: "",
      kind: "read",
      needsApproval: false,
      run: async () => {
        order.push(name);
        return name;
      },
    });
    const reg = new ToolRegistry().register(mk("a")).register(mk("b")).register(mk("c"));
    const { agent } = makeAgent(
      [{ text: call("a") }, { text: call("b") }, { text: call("c") }, { text: "fin" }],
      reg,
    );
    expect(await agent.send("go")).toBe("fin");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("malformed turn → error fed back → next turn succeeds", async () => {
    const reg = new ToolRegistry();
    const { agent } = makeAgent(
      [{ text: "<tool_call><name>read</name><args>{bad json}</args></tool_call>" }, { text: "ok" }],
      reg,
    );
    expect(await agent.send("go")).toBe("ok");
    const feedback = agent.messages.find((m) => m.content.includes("didn't parse"));
    expect(feedback).toBeDefined();
  });

  it("denied tool → error fed back, loop continues", async () => {
    const ran = vi.fn(async () => "should not run");
    const reg = new ToolRegistry().register({
      name: "bash",
      description: "",
      kind: "exec",
      needsApproval: true,
      run: ran,
    });
    const { agent } = makeAgent([{ text: call("bash", { cmd: "rm -rf /" }) }, { text: "ok" }], reg, {
      approval: "ask",
      approvalPrompt: async () => false,
    });
    expect(await agent.send("go")).toBe("ok");
    expect(ran).not.toHaveBeenCalled();
    expect(agent.messages.some((m) => m.content.includes("Denied by user"))).toBe(true);
  });

  it("gateway always emits a tool call → stops at maxIterations, no hang", async () => {
    const reg = new ToolRegistry().register({
      name: "loop",
      description: "",
      kind: "read",
      needsApproval: false,
      run: async () => "again",
    });
    const scripts = Array.from({ length: 30 }, () => ({ text: call("loop") }));
    const { agent } = makeAgent(scripts, reg, { maxIterations: 5 });
    const out = await agent.send("go");
    expect(out).toMatch(/Stopped after 5 iterations/);
  });

  it("tool throws → caught as error-as-feedback, loop survives", async () => {
    const reg = new ToolRegistry().register({
      name: "boom",
      description: "",
      kind: "read",
      needsApproval: false,
      run: async () => {
        throw new Error("kaboom");
      },
    });
    const { agent } = makeAgent([{ text: call("boom") }, { text: "recovered" }], reg);
    expect(await agent.send("go")).toBe("recovered");
    expect(agent.messages.some((m) => m.content.includes("kaboom"))).toBe(true);
  });

  it("finish_reason=length → feedback, then continues", async () => {
    const reg = new ToolRegistry();
    const { agent } = makeAgent(
      [{ text: "partial...", finishReason: "length" }, { text: "concise answer" }],
      reg,
    );
    expect(await agent.send("go")).toBe("concise answer");
    expect(agent.messages.some((m) => m.content.includes("cut off"))).toBe(true);
  });

  describe("ask_user", () => {
    const askReg = (ask: () => Promise<string>) =>
      new ToolRegistry().register({
        name: "ask_user",
        description: "",
        kind: "read",
        needsApproval: false,
        run: async (a) => ask(),
      });

    it("scripted ask_user → answer injected → loop continues with it", async () => {
      const ask = vi.fn(async () => "use TypeScript");
      const { agent } = makeAgent(
        [{ text: call("ask_user", { question: "which language?" }) }, { text: "done" }],
        askReg(ask),
        { approval: "ask" },
      );
      expect(await agent.send("go")).toBe("done");
      expect(ask).toHaveBeenCalledOnce();
      expect(agent.messages.some((m) => m.content.includes("use TypeScript"))).toBe(true);
    });

    it("N+1 consecutive asks → capped, tool not called past the cap", async () => {
      const ask = vi.fn(async () => "answer");
      const scripts = [
        ...Array.from({ length: 5 }, () => ({ text: call("ask_user", { question: "q" }) })),
        { text: "fin" },
      ];
      const { agent } = makeAgent(scripts, askReg(ask), { approval: "ask", askUserCap: 2 });
      await agent.send("go");
      expect(ask.mock.calls.length).toBe(2); // capped at 2; further asks force a best-guess answer
      expect(agent.messages.some((m) => m.content.includes("Ask limit reached"))).toBe(true);
    });

    it("full-auto → ask_user does not block, auto-answers", async () => {
      const ask = vi.fn(async () => "should not be called");
      const { agent } = makeAgent(
        [{ text: call("ask_user", { question: "q" }) }, { text: "fin" }],
        askReg(ask),
        { approval: "full-auto" },
      );
      await agent.send("go");
      expect(ask).not.toHaveBeenCalled();
      expect(agent.messages.some((m) => m.content.includes("best guess"))).toBe(true);
    });
  });
});
