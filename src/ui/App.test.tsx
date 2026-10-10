import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { Controller } from "./controller.js";
import { ToolRegistry } from "../tools/registry.js";
import type { FinishReason, Gateway, Message, Stream } from "../types.js";

class FakeGateway implements Gateway {
  calls = 0;
  constructor(private scripts: { text: string; finishReason?: FinishReason }[]) {}
  stream(_m: string, _msgs: Message[]): Stream {
    const s = this.scripts[this.calls++] ?? { text: "done" };
    async function* gen(): AsyncGenerator<string> {
      yield s.text;
    }
    return { deltas: gen(), done: Promise.resolve({ finishReason: s.finishReason ?? "stop" }) };
  }
}

function makeController(scripts: { text: string }[]): Controller {
  return new Controller({
    gateway: new FakeGateway(scripts),
    registry: new ToolRegistry(),
    model: "test",
    maxIterations: 25,
    approval: "ask",
    seed: [{ role: "system", content: "sys" }],
    throttleMs: 0,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("App (Ink)", () => {
  it("renders an input prompt without throwing", () => {
    const { lastFrame, unmount } = render(<App controller={makeController([])} />);
    expect(lastFrame()).toContain("›");
    unmount();
  });

  // Note: ink-testing-library's stdin has no raw-mode, so useInput never fires here.
  // Input plumbing is a thin wrapper over controller.send/answer (covered by controller tests);
  // these assert the App renders the controller's resulting state.
  it("renders assistant output in scrollback after a turn", async () => {
    const controller = makeController([{ text: "pong" }]);
    const { lastFrame, unmount } = render(<App controller={controller} />);
    await controller.send("ping");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ping"); // user line
    expect(frame).toContain("pong"); // assistant line
    unmount();
  });

  it("renders an approval prompt while a gated tool awaits approval", async () => {
    const reg = new ToolRegistry().register({
      name: "bash",
      description: "",
      kind: "exec",
      needsApproval: true,
      run: async () => "ran",
    });
    const controller = new Controller({
      gateway: new FakeGateway([
        { text: `<tool_call><name>bash</name><args>{"cmd":"ls"}</args></tool_call>` },
        { text: "fin" },
      ]),
      registry: reg,
      model: "test",
      maxIterations: 25,
      approval: "ask",
      seed: [{ role: "system", content: "sys" }],
      throttleMs: 0,
    });
    const { lastFrame, unmount } = render(<App controller={controller} />);
    const turn = controller.send("go");
    await tick();
    expect(lastFrame()).toContain("[y/n]");
    controller.answer(true);
    await turn;
    await tick();
    expect(lastFrame()).toContain("fin");
    unmount();
  });
});
