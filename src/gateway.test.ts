import { describe, expect, it, vi } from "vitest";
import type { ResolvedModel } from "./config.js";
import { GatewayError, OpenAICompatGateway, type RetryConfig } from "./gateway.js";
import type { Message } from "./types.js";

const MODEL: ResolvedModel = {
  name: "test",
  baseUrl: "http://host/v1",
  modelId: "m1",
  contextWindow: 1000,
  apiKey: "sk-key",
  params: { temperature: 0.3, maxTokens: 64, stop: ["</tool_call>"] },
};

const MSGS: Message[] = [{ role: "user", content: "hi" }];
const RETRY: RetryConfig = { maxRetries: 4, baseDelayMs: 500 };

function sseResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function chunk(content?: string, finish?: string, usage?: object): string {
  const choice: Record<string, unknown> = { delta: content ? { content } : {} };
  if (finish) choice["finish_reason"] = finish;
  const event: Record<string, unknown> = { choices: [choice] };
  if (usage) event["usage"] = usage;
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function collect(deltas: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of deltas) out.push(d);
  return out;
}

describe("OpenAICompatGateway", () => {
  it("yields deltas in order and resolves finishReason + usage", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        chunk("Hel"),
        chunk("lo"),
        chunk(undefined, "stop"),
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    const gw = new OpenAICompatGateway(() => MODEL, RETRY, { fetch: fetchFn });
    const stream = gw.stream("test", MSGS);
    expect(await collect(stream.deltas)).toEqual(["Hel", "lo"]);
    const result = await stream.done;
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ prompt: 5, completion: 2 });
  });

  it("sends base URL, Authorization header, and params from the registry entry", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      sseResponse(["data: [DONE]\n\n"]),
    );
    const gw = new OpenAICompatGateway(() => MODEL, RETRY, { fetch: fetchFn });
    await collect(gw.stream("test", MSGS).deltas);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://host/v1/chat/completions");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-key");
    const sent = JSON.parse(init!.body as string);
    expect(sent.model).toBe("m1");
    expect(sent.temperature).toBe(0.3);
    expect(sent.max_tokens).toBe(64);
    expect(sent.stop).toEqual(["</tool_call>"]);
    expect(sent.stream).toBe(true);
  });

  it("surfaces finish_reason=length (truncation signal)", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([chunk("partial"), chunk(undefined, "length"), "data: [DONE]\n\n"]),
    );
    const gw = new OpenAICompatGateway(() => MODEL, RETRY, { fetch: fetchFn });
    const stream = gw.stream("test", MSGS);
    await collect(stream.deltas);
    expect((await stream.done).finishReason).toBe("length");
  });

  it("retries on 429 then succeeds, with growing backoff", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      if (n <= 2) return new Response("rate limited", { status: 429 });
      return sseResponse([chunk("ok"), "data: [DONE]\n\n"]);
    });
    const gw = new OpenAICompatGateway(() => MODEL, RETRY, { fetch: fetchFn, sleep, random: () => 0 });
    expect(await collect(gw.stream("test", MSGS).deltas)).toEqual(["ok"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]); // base*2^0, base*2^1, jitter=0
  });

  it("honors Retry-After over computed backoff", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      if (n === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      return sseResponse([chunk("ok"), "data: [DONE]\n\n"]);
    });
    const gw = new OpenAICompatGateway(() => MODEL, RETRY, { fetch: fetchFn, sleep, random: () => 0 });
    await collect(gw.stream("test", MSGS).deltas);
    expect(delays).toEqual([2000]);
  });

  it("does not retry on 401", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const gw = new OpenAICompatGateway(() => MODEL, RETRY, { fetch: fetchFn });
    await expect(collect(gw.stream("test", MSGS).deltas)).rejects.toMatchObject({
      kind: "http",
      status: 401,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries on persistent 500 then throws typed error", async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));
    const retry: RetryConfig = { maxRetries: 2, baseDelayMs: 1 };
    const gw = new OpenAICompatGateway(() => MODEL, retry, { fetch: fetchFn, sleep, random: () => 0 });
    await expect(collect(gw.stream("test", MSGS).deltas)).rejects.toBeInstanceOf(GatewayError);
    expect(fetchFn).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
