# brainincluded

Agentic coding CLI harness for open-weight models behind an OpenAI-compatible gateway
(local Ollama/vLLM, cloud APIs, or a LiteLLM proxy — config only).

See [`docs/PRD.md`](docs/PRD.md) for the spec and [`backlog.md`](backlog.md) for tickets.

## Status — M0 (walking skeleton)

Implemented:

- **Agent loop** — streaming ReAct: stream → parse XML tool calls → approve → execute → feed result back; stops on no-tool-call / max-iterations. Error-as-feedback throughout (`src/loop.ts`).
- **LLM gateway** — one OpenAI-compat streaming client + named model registry; retry/backoff on 429/5xx with `Retry-After`; `finish_reason` + token `usage` surfaced; JSONL trace (`src/gateway.ts`).
- **Tools** — `read`, `bash`, `ask_user` via an extensible registry (`src/tools/`).
- **Permission gate** — `ask | auto-edit | full-auto` (`src/permission.ts`).
- **Config** — JSONC model registry, env-only secrets, `--model` override (`src/config.ts`).
- **Ink TUI** — streaming output, scrollback, approval + clarification prompts (`src/ui/`).

## Develop

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit (incl. tests)
npm run build     # → dist/
npm run dev       # launch the TUI (tsx)
```

## Run

```bash
cp bi.config.example.jsonc bi.config.jsonc   # edit models
node dist/cli.js --model local               # or: npm run dev
```

Flags: `--model <name>`, `--config <path>`, `--approval ask|auto-edit|full-auto`, `--help`.
