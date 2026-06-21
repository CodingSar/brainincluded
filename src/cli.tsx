#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { loadConfig, resolveModel, type Config } from "./config.js";
import { OpenAICompatGateway } from "./gateway.js";
import { buildSessionContext, buildSystemPrompt } from "./prompt.js";
import { Tracer } from "./trace.js";
import { bashTool } from "./tools/bash.js";
import { readTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";
import type { ApprovalMode } from "./permission.js";
import { App } from "./ui/App.js";
import { Controller } from "./ui/controller.js";
import type { Message } from "./types.js";

interface Args {
  model?: string;
  config?: string;
  approval?: ApprovalMode;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--approval") args.approval = argv[++i] as ApprovalMode;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "bi — agentic coding CLI harness",
      "",
      "Usage: bi [--model <name>] [--config <path>] [--approval ask|auto-edit|full-auto]",
      "",
      "  --model     model registry entry to use (default: config.defaultModel)",
      "  --config    path to JSONC config (default: ./bi.config.jsonc, else built-in defaults)",
      "  --approval  approval mode (default: config.approval)",
      "",
    ].join("\n"),
  );
}

function buildRegistry(): ToolRegistry {
  // ask_user is injected by the Controller (bound to the TUI prompt).
  return new ToolRegistry().register(readTool).register(bashTool);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let config: Config;
  let model;
  try {
    config = loadConfig(args.config ?? "bi.config.jsonc");
    model = resolveModel(config, args.model);
  } catch (err) {
    process.stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const registry = buildRegistry();
  const gateway = new OpenAICompatGateway((name) => resolveModel(config, name), config.retry, {
    tracer: new Tracer(config.logFile),
  });

  const seed: Message[] = [
    { role: "system", content: buildSystemPrompt(registry) },
    { role: "user", content: buildSessionContext(process.cwd()) },
  ];

  const controller = new Controller({
    gateway,
    registry,
    model: model.name,
    maxIterations: config.maxIterations,
    approval: args.approval ?? config.approval,
    seed,
  });

  render(<App controller={controller} />);
}

main();
