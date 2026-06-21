import { spawn } from "node:child_process";
import type { Tool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;

/** bash — run a shell command, capture stdout+stderr (PRD §3.3, BI-007). Approval-gated. */
export const bashTool: Tool = {
  name: "bash",
  description: "Run a shell command. Captures combined stdout/stderr and the exit code.",
  argsHint: `{"cmd": string, "timeoutMs"?: number}`,
  kind: "exec",
  needsApproval: true,
  async run(args) {
    const cmd = args["cmd"];
    if (typeof cmd !== "string" || cmd.length === 0) {
      return "Error: 'cmd' (string) is required";
    }
    const timeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : DEFAULT_TIMEOUT_MS;
    return runShell(cmd, timeoutMs);
  },
};

function runShell(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    let timedOut = false;

    const append = (buf: Buffer) => {
      if (output.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      output += buf.toString("utf8");
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error: failed to spawn command: ${err.message}`);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const tail = truncated ? "\n… [output truncated]" : "";
      if (timedOut) {
        resolve(`Error: command timed out after ${timeoutMs}ms (killed)\n${output}${tail}`);
        return;
      }
      const status = code === null ? `killed by ${signal}` : `exit ${code}`;
      resolve(`[${status}]\n${output}${tail}`);
    });
  });
}
