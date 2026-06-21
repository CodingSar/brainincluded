# PRD / Spec — Agentic Coding CLI Harness

> Status: Draft v0.3 · Owner: CS · Last updated: 2026-06-20
> Methodology: Spec-driven, **MVP-first** — for *optimizations*. Build the smallest thing that runs a real task, hit the problems yourself; perf/reliability tuning lives in §10, don't build it up front.
> Reconciled with `architecture.md` (v0.3): the vision-doc requirements — **external memory (Postgres), subagents, skills, clarification** — are promoted to **MVP core** (owner decision 2026-06-20). They're capability requirements, not optimizations, so they're in scope from the start.

---

## 0. Locked decisions

| Axis | Decision | Notes |
|---|---|---|
| Runtime | **TypeScript / Node** | Largest agent-tooling ecosystem, fast iteration. |
| Scope | **Personal tool**, model layer **swappable**; caching + DB may be opinionated | Optimize for control + learning. |
| Default model | **Gemma 4** (local) | Released 2026-04-02, Apache-2.0. Start here. Swap freely later. |
| Other models | Local (Qwen, MiniMax, etc.) + optional frontier (Claude / Gemini / GPT) | Same harness, change config. |
| Tool protocol | **Prompted XML** (`<tool_call>` blocks, not native function-calling) | Uniform parser, any model. |
| Build philosophy | **MVP-first, no premature optimization** | Grammar-constraint, fuzzy edits, multi-tier compaction → §10, build only when you hit the wall. |

---

## 1. Goals & non-goals

### Goals
- CLI agent that completes a multi-step coding task in a real repo: read, search, edit, run shell, iterate.
- **Model-swappable** via one config value.
- Prompted XML tool-calling that's *good enough* to run a basic loop. Reliability hardening comes later, when you observe failures.
- Learn the architecture by building it — deliberately leave room to hit problems.

### Non-goals (v1)
- Not a product. No plugin market, no server, no GUI.
- No grammar-constrained decoding, per-model edit formats, or multi-tier compaction in MVP (§10).
- No native function-calling. No IDE extension.

---

## 2. Decision register

`MVP` = build now. `Later` = §10, build when you hit the problem.

| # | Decision | v1 choice | When |
|---|---|---|---|
| D1 | Agent loop | Sequential ReAct `while`, stop on no-tool-call | **MVP** |
| D2 | Tool-call format | XML envelope + JSON args + `<think>` | **MVP** |
| D3 | Tool-call reliability | Strict parser + **re-ask on malformed** | **MVP** (grammar-constraint → Later) |
| D4 | Edit strategy | **Search/replace blocks**, exact match | **MVP** (per-model fmt + fuzzy apply → Later) |
| D5 | **LLM gateway** | One OpenAI-compat client + named model registry; local & cloud = config only | **MVP — core** |
| D6 | Local serving | **Ollama** (OpenAI-compat endpoint) | **MVP** |
| D7 | Compaction | **Drop-oldest + one summarize pass** | **MVP basic** (best algo → research Later) |
| D8 | Caching | Stable prefix discipline; provider does the rest | **MVP** (explicit `cache_control` tuning → Later) |
| D9 | Persistence + memory | **Postgres** — durable transcript + agent memory store; **Redis** hot/working layer | **MVP — core** (§3.7) |
| D10 | MCP | none | **Later / maybe** |
| D11 | Sandbox | Approval prompt before bash + writes | **MVP** (git snapshot, Docker → Later) |
| D12 | Routing/escalation | manual `--model` only | **MVP** (auto-routing → §5 + Later) |
| D13 | Terminal UI | **Ink** (React for terminals) | **MVP** |
| D14 | Subagents | parent spawns isolated-context child via `task` tool; no recursion | **MVP — core** (§3.10) |
| D15 | Skills | extensible capability packs (instructions ± tools), loaded on demand | **MVP — core** (§3.11) |
| D16 | Clarification | `ask_user` tool — agent pauses to disambiguate before acting | **MVP — core** (§3.12) |
| D17 | Tool registry | extensible: register tool by `{name,schema,run}`, no core edits | **MVP** (§3.5/BI-005) |

---

## 3. MVP spec (build this first)

Smallest harness that completes a real task. Everything else waits.

### 3.1 The loop
```
turn(userMessage):
  messages.append(userMessage)
  for i in range(MAX_ITERATIONS):     # e.g. 25
    text = stream(provider, messages)        # render live
    calls = parseToolCalls(text)
    if calls.empty: return text              # ← done
    for call in calls:
      if needsApproval(call) and not askUser(call):
        messages.append(result(call, "denied by user"))
        continue
      messages.append(result(call, execute(call)))   # errors go in as text too
  return "hit max iterations"
```
- **Stop**: no tool-call (primary) · max iterations · Ctrl-C.
- **Error-as-feedback**: failed/denied tools append an error *string*, never throw. The model reads it and adapts. This one rule does a lot of work — keep it from day one.

### 3.2 Tool format (D2)
```
<think> reasoning </think>
<tool_call>
  <name>edit</name>
  <args>{"path":"src/x.ts","old":"...","new":"..."}</args>
</tool_call>
```
- Parser: regex/scan for `<tool_call>…</tool_call>`, parse `<name>` + JSON `<args>`.
- Malformed → append error "your tool call didn't parse, re-emit it" and loop. (That's the whole reliability story for MVP. Grammar-constraint only if this proves too flaky — §10.)

### 3.3 Tools (D4, D11, D14, D16) — MVP set
| Tool | Does | Approval? |
|---|---|---|
| `read` | read file (whole, or by line range) | no |
| `list` / `glob` | list dir / match files | no |
| `grep` | search file contents | no |
| `bash` | run shell command (capture stdout/stderr, timeout) | **yes** |
| `write` | write whole file | **yes** |
| `edit` | search/replace block, **exact match** | **yes** |
| `ask_user` | pause + ask the user a clarifying question (§3.12) | no (it *is* the prompt) |
| `task` | spawn an isolated-context subagent for a bounded subtask (§3.10) | no |
| `remember` / `recall` | write a durable fact to / read facts from memory store (§3.9) | no |

Edit = exact-string find/replace. If SEARCH text not found → error-as-feedback, model retries. No fuzzy matching yet (you'll feel when you need it).
Tools are registered via the extensible registry (D17) — adding a tool is one `{name,schema,run}` entry, no core changes. **Skills** (§3.11) can also contribute tools.

### 3.4 LLM Gateway (D5) — the core abstraction

**This is the heart of the project.** Models — local or cloud — are interchangeable plugins behind one gateway. The harness never knows or cares whether a model runs on localhost or behind an API key; that's a config difference only.

**Design principle: the harness speaks ONE protocol — OpenAI Chat Completions — to everything.**
- Local (Ollama / vLLM / llama.cpp): already OpenAI-compat → base URL, no key.
- OpenAI / GPT: native.
- Anthropic / Gemini: expose OpenAI-compat endpoints → same client, different base URL + key.

So the gateway = **one OpenAI client + a named model registry**. Swap models by name; zero per-provider code in MVP.

```ts
interface Gateway {
  // yields text deltas; returns terminal metadata (finish_reason + usage) when the stream ends
  stream(modelName: string, messages: Message[]): AsyncIterable<string> & { done: Promise<StreamResult> }
}
type StreamResult = { finishReason: "stop"|"length"|"tool_calls"|"content_filter"; usage?: { prompt: number; completion: number } }
// MVP impl: registry → {baseUrl, apiKey, modelId, params} → openai client → stream w/ retry+backoff (§3.4.1)
```
Every model collapses to "stream text in, parse XML tool calls out" (§3.2), so models are swappable with **zero special-casing**. Start by pointing it at one model (e.g. local Ollama, or a cloud key you have). Add registry entries to plug in more.

> Caveat (→ §10): OpenAI-compat endpoints don't pass through *every* native feature — Anthropic explicit prompt-caching, reasoning/thinking blocks, exact token counts. When you need those, add a **native adapter** for that one provider, or front everything with a **LiteLLM proxy** (external process, OpenAI→100+ providers, key mgmt + fallback + routing). Earned-later, not MVP.

### 3.5 Context (D7) — basic
- Keep full transcript until near the model's context limit.
- When over budget: **drop oldest tool results** (keep user messages + recent turns), or do **one summarize call** that replaces old history with a paragraph. Pick whichever is simpler to write first.
- Don't build tiers, LRU archives, or sub-agent compaction yet — §10.

### 3.6 Caching (D8) — just don't break it
- Keep a **stable prompt prefix**: system prompt → tool descriptions → (then) conversation.
- Never reorder/edit the prefix mid-session; put volatile stuff (timestamps) at the end.
- That's it. Providers (and Ollama's KV cache) reward a stable prefix automatically. Explicit `cache_control` breakpoints = Later.

### 3.7 Persistence + memory (D9) — core

Two distinct concerns, both Postgres-backed; Redis is the hot/working layer.

1. **Transcript persistence** (durable conversation log): every message → `messages` table keyed by session. Resume = replay rows. Survives restarts; queryable.
2. **Agent memory store** (the "write important things to a dedicated place logically" requirement, architecture.md line 24): curated *facts* the agent decides are worth keeping beyond one session — project conventions, decisions, file locations, user preferences. Written via the `remember` tool (or by compaction, §3.5), recalled via `recall` into context when relevant.

**Stores:**
- **Postgres** = durable truth: `sessions`, `messages` (transcript), `memories` (facts).
- **Redis** = hot/working layer: recent-context cache, fast recall lookups, dedup of in-flight tool calls. MVP-optional but designed-in (degrade gracefully if absent).

**`memories` shape (MVP, keep simple):**
```
id · scope(global|project) · project_key · text · tags[] · source(session_id) · created_at
```
Recall by tag/text match for MVP. Semantic/embedding recall → §10 (build when text match isn't enough). See §3.9 for the read/write flow.

### 3.9 Memory flow (D9)
- **Write**: agent calls `remember(text, tags, scope)` → row in `memories`. Compaction (§3.5) may also distill dropped context into a memory rather than losing it ("compact + write to dedicated place" — architecture.md).
- **Read**: on session start (and on `recall(query)`), pull relevant memories for the current project/scope into the stable prefix region *below* the system prompt. Keep it bounded (top-K) so it doesn't blow the budget.
- **Seam**: a `MemoryStore` interface (`remember/recall/list`) — Postgres impl for MVP; the interface keeps embedding-backed recall a drop-in later.

### 3.10 Subagents (D14)
- `task(prompt, allowedTools?)` spawns a **child agent with a fresh, isolated context window**, its own loop (reuses §3.1), restricted tool set, and returns **only its final result string** to the parent. Keeps the parent's context clean for bounded subtasks (search, summarize a dir, run+interpret tests).
- **Hard rule: no recursion** — a subagent cannot spawn a subagent. Enforced in the registry (child gets a tool set without `task`).
- **Auto-deny approvals** in children, or inherit parent policy — start with auto-deny anything mutating, return the would-be action to the parent.

### 3.11 Skills (D15)
- A **skill** = a named, extensible capability pack: task-specific instructions (a prompt fragment) ± optional tools ± metadata (`name`, `description`, `when_to_use`). Think reusable "how to do X" modules.
- **Discovery**: skills live in a skills dir / registry; their `description`s are surfaced to the agent cheaply (name + one line). The full skill body is **loaded into context on demand** (when the agent picks it, or it matches the task) — not all loaded up front (token-frugal, §1).
- **MVP shape**: skill = a markdown file with frontmatter (`name`, `description`, `when_to_use`) + body of instructions; optional `tools:` list registered when the skill loads. Keep the loader simple; richer skill packaging → §10.

### 3.12 Clarification — `ask_user` (D16)
- `ask_user(question)` lets the agent **pause and disambiguate before acting** instead of guessing. The loop renders the question in the Ink TUI, blocks for input, appends the answer as the tool result, and continues.
- Mechanically it's just another tool in the loop (§3.1) — but it's the core of "the agent makes good autonomous choices" (architecture.md): autonomy includes knowing when to ask.
- Guardrail: cap consecutive `ask_user` calls so it can't interrogate endlessly; in `full-auto` mode, `ask_user` may be disabled or auto-answered "proceed with best guess."

### 3.13 Config — model registry + settings
The registry is the gateway's plugin list. Each entry = one swappable model, local or cloud, behind one OpenAI-compat protocol.
```jsonc
{
  "defaultModel": "local",
  "models": {
    // Per-entry baseUrl+key = direct-to-provider. OR point every entry at one
    // LiteLLM proxy URL (shared key) and let modelId select — see "Gateway topology" below.
    "local":  { "baseUrl": "http://localhost:11434/v1", "modelId": "gemma4:31b",
                "contextWindow": 256000, "params": { "temperature": 0.2 } },
    "gpt":    { "baseUrl": "https://api.openai.com/v1", "modelId": "gpt-5",
                "apiKeyEnv": "OPENAI_API_KEY", "contextWindow": 400000 },
    "claude": { "baseUrl": "https://api.anthropic.com/v1", "modelId": "claude-opus-4-8",
                "apiKeyEnv": "ANTHROPIC_API_KEY", "contextWindow": 200000 },
    "gemini": { "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "modelId": "gemini-2.5-pro",
                "apiKeyEnv": "GEMINI_API_KEY", "contextWindow": 1000000 }
  },
  "maxIterations": 25,
  "approval": "ask",              // ask | auto-edit | full-auto
  "retry":    { "maxRetries": 4, "baseDelayMs": 500 },  // backoff on 429/5xx (§3.4.1)
  "postgres": { "urlEnv": "DATABASE_URL" },     // durable transcript + memory store (§3.7)
  "redis":    { "urlEnv": "REDIS_URL" },        // hot/working layer; optional, degrade if absent
  "skillsDir": ".bi/skills",                    // extensible skill packs (§3.11)
  "memory":   { "recallTopK": 8, "scope": "project" },  // §3.9
  "logFile":  ".bi/trace.jsonl"                 // raw request/response trace (§3.4.2); off if unset
}
```
Swap model: `--model gpt` or change `defaultModel`. Add a model: one registry entry. Secrets (API keys, DB/Redis URLs) come from env, never the file.

**Per-entry fields**: `contextWindow` (required — feeds budgeting/compaction, §3.5/BI-020), `params` (optional generation params — `temperature`, `maxTokens`, `topP`, `stop` — merged over harness defaults), `apiKeyEnv` (omit for keyless local).

#### Gateway topology — direct vs LiteLLM proxy
Two ways to wire the registry, **same gateway code** either way:
- **Direct** (above): each entry has its own `baseUrl` + `apiKeyEnv`. Harness talks to each provider's OpenAI-compat endpoint.
- **LiteLLM proxy** (earn when you want central key-mgmt / fallback / load-balance): run LiteLLM as an external process; point **every** entry at the *same* `baseUrl` (the proxy) with one shared `apiKeyEnv`; `modelId` selects the upstream the proxy routes to. Then the proxy owns fallback/load-balance/budget — so **do NOT also build harness-side router rungs 2–3 (§5)**; that's the proxy's job. Pick one router, not both.

### 3.4.1 Gateway resilience — retry & finish_reason
- **Retry/backoff**: on HTTP 429 / 5xx / connection-reset, retry with exponential backoff (`retry.baseDelayMs * 2^n`, jitter), honor `Retry-After` when present, cap at `maxRetries`. Non-retryable (400/401/403/404) → fail fast, typed error. Cloud providers and the LiteLLM proxy rate-limit constantly; without this every limit kills a turn.
- **`finish_reason`**: the gateway surfaces the stream's terminal reason. `length` = **truncation** = context overflow → signal the loop to compact (§3.5) and not parse the cut-off XML as final. `tool_calls`/`stop` = normal. `content_filter` → error-as-feedback.
- **Token usage**: capture the response `usage{prompt,completion,total}` when the gateway returns it (LiteLLM always does) → feed budgeting (BI-020) as ground truth; fall back to the estimator only when absent.

### 3.4.2 Tool-result role + tracing
- **Tool-result role**: prompted-XML means no native `tool_calls`. **Decision: tool results re-enter as `role:"user"` text** wrapped in a `<tool_result name=…>…</tool_result>` envelope — uniform across every model, no provider needs native tool-role support. (Native `role:"tool"` only matters if you later add a native-tool adapter, §10.)
- **Tracing**: when `logFile` set, append one JSONL line per gateway request/response (model, messages hash, raw output text, finish_reason, usage, latency). This is the debugging lifeline for XML format-drift (§7 gotcha #2) — you cannot fix drift you can't see.

---

## 4. Architecture

```
Ink TUI  →  Agent Loop  →  Tool Registry (extensible, D17)
   │             │            read/write/edit/bash/grep/glob/list
   │             │            ask_user · task(subagent) · remember/recall
   │             ├─ Context Manager (budget + compaction → memory)
   │             ├─ Tool Parser (streaming XML)
   │             ├─ Permission Gate (approval modes)
   │             ├─ Skills loader (on-demand packs, D15)
   │             ├─ Subagent spawner (isolated ctx, no recursion, D14)
   │             └─ Router (D12) → LLM Gateway (OpenAI-compat, D5)
   │                                ├─ Ollama / vLLM (local)
   │                                └─ Anthropic / OpenAI / Gemini (cloud)
   └─ Memory & Persistence (D9)
        ├─ Postgres: sessions · messages (transcript) · memories (facts)
        └─ Redis: hot/working cache (optional)
```
MVP collapses Router to "always the configured model" and Context Manager to "drop-oldest (distill to memory)." Grow each box when it hurts. Everything in this diagram is MVP-scope except the Router's auto-rungs (§5, Later).

---

## 5. Routing, escalation & chain-of-thought (the part you hadn't mapped)

You asked what a local-default + frontier-escalation setup looks like, and how CoT fits. Here's the architecture — **none of it is MVP**, but designing the seams now keeps it cheap later.

### 5.1 Routing — escalating ladder of complexity
The `Provider` interface already abstracts "which model." Routing is just **a function that picks a Provider before (or during) a turn.** Build up the ladder only as far as you need:

| Rung | What | Effort | Signal it uses |
|---|---|---|---|
| 0 | **Manual** — `--model` per session | trivial (MVP) | you decide |
| 1 | **Static rule** — task type → model (e.g. "explain" → local, "refactor across repo" → frontier) | small | keyword / command |
| 2 | **Difficulty escalation** — try local; on failure, re-run the *same task* on frontier | medium | a failure signal (see below) |
| 3 | **Model-as-router** — a tiny fast model reads the task first, picks the model | medium | LLM judgment |

The hard part of rung 2 isn't the routing — it's the **failure signal**: how do you know local failed and should escalate?
- tests still red after N edit attempts
- model looping (identical consecutive tool calls)
- hit max iterations with no final answer
- model self-reports low confidence / asks for help
- explicit user `/escalate`

Architecturally: wrap the loop so that on a failure signal it **restarts the turn with a different Provider, same message history**. The history is already model-agnostic (it's text + tool results), so escalation is "swap the Provider, replay." That's the payoff of D5.

### 5.2 Chain-of-thought — where reasoning lives
CoT in this harness = the model emits reasoning before its tool call. Two architectural choices:

1. **Where it goes**: inside the `<think>…</think>` block (already in the format, §3.2). You render it to the user, you **do not execute it**, and you decide whether it stays in history.
2. **Keep or strip between turns**:
   - *Keep* → better multi-step coherence, but more tokens, and for some models stale reasoning **amplifies looping**.
   - *Strip after each turn* → cheaper, less coherent.
   - **Default**: keep the current turn's thinking, strip older `<think>` blocks during compaction. Simple and safe.
3. **Reasoning models** (when you swap one in): Kimi-Thinking, MiniMax-M2 etc. interleave thinking natively — you **must** strip stale `<think>` consistently or tool-call parsing drifts. Gemma 4 doesn't force this, so it's a non-issue for the MVP default.

> Net: CoT needs almost nothing in MVP (the `<think>` block + "don't execute it"). Routing needs nothing in MVP (rung 0). Both have clean seams (the format + the Provider interface) so you can grow into rungs 1–3 without a rewrite.

---

## 6. Model matrix — *examples to register, not a driver*

> Models are interchangeable plugins behind the gateway (§3.4). This table is a menu of things you *can* register, not a spec commitment. Local-model specifics (VRAM, quant) are config details — pick whatever you have; swap freely. The harness doesn't care.

Convenient starting default: **Gemma 4 31B dense** or **26B A4B MoE** (Apache-2.0, local, multimodal). MoE = 3.8B active → faster; dense = higher quality. Or just register a cloud key and skip local entirely.

| Model | Size (total/active) | Ctx | License | Coding / agentic | Notes |
|---|---|---|---|---|---|
| **Gemma 4 31B** | 31B dense | 256K | Apache-2.0 | good coding, **weaker agentic** (Agentic Index ~42) | **MVP default**; strong on SciCode / TerminalBench-Hard |
| **Gemma 4 26B A4B** | 26B / 3.8B | 256K | Apache-2.0 | similar, faster | MoE, lower latency |
| Gemma 4 E2B / E4B | 2.3B / 4.5B | 128K | Apache-2.0 | weak agentic | edge/CPU; toy loops only |
| Qwen3-Coder-30B-A3B | 30.5B / 3.3B | 256K | Apache-2.0 | **stronger agentic** | swap-in when Gemma's tool-use frustrates you |
| MiniMax-M2 | 230B / 10B | ~200K | MIT | strong, best VRAM/capability | workstation |
| GLM-4.6 | 357B / 32B | 200K | MIT | best prompted-XML fit | workstation |
| Frontier (Claude/Gemini/GPT) | — | — | proprietary | zero-shot, best | escalation target (§5) |

> Gemma 4 trades agentic strength for being your Apache-2.0 starting point. Expect tool-call drift on long loops — that's a *feature* for learning where the harness needs hardening. Swap to Qwen3-Coder-30B if it gets in the way.

---

## 7. Known gotchas (don't pre-solve — recognize when they bite)
1. Context degrades before the advertised window; KV cache grows → prune.
2. **Tool-call format drift** = #1 failure. MVP answer = re-ask. If unbearable → grammar-constraint (§10).
3. Looping/repetition near ctx limits or after errors → cap tool-calls, detect identical consecutive calls, strip stale `<think>`.
4. Wrong chat template silently tanks quality → use the model's official template (Ollama ships it; verify ctx length).
5. Below Q4 quant, tool-call adherence degrades → Q4 floor for the driver model.

---

## 8. Reference harnesses (read when stuck)
| Harness | License | Steal |
|---|---|---|
| **opencode** | MIT | overall TS structure, tool registry, provider abstraction. Best blueprint. |
| **Aider** | Apache-2.0 | search/replace edit format; per-model mapping (Later) |
| **Codex CLI** | Apache-2.0 | approval modes; context-anchored patch apply |
| **Cline** | Apache-2.0 | XML prompted tool-calls; diff-approval UX |
| **Claude Code** | proprietary | compaction tiers (Later, deep-dives only) |

---

## 9. Milestones

- **M0 — Walking skeleton**: Ink TUI shell (input + streaming output + y/n approval) + agent loop + gateway (one model) + `read` + `bash` + XML parser + `ask_user`. Completes "read this file, run the tests, tell me what failed" and can ask a clarifying question.
- **M1 — Edits**: `write` + `edit` (exact search/replace) + `glob`/`grep`/`list`. Completes a real single-file change end to end.
- **M2 — Memory + persistence**: Postgres (sessions/messages transcript + resume) + `memories` store with `remember`/`recall` + basic compaction that distills to memory (§3.5/§3.9) + Redis hot layer (optional) + Ctrl-C interrupt. Daily-drivable, remembers across sessions.
- **M3 — Subagents + skills**: `task` subagent spawn (isolated ctx, no recursion) + skills loader (on-demand packs). Agent delegates subtasks and gains reusable capabilities.
- **M4 — Multi-provider**: Anthropic + OpenAI + Gemini via gateway. Same task runs local *or* frontier via `--model`. (Unlocks §5 rung 0→1.)
- **M5+ — Earn the optimizations**: pull items from §10 *only* as you hit their problem.

---

## 10. Backlog / research-later (do NOT build up front)
Pull from here when a real problem forces it. Each is noted with the symptom that justifies building it.

- **Grammar-constrained decoding** (GBNF/XGrammar) — when re-ask loops too often on malformed tool calls.
- **Per-model edit formats** (udiff/diff-fenced/V4A) + **fuzzy/progressive apply** — when exact search/replace fails too much on a given model.
- **Multi-tier compaction** (snip + section summarize + sub-agent) — when the basic drop-oldest loses important context. ← *flagged research topic: survey best compaction algorithms here.*
- **Explicit prompt-cache breakpoints** (`cache_control`) + hit-rate measurement — when API cost matters.
- **Routing rungs 1–3 + escalation** (§5) — when you're tired of picking models by hand.
- **Embedding/semantic memory recall** — when tag/text match (§3.9) stops surfacing the right facts.
- **Git-snapshot rollback** before mutating steps — when a bad edit costs you.
- **MCP client shim** — when you want external tools (DBs, GitHub) without writing integrations.
- **Docker sandbox** — when you let it run untrusted/destructive commands unattended.

> Moved OUT of this list into MVP core (per architecture.md, 2026-06-20): subagents (§3.10), skills (§3.11), clarification (§3.12), Postgres/Redis memory (§3.7).

---

## 11. Open questions
- [x] TUI: **Ink from MVP** (D13). Watch the one gotcha — fast streaming tokens jank Ink's re-render; throttle deltas (~30–60ms batches) and render finalized scrollback via `<Static>`, keep only the live region in reactive state.
- [x] Target VRAM / default model: **non-blocking config detail** — gateway is model-agnostic (D5). Register whatever you have. Resolved.
- [ ] Compaction research (§10): which algorithm — when you get there.
- [ ] First model to wire for M0: a local Ollama model, or a cloud API key you already hold?

---

## Appendix — sourcing & a correction
**Correction logged**: an earlier research pass wrongly flagged "Gemma 4" as hallucinated blogspam. **Gemma 4 is real** — released 2026-04-02, Apache-2.0, sizes E2B/E4B/26B-A4B-MoE/31B-dense, 128K–256K ctx, multimodal. The model landscape moves faster than any fixed knowledge cutoff (Gemma 4, Qwen3.5 both post-date the assistant's Jan-2026 training). **Always verify model specs against the official source before locking a choice**, and distrust *both* stale priors and SEO blogspam — confirm against vendor cards / artificialanalysis.ai.

Sources: [Google Gemma 4 announcement](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) · [Artificial Analysis: Gemma 4](https://artificialanalysis.ai/articles/gemma-4-everything-you-need-to-know) · [LM Studio model card](https://lmstudio.ai/models/gemma-4)
