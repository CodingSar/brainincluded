import type { ResolvedModel } from "./config.js";
import { Tracer } from "./trace.js";
import type { FinishReason, Gateway, Message, Stream, StreamResult, Usage } from "./types.js";

export type GatewayErrorKind = "http" | "timeout" | "network";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly kind: GatewayErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export interface GatewayDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  tracer?: Tracer;
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 120_000;

function isRetryable(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** OpenAI-compat streaming gateway with retry/backoff (PRD §3.4 / BI-003 / BI-028). */
export class OpenAICompatGateway implements Gateway {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly tracer: Tracer;
  private readonly timeoutMs: number;

  constructor(
    private readonly resolve: (modelName: string) => ResolvedModel,
    private readonly retry: RetryConfig,
    deps: GatewayDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.tracer = deps.tracer ?? new Tracer(undefined);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  stream(modelName: string, messages: Message[], signal?: AbortSignal): Stream {
    let resolveDone!: (r: StreamResult) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<StreamResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    // Mark `done` as handled so a caller that only consumes `deltas` (which already
    // surfaces the error) doesn't trip an unhandledRejection. Real awaiters still get it.
    void done.catch(() => {});
    const deltas = this.run(modelName, messages, signal, resolveDone, rejectDone);
    return { deltas, done };
  }

  private async *run(
    modelName: string,
    messages: Message[],
    signal: AbortSignal | undefined,
    resolveDone: (r: StreamResult) => void,
    rejectDone: (e: unknown) => void,
  ): AsyncGenerator<string> {
    const model = this.resolve(modelName);
    const started = this.now();
    let output = "";
    let finishReason: FinishReason = "stop";
    let usage: Usage | undefined;
    try {
      const response = await this.fetchWithRetry(model, messages, signal);
      for await (const event of parseSSE(response, signal)) {
        const choice = event.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          output += delta;
          yield delta;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (event.usage) {
          usage = { prompt: event.usage.prompt_tokens, completion: event.usage.completion_tokens };
        }
      }
      const result: StreamResult = usage ? { finishReason, usage } : { finishReason };
      this.tracer.log({
        model: model.name,
        msgCount: messages.length,
        output,
        finishReason,
        usage,
        latencyMs: this.now() - started,
      });
      resolveDone(result);
    } catch (err) {
      this.tracer.log({
        model: model.name,
        msgCount: messages.length,
        output,
        finishReason: "error",
        latencyMs: this.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      rejectDone(err);
      throw err;
    }
  }

  private async fetchWithRetry(
    model: ResolvedModel,
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${model.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (model.apiKey) headers["Authorization"] = `Bearer ${model.apiKey}`;
    const body = JSON.stringify(buildRequestBody(model, messages));

    let attempt = 0;
    for (;;) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await this.fetchFn(url, { method: "POST", headers, body, signal: composite });
        if (res.ok) return res;
        if (isRetryable(res.status) && attempt < this.retry.maxRetries) {
          await this.backoff(attempt, res.headers.get("retry-after"));
          attempt++;
          continue;
        }
        const text = await safeText(res);
        throw new GatewayError(`HTTP ${res.status}: ${text}`.trim(), "http", res.status);
      } catch (err) {
        if (err instanceof GatewayError) throw err;
        // Abort from the *external* signal is not retryable; a timeout is surfaced as timeout.
        if (isAbort(err)) {
          if (signal?.aborted) throw new GatewayError("request aborted", "network");
          if (attempt < this.retry.maxRetries) {
            await this.backoff(attempt, null);
            attempt++;
            continue;
          }
          throw new GatewayError("request timed out", "timeout");
        }
        if (attempt < this.retry.maxRetries) {
          await this.backoff(attempt, null);
          attempt++;
          continue;
        }
        throw new GatewayError(err instanceof Error ? err.message : String(err), "network");
      }
    }
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const computed = this.retry.baseDelayMs * 2 ** attempt + this.random() * this.retry.baseDelayMs;
    const headerMs = parseRetryAfter(retryAfter);
    await this.sleep(headerMs ?? computed);
  }
}

function buildRequestBody(model: ResolvedModel, messages: Message[]): Record<string, unknown> {
  const p = model.params ?? {};
  const body: Record<string, unknown> = {
    model: model.modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (p.temperature !== undefined) body["temperature"] = p.temperature;
  if (p.maxTokens !== undefined) body["max_tokens"] = p.maxTokens;
  if (p.topP !== undefined) body["top_p"] = p.topP;
  if (p.stop !== undefined) body["stop"] = p.stop;
  return body;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  return undefined;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

interface SSEChoice {
  delta?: { content?: string };
  finish_reason?: FinishReason | null;
}
interface SSEEvent {
  choices?: SSEChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Parse an OpenAI-compat `text/event-stream` body into JSON events. */
async function* parseSSE(res: Response, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  if (!res.body) throw new GatewayError("empty response body", "network");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) throw new GatewayError("request aborted", "network");
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload) as SSEEvent;
      } catch {
        // Skip non-JSON keepalive lines.
      }
    }
  }
}
