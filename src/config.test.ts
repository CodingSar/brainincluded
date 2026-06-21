import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig, resolveModel } from "./config.js";

const VALID = `{
  // trailing comma + comment to prove JSONC
  "defaultModel": "local",
  "models": {
    "local": { "baseUrl": "http://localhost:11434/v1", "modelId": "gemma4:31b", "contextWindow": 256000 },
    "gpt":   { "baseUrl": "https://api.openai.com/v1", "modelId": "gpt-5", "apiKeyEnv": "OPENAI_API_KEY", "contextWindow": 400000 },
  },
}`;

describe("parseConfig", () => {
  it("parses a valid JSONC registry", () => {
    const c = parseConfig(VALID);
    expect(c.defaultModel).toBe("local");
    expect(Object.keys(c.models)).toEqual(["local", "gpt"]);
    expect(c.maxIterations).toBe(25); // default applied
    expect(c.retry.maxRetries).toBe(4);
  });

  it("undefined input → documented defaults", () => {
    const c = parseConfig(undefined);
    expect(c.defaultModel).toBe("local");
    expect(c.models.local).toBeDefined();
  });

  it("malformed JSONC → ConfigError", () => {
    expect(() => parseConfig("{ this is not json")).toThrow(ConfigError);
  });

  it("contextWindow required per entry", () => {
    const bad = `{ "defaultModel": "x", "models": { "x": { "baseUrl": "http://h/v1", "modelId": "m" } } }`;
    expect(() => parseConfig(bad)).toThrow(/contextWindow/);
  });

  it("defaultModel not in models → error", () => {
    const bad = `{ "defaultModel": "ghost", "models": { "x": { "baseUrl": "http://h/v1", "modelId": "m", "contextWindow": 1000 } } }`;
    expect(() => parseConfig(bad)).toThrow(ConfigError);
  });
});

describe("resolveModel", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it("--model override beats defaultModel", () => {
    const c = parseConfig(VALID);
    expect(resolveModel(c).name).toBe("local");
    expect(resolveModel(c, "gpt").name).toBe("gpt");
  });

  it("unknown --model → error naming available models", () => {
    const c = parseConfig(VALID);
    expect(() => resolveModel(c, "nope")).toThrow(/Available: local, gpt/);
  });

  it("resolves apiKey from env only", () => {
    process.env = { ...env, OPENAI_API_KEY: "sk-secret" };
    const c = parseConfig(VALID);
    expect(resolveModel(c, "gpt").apiKey).toBe("sk-secret");
    expect(resolveModel(c, "local").apiKey).toBeUndefined();
  });

  it("api key never appears in a JSON-serialized config", () => {
    process.env = { ...env, OPENAI_API_KEY: "sk-secret" };
    const c = parseConfig(VALID);
    expect(JSON.stringify(c)).not.toContain("sk-secret");
  });
});
