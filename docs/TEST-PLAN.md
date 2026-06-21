# Test Plan

> Companion to `docs/PRD.md` + `backlog.md`. How to test an agentic harness so the implementation lands the desired result.

## 0. Core principle

**The LLM is non-deterministic. Do NOT unit-test model quality.** Test the **deterministic seams** around the model: the parser, tools, gateway plumbing, and loop control flow. Make the model itself a **scripted fake** so the loop becomes deterministic and fully assertable.

What this means:
- ✅ Test: does the loop execute the tool the model asked for, in order, and feed the result back?
- ✅ Test: does a malformed tool call get fed back as an error and recovered?
- ❌ Don't test: does the model choose the *right* tool / write *correct* code? (That's eval, §5 — separate, not CI gating.)

## 1. The linchpin: a scripted fake gateway

The real `Gateway.stream()` hits a model. Tests inject a **fake** implementing the same interface that replays predetermined assistant turns. This converts the whole agent loop into a deterministic state machine.

```ts
// test/helpers/fakeGateway.ts
function fakeGateway(turns: string[]): Gateway {
  let i = 0
  return {
    async *stream() {
      const turn = turns[i++] ?? ""          // each call = one assistant message
      for (const chunk of chunkify(turn)) yield chunk   // simulate streaming
    }
  }
}
```

Drive the loop with scripted turns:
```ts
const gw = fakeGateway([
  `<tool_call><name>read</name><args>{"path":"a.txt"}</args></tool_call>`,  // turn 1
  `The file says hello.`                                                     // turn 2 (no call → stop)
])
const result = await runTurn(gw, registryWithTmpFs, "what's in a.txt?")
expect(toolLog).toEqual([{name:"read", args:{path:"a.txt"}}])  // tool ran
expect(result).toContain("hello")                              // clean stop
```

This single helper unlocks deterministic tests for: stop conditions, ordering, error-as-feedback, denial handling, max-iterations, malformed recovery (BI-009).

## 2. Test layers (the pyramid)

| Layer | What | Determinism | Tooling | Tickets |
|---|---|---|---|---|
| **Unit (most)** | parser, edit match, config, each tool, compaction, memory store, skills loader | pure / tmp fs | Vitest | BI-002,004,006,007,013,014,015,016,018,024,027 |
| **Integration** | agent loop with **fake gateway**: clarify, subagents | scripted | Vitest + fakeGateway | BI-009,008,019,022,023,026 |
| **Gateway** | OpenAI-compat HTTP/SSE plumbing | mocked HTTP | Vitest + `nock`/`msw` | BI-003,021 |
| **DB/memory** | Postgres transcript + memory; Redis degrade | disposable schema | Vitest + testcontainers | BI-017,024,025 |
| **TUI** | Ink render + input + approval + ask_user | mocked gateway | `ink-testing-library` | BI-010,023 |
| **E2E (few, manual)** | real model on a sample repo task | non-deterministic | scripted CLI run | smoke only, not CI-gating |
| **Eval (separate)** | model task success rate | non-deterministic | task suite + scorer | §5, out of CI |

Highest ROI: **parser (BI-004)** and **loop (BI-009)**. Most bugs + most behavior live there. Write those first and thorough.

## 3. Stack & conventions

- **Runner**: Vitest (fast, ESM-native, TS, good mocks).
- **FS tests**: real tmp dir per test (`os.tmpdir()` + cleanup) or `memfs`. Never touch the repo's own files.
- **HTTP**: `nock` or `msw` — **zero real network in CI.**
- **Ink**: `ink-testing-library` (`render`, `lastFrame()`, `stdin.write`).
- **No real model in CI.** Real-model runs are a separate manual/nightly script.
- **Determinism rules**: no wall-clock/random in tested logic (inject a clock/rng); fixed fixtures; each test isolated.
- Coverage target: parser + loop + tools near-100%; UI/gateway lighter (plumbing).

## 4. What each PRD behavior maps to (traceability)

| PRD behavior | Guaranteed by test |
|---|---|
| Stop on no-tool-call (§3.1) | BI-009 scripted "final text" turn |
| Error-as-feedback (§3.1) | BI-009 malformed + denied + throwing-tool cases |
| Max-iterations, no hang (§3.1) | BI-009 always-tool-call → terminates |
| XML parse robustness (§3.2) | BI-004 malformed/fenced/multi cases |
| Exact edit + retry on miss (§3.3) | BI-013 not-found → error, file unchanged |
| Approval gating (§3.7) | BI-008 deny → not executed |
| Model swappable, history model-agnostic (§3.4, §5) | BI-022 swap mid-session + replay |
| Gateway = one protocol, no branching (§3.4) | BI-003/021 same code, different base URL |
| Basic compaction keeps user msgs (§3.5) | BI-018 user-msg-never-dropped case |
| Compaction distills to memory, not lost (§3.5/§3.9) | BI-018 distill-path memory row written |
| Cache-stable prefix (§3.6) | BI-011 byte-identical prefix |
| Durable transcript + resume (§3.7) | BI-017 resume reconstructs across restart |
| Memory remember/recall + bounded top-K (§3.9) | BI-024 round-trip + top-K bound |
| Memory store is a swappable seam (§3.9) | BI-024 fake in-memory store passes same tests |
| Redis optional, graceful degrade (§3.7) | BI-025 Redis-absent → features still work |
| Subagent isolated context, no recursion (§3.10) | BI-026 isolation + child-has-no-`task` |
| Skills loaded on demand, token-frugal (§3.11) | BI-027 discovery surfaces name+desc only |
| Clarification pauses + resumes with answer (§3.12) | BI-023 ask_user answer injected → loop continues |

If a PRD behavior has no row here, it's not yet guaranteed — add a ticket/test before claiming it works.

## 5. Eval (separate from CI — the "did it actually work" layer)

Unit/integration prove the *harness* is correct. They do **not** prove a *model* completes real tasks. For that, keep a tiny **eval suite** run manually (not CI-gating, model-dependent + flaky):
- 3–5 fixture repos + tasks with checkable outcomes (a test goes green, a string appears in a file).
- Run the real harness + real model; score pass/fail.
- Track scores across models (gateway swap) → this is where §5 routing/escalation decisions get data.
- Grow into the §10 compaction-algorithm research harness.

## 6. Definition of done (per ticket)
1. Acceptance criteria in the ticket met.
2. Tests at the right layer green (deterministic, no network, no real model).
3. New PRD behavior has a traceability row (§4).
4. `npm test` green; types strict.
