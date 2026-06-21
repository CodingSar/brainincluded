# Backlog

> Tickets derived from `docs/PRD.md` (v0.3). MVP core now includes memory/subagents/skills/clarification (architecture.md). M0→M3 detailed, M4+ lighter.
> Each ticket: **Goal · Scope · Acceptance criteria · Tests**. Test strategy in `docs/TEST-PLAN.md`.
> Status: `todo` · `wip` · `done` · `blocked`. ID = `BI-NNN`.

---

## Epic M0 — Walking skeleton
*Exit: completes "read this file, run the tests, tell me what failed" via Ink TUI against one model.*

### BI-001 · Project scaffold · `done`
**Goal**: runnable TS project with test + build + run wiring.
**Scope**: `package.json`, `tsconfig` (ESM, strict), Vitest, Ink + React, eslint/prettier, `bin` entry, `npm run dev`/`build`/`test`.
**Acceptance**:
- `npm run dev` launches an Ink app that renders and exits clean.
- `npm test` runs Vitest green on a placeholder test.
- Strict TS, no `any` in committed code.
**Tests**: smoke test — app module imports + renders without throw (`ink-testing-library`).

### BI-002 · Config + model registry loader · `done`
**Goal**: load config (§3.8) — model registry, defaults, settings.
**Scope**: parse JSONC config file; resolve `apiKeyEnv`→env; `--model <name>` override; validate shape (incl. per-entry `contextWindow` required, `params` optional); apply `retry`/`logFile` defaults; sane defaults.
**Acceptance**:
- Valid config → typed `Config` object.
- Missing file → documented defaults.
- Unknown `--model` → clear error naming available models.
- API keys read from env only, never logged.
**Tests** (unit, deterministic):
- parses valid registry; resolves key from env.
- `--model` override beats `defaultModel`.
- unknown model name → throws with helpful message.
- malformed JSONC → clear parse error.
- key never appears in serialized/logged output.

### BI-003 · LLM Gateway (OpenAI-compat stream) · `done`
**Goal**: `Gateway.stream(modelName, messages) → AsyncIterable<string>` + terminal `{finishReason, usage}` (§3.4).
**Scope**: one OpenAI-compat client; look up model in registry; apply per-entry `params`; SSE stream → yield text deltas; capture `finish_reason` + `usage`; timeout + error surfacing. Retry/backoff lives in BI-028.
**Acceptance**:
- Given a registry entry, streams assistant text deltas in order; exposes terminal `finishReason` + `usage` when present.
- Per-entry `params` (temperature/maxTokens/stop) sent on the request.
- Network/HTTP error → typed error, not a crash.
- Works against any OpenAI-compat base URL (local, cloud, **or a LiteLLM proxy**) with no per-provider branching — proxy entries share one baseUrl, modelId selects upstream.
**Tests** (HTTP mocked via `nock`/`msw`):
- mocked SSE chunks → deltas yielded in order, concatenation correct.
- correct base URL + `Authorization` header + `params` per registry entry.
- terminal `finish_reason=length` and `usage` surfaced from the final chunk.
- mid-stream HTTP 500 → typed error surfaced, iterator ends.
- request timeout → typed timeout error.
- *(no real network in CI)*

### BI-028 · Gateway resilience — retry/backoff + finish_reason wiring · `done`
**Goal**: survive rate-limits + detect truncation (§3.4.1) — correctness, not optimization.
**Scope**: wrap BI-003 requests with exponential backoff + jitter on 429/5xx/conn-reset, honor `Retry-After`, cap at `retry.maxRetries`; non-retryable (400/401/403/404) → fail fast. Surface `finishReason` to the loop: `length` → flag context-overflow (trigger compaction BI-018, don't treat cut XML as final); `content_filter` → error-as-feedback.
**Acceptance**:
- 429 then 200 → request succeeds after backoff; total attempts ≤ `maxRetries`+1.
- `Retry-After` header respected when present.
- 401/400 → no retry, typed error immediately.
- `finishReason=length` → loop receives overflow signal, not a "final answer".
**Tests** (mocked clock + mocked HTTP):
- 429×2 then 200 → succeeds, backoff delays grow, attempt count correct.
- 500 exhausts retries → typed error after `maxRetries`.
- 401 → zero retries.
- `Retry-After: 2` honored over computed backoff.
- `length` finish → overflow flag set (fake loop asserts compaction triggered).

### BI-029 · Gateway trace logging · `done`
**Goal**: raw request/response trace for debugging XML format-drift (§3.4.2, §7 gotcha #2).
**Scope**: when `logFile` set, append one JSONL line per gateway call — model, msg-count, **raw output text**, finishReason, usage, latencyMs. Redact secrets (never log keys/headers). No-op when unset.
**Acceptance**:
- `logFile` set → one well-formed JSONL row per turn with raw output + finishReason + usage.
- secrets never appear in trace.
- unset → no file written, zero overhead.
**Tests**: row shape valid JSONL; api-key string absent from output; unset → no write.

### BI-004 · XML tool-call parser · `done`
**Goal**: extract tool calls from raw assistant text (§3.2).
**Scope**: scan `<tool_call><name>…</name><args>{json}</args></tool_call>`; ignore `<think>`; return `{name,args}[]` + leftover prose; flag malformed.
**Acceptance**:
- 0, 1, N tool calls parsed correctly.
- `<think>` content excluded from calls + from executed output.
- Malformed (missing close tag, bad JSON args, unknown structure) → `Malformed` result, not throw.
**Tests** (unit, pure — highest-value, most cases):
- zero calls → prose only.
- single + multiple calls in one message.
- `<think>` block ignored.
- malformed: missing `</tool_call>`, invalid JSON args, empty `<name>`, nested/garbled → each flagged malformed, never throws.
- tool-call text wrapped in markdown fences ```` ```xml ```` still parses (common drift).
- whitespace/newline variations tolerated.

### BI-005 · Tool registry + interface · `done`
**Goal**: uniform tool definition + dispatch.
**Scope**: `Tool = {name, description, schema, needsApproval, run(args)→string}`; registry lookup; unknown tool → error result.
**Acceptance**:
- Register tools; dispatch by name.
- Unknown tool name → error string (fed back, §3.1), not throw.
- Tool descriptions assemble into the system prompt.
**Tests**:
- dispatch routes to correct tool.
- unknown tool → error result string.
- registry → tool-description block is stable/ordered (cache prefix, §3.6).

### BI-006 · `read` tool · `done`
**Goal**: read file whole or by line range.
**Scope**: read; optional `start`/`end` lines; large-file truncation with marker; missing file → error.
**Acceptance**: returns content (+ line numbers); range works; missing/dir path → error string.
**Tests** (tmp fs): whole read; range read; missing file → error; directory path → error; large file truncated with marker.

### BI-007 · `bash` tool · `done`
**Goal**: run shell command, capture output.
**Scope**: spawn; capture stdout+stderr; timeout (kill on exceed); exit code; size cap on output.
**Acceptance**: returns combined output + exit code; timeout kills + returns timeout error; non-zero exit captured (not thrown).
**Tests**: `echo` output captured; non-zero exit → captured w/ code; sleep-beyond-timeout → killed + timeout error; huge output truncated. *(Use harmless commands; no network.)*

### BI-008 · Permission gate + approval · `done`
**Goal**: gate tools needing approval (§3.7).
**Scope**: modes `ask|auto-edit|full-auto`; for `needsApproval` tools in `ask` → prompt y/n; denial → error-as-feedback string.
**Acceptance**:
- `ask`: approval-required tool prompts; deny → "denied by user" result, tool NOT run.
- `auto-edit`/`full-auto`: bypass per policy.
- read-only tools never prompt.
**Tests** (inject a fake prompt fn, no real TUI):
- deny → tool not executed, error string returned.
- approve → tool executes.
- `full-auto` → no prompt, executes.
- read tool → never prompts regardless of mode.

### BI-009 · Agent loop · `done`
**Goal**: the core turn loop (§3.1) — **the integration linchpin**.
**Scope**: iterate ≤`maxIterations`; stream→parse→(approve)→execute→append; stop on no-tool-call; error-as-feedback for failures/denials/malformed.
**Acceptance**:
- No tool-call in a turn → loop ends, returns final text.
- Tool calls execute in order; results appended as messages.
- Failed/denied/malformed tool → error string appended, loop continues.
- Hits `maxIterations` → terminates with a clear message (no infinite loop).
**Tests** (**fake gateway**, scripted turns — see TEST-PLAN):
- scripted: 1 tool call → result → final text. Assert tool ran, transcript shape, clean stop.
- multi-step: 3 sequential tool calls then finish. Assert order + termination.
- malformed turn → error fed back → next turn succeeds.
- denied tool → error fed back, loop continues.
- gateway always emits a tool call → stops at `maxIterations`, no hang.
- tool throws → caught, error-as-feedback, loop survives.

### BI-010 · Ink TUI shell · `done`
**Goal**: input box + streaming output + approval prompt (§D13).
**Scope**: input component; streaming assistant render; tool-call/result display; y/n approval; **throttle deltas (~30–60ms) + `<Static>` for scrollback** (gotcha).
**Acceptance**:
- Type prompt → see streamed assistant output.
- Approval prompt appears for gated tools; y/n routes to permission gate.
- Fast token stream doesn't flicker/jank (throttled + Static).
**Tests** (`ink-testing-library`):
- input submit → triggers a turn (gateway mocked).
- streamed deltas render incrementally.
- approval prompt renders + selection invokes gate callback.
- finalized lines go to `<Static>` (don't re-render on new deltas).

### BI-011 · System prompt assembly · `done`
**Goal**: build the stable prompt prefix (§3.2, §3.6).
**Scope**: persona + instructions + tool descriptions + XML format spec + 0–1 few-shot; **stable ordering** for cache.
**Acceptance**: deterministic prefix; tool list reflects registry; volatile content (cwd, time) at the tail not the prefix.
**Tests**: same registry → byte-identical prefix across runs; volatile data placed after prefix; format-spec block present.

### BI-023 · `ask_user` clarification tool · `done`
**Goal**: agent pauses to disambiguate before acting (§3.12, D16).
**Scope**: `ask_user(question)` tool → loop renders question in Ink, blocks for input, appends answer as tool result, continues. Cap consecutive `ask_user` calls; `full-auto` disables or auto-answers.
**Acceptance**:
- agent emits `ask_user` → loop surfaces question, waits, injects answer, resumes.
- consecutive-ask cap enforced (no endless interrogation).
- `full-auto` → no blocking prompt.
**Tests** (fake gateway + injected input fn):
- scripted `ask_user` turn → answer injected as result → loop continues with it.
- N+1 consecutive asks → capped.
- `full-auto` mode → not blocking, auto-answer path taken.

---

## Epic M1 — Edits
*Exit: completes a real single-file change end to end.*

### BI-012 · `write` tool · `todo`
**Goal**: write whole file (approval-gated).
**Tests** (tmp fs): create new file; overwrite existing; creates parent dirs; needsApproval=true honored.

### BI-013 · `edit` tool (exact search/replace) · `todo`
**Goal**: exact-string find/replace block (§3.3), approval-gated.
**Acceptance**: SEARCH found uniquely → replaced; not found → error-as-feedback; multiple matches → error (ambiguous) unless policy defined.
**Tests** (unit + tmp fs, **high-value**):
- exact single match → replaced correctly.
- SEARCH not present → error string (model retries), file unchanged.
- multiple matches → ambiguity error, file unchanged.
- empty SEARCH / empty REPLACE handled.
- multiline SEARCH block matches exactly.
- whitespace-sensitive mismatch → fails cleanly (documents why fuzzy is §10).

### BI-014 · `glob` tool · `todo`
**Tests** (tmp fs): pattern matches expected files; ignores `.git`/`node_modules` per config; no match → empty (not error).

### BI-015 · `grep` tool · `todo`
**Tests** (tmp fs): finds matches w/ file:line; regex honored; no match → empty result; binary files skipped.

### BI-016 · `list` tool · `todo`
**Tests** (tmp fs): lists dir entries; marks dirs vs files; missing path → error.

---

## Epic M2 — Memory + persistence
*Exit: daily-drivable, remembers across sessions. Postgres-backed transcript + memory store.*

### BI-017 · Postgres persistence + resume · `todo`
**Goal**: durable transcript in Postgres; resume = replay rows (§3.7, D9).
**Scope**: `sessions` + `messages` tables; migrations; append each message; load by session id. Connection from `DATABASE_URL` env.
**Acceptance**:
- each message persisted as a row keyed by session.
- resume reconstructs transcript identically across process restart.
- DB unreachable → clear startup error (not silent data loss).
**Tests** (Postgres via testcontainers or a disposable test schema; no prod DB):
- append → row present; ordering preserved.
- resume reconstructs identical transcript.
- migration idempotent (run twice → no error).
- connection failure → typed error surfaced.

### BI-024 · Agent memory store (`remember`/`recall`) · `todo`
**Goal**: curated durable facts written to a dedicated place, recalled into context (§3.9, D9).
**Scope**: `memories` table (`scope`, `project_key`, `text`, `tags[]`, `source`, `created_at`); `MemoryStore` interface (`remember/recall/list`); `remember`/`recall` tools; on-session-start recall top-K into prefix region below system prompt.
**Acceptance**:
- `remember(text,tags,scope)` → persisted fact.
- `recall(query)` → tag/text-matched facts, bounded top-K.
- session start auto-recalls relevant project memories into context (bounded).
- `MemoryStore` is an interface (embedding impl is a later drop-in, §10).
**Tests**:
- remember → recall round-trip by tag + by text.
- top-K bound respected (never floods context).
- scope filtering (global vs project) correct.
- interface seam: a fake in-memory `MemoryStore` satisfies the same tests (proves swappability).

### BI-025 · Redis hot/working layer (optional) · `todo`
**Goal**: fast cache layer; degrade gracefully if absent (§3.7, D9).
**Scope**: recent-context cache + recall lookup cache + in-flight tool-call dedup; `REDIS_URL` env; **no-op fallback** when unconfigured.
**Acceptance**: present → cache hit path used; absent → harness fully functional via Postgres only.
**Tests**: cache hit returns cached value; **Redis absent → all features still work** (degrade path); dedup suppresses identical in-flight call.

### BI-018 · Basic compaction (distill to memory) · `todo`
**Goal**: drop-oldest or single summarize pass near budget; **distill dropped context into a memory** rather than losing it (§3.5, §3.9).
**Acceptance**: over-budget transcript shrinks below threshold; user messages + recent N turns preserved; `<think>` from old turns stripped; important dropped context optionally written to `memories`.
**Tests** (deterministic — fake token counter + fake summarizer gateway + fake MemoryStore):
- under budget → no change.
- over budget → oldest tool results dropped first, recent N kept.
- user messages never dropped.
- summarize path → old history replaced by summary message, count drops.
- stale `<think>` stripped from retained old turns.
- distill path → a memory row written for dropped salient content.

### BI-019 · Ctrl-C interrupt · `todo`
**Goal**: AbortController cancels in-flight stream, re-enter loop with partial state (§3.1).
**Tests**: abort signal mid-stream → gateway iterator stops; partial assistant text retained; next input works.

### BI-020 · Context/token budgeting · `todo`
**Goal**: track tokens vs model context window; trigger compaction.
**Scope**: window = registry `contextWindow`; use gateway `usage.prompt` (BI-003) as ground truth when present, estimator as fallback; threshold (e.g. 80%) triggers BI-018; `finishReason=length` (BI-028) forces compaction regardless of estimate.
**Tests**: estimator monotonic with content; threshold crossing triggers BI-018; per-model window from registry; real `usage` preferred over estimate; `length` finish forces compaction.

---

## Epic M3 — Subagents + skills
*Exit: agent delegates subtasks and gains reusable capabilities.*

### BI-026 · Subagent spawn (`task` tool) · `todo`
**Goal**: parent spawns isolated-context child agent (§3.10, D14).
**Scope**: `task(prompt, allowedTools?)` → child runs its own loop (reuses BI-009) with fresh context + restricted tool set, returns **only final result string** to parent. **No recursion**: child tool set excludes `task`. Children auto-deny mutating approvals (return would-be action).
**Acceptance**:
- `task` runs a child loop, returns its result into the parent transcript.
- child context isolated (parent history not injected wholesale).
- child cannot spawn a subagent (registry omits `task`).
- child mutating action without approval → returned to parent, not executed.
**Tests** (fake gateway scripts parent + child turns):
- parent `task` call → child runs scripted turns → result string returned to parent.
- child registry has no `task` (recursion blocked).
- child context isolation: parent's prior messages absent from child prompt.
- child mutating tool in non-auto mode → deferred, not executed.

### BI-027 · Skills loader · `todo`
**Goal**: extensible capability packs loaded on demand (§3.11, D15).
**Scope**: `skillsDir`; each skill = markdown + frontmatter (`name`, `description`, `when_to_use`) + body, optional `tools:`. Surface name+description cheaply to agent; load full body into context on selection; register skill tools when loaded.
**Acceptance**:
- skills discovered from dir; only name+desc surfaced up front (token-frugal).
- selecting a skill loads its body into context + registers its tools.
- malformed skill file → skipped with warning, not a crash.
**Tests** (tmp skillsDir):
- discovery lists name+desc only (body not in prefix).
- load injects body + registers declared tools.
- malformed frontmatter → skipped + warned.
- two skills with same name → deterministic resolution + warning.

---

## Epic M4 — Multi-provider
*Exit: same task runs local OR frontier via `--model`.*

### BI-021 · Verify cloud gateway entries · `todo`
**Goal**: Anthropic/Gemini/OpenAI via OpenAI-compat base URLs (§3.4).
**Tests** (mocked endpoints per provider quirks): each registry entry streams correctly through the *same* gateway code; document any feature not passed through (caching/thinking/token-count) → links §10.

### BI-022 · Model switch (routing rung 0–1) · `todo`
**Goal**: `--model` + optional static rule routing (§5).
**Tests**: `--model X` selects entry X; history is model-agnostic (swap mid-session, replay works) — proves §5 escalation seam.

---

## Future epics (§10 backlog — build when the problem bites)
- **BI-E1 Grammar-constrained decoding** (GBNF/XGrammar) — when re-ask loops too often.
- **BI-E2 Per-model edit formats + fuzzy apply** — when exact match fails too much.
- **BI-E3 Multi-tier compaction + algo research** — when basic compaction loses context.
- **BI-E4 Explicit prompt-cache breakpoints + hit-rate metrics** — when cost matters.
- **BI-E5 Routing rungs 2–3 + failure-signal escalation** (§5).
- **BI-E6 Embedding/semantic memory recall** — when tag/text match (BI-024) stops surfacing the right facts.
- **BI-E7 Git-snapshot rollback** — when a bad edit costs you.
- **BI-E8 MCP client shim** — when you want external tools.
- **BI-E9 Docker sandbox** — when running untrusted commands unattended.

> Promoted to MVP (per architecture.md, 2026-06-20), no longer "future": subagents (BI-026), skills (BI-027), Postgres/Redis memory (BI-017/024/025), clarification (BI-023).
