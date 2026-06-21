import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";
import { readTool } from "./read.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bi-tools-"));
}

describe("read tool", () => {
  it("reads a whole file with line numbers", async () => {
    const dir = await tmp();
    const f = join(dir, "a.txt");
    await writeFile(f, "one\ntwo\nthree");
    const out = await readTool.run({ path: f });
    expect(out).toBe("1\tone\n2\ttwo\n3\tthree");
  });

  it("reads a line range", async () => {
    const dir = await tmp();
    const f = join(dir, "a.txt");
    await writeFile(f, "one\ntwo\nthree\nfour");
    const out = await readTool.run({ path: f, start: 2, end: 3 });
    expect(out).toBe("2\ttwo\n3\tthree");
  });

  it("missing file → error string", async () => {
    const out = await readTool.run({ path: "/nope/missing.txt" });
    expect(out).toMatch(/no such file/i);
  });

  it("directory path → error string", async () => {
    const dir = await tmp();
    const out = await readTool.run({ path: dir });
    expect(out).toMatch(/is a directory/i);
  });

  it("missing path arg → error string", async () => {
    expect(await readTool.run({})).toMatch(/required/i);
  });
});

describe("bash tool", () => {
  it("captures stdout and exit code", async () => {
    const out = await bashTool.run({ cmd: "echo hello" });
    expect(out).toContain("hello");
    expect(out).toContain("[exit 0]");
  });

  it("captures non-zero exit (does not throw)", async () => {
    const out = await bashTool.run({ cmd: "exit 3" });
    expect(out).toContain("[exit 3]");
  });

  it("kills on timeout and returns a timeout error", async () => {
    const out = await bashTool.run({ cmd: "sleep 5", timeoutMs: 100 });
    expect(out).toMatch(/timed out/i);
  });

  it("missing cmd arg → error string", async () => {
    expect(await bashTool.run({})).toMatch(/required/i);
  });
});

describe("ToolRegistry", () => {
  const a: Tool = { name: "a", description: "tool a", kind: "read", needsApproval: false, run: async () => "a" };
  const b: Tool = { name: "b", description: "tool b", kind: "exec", needsApproval: true, run: async () => "b" };

  it("dispatches by name", async () => {
    const r = new ToolRegistry().register(a).register(b);
    expect(await r.get("b")!.run({})).toBe("b");
  });

  it("unknown tool → undefined (loop turns it into an error string)", () => {
    const r = new ToolRegistry().register(a);
    expect(r.get("ghost")).toBeUndefined();
  });

  it("describe() is stable + ordered by registration", () => {
    const r = new ToolRegistry().register(a).register(b);
    const d1 = r.describe();
    const d2 = new ToolRegistry().register(a).register(b).describe();
    expect(d1).toBe(d2);
    expect(d1.indexOf("a:")).toBeLessThan(d1.indexOf("b:"));
    expect(d1).toContain("[needs approval]");
  });
});
