import { readFile, stat } from "node:fs/promises";
import type { Tool } from "./types.js";

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

/** read — file contents, whole or by 1-based line range (PRD §3.3, BI-006). */
export const readTool: Tool = {
  name: "read",
  description: "Read a file's contents, optionally a line range. Output is line-numbered.",
  argsHint: `{"path": string, "start"?: number, "end"?: number}`,
  kind: "read",
  needsApproval: false,
  async run(args) {
    const path = args["path"];
    if (typeof path !== "string" || path.length === 0) {
      return "Error: 'path' (string) is required";
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      return `Error: no such file: ${path}`;
    }
    if (info.isDirectory()) {
      return `Error: '${path}' is a directory, not a file`;
    }
    if (info.size > MAX_BYTES) {
      return `Error: file too large (${info.size} bytes > ${MAX_BYTES}); read a line range instead`;
    }

    const text = await readFile(path, "utf8");
    const lines = text.split("\n");
    const start = clampLine(args["start"], 1);
    const end = clampLine(args["end"], lines.length);
    const from = Math.max(1, start);
    const to = Math.min(lines.length, end);

    const selected = lines.slice(from - 1, to);
    let truncated = false;
    let body = selected;
    if (selected.length > MAX_LINES) {
      body = selected.slice(0, MAX_LINES);
      truncated = true;
    }
    const numbered = body.map((line, i) => `${from + i}\t${line}`).join("\n");
    return truncated ? `${numbered}\n… [truncated at ${MAX_LINES} lines]` : numbered;
  },
};

function clampLine(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}
