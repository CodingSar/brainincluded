import { readFileSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";

const GenParams = z
  .object({
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().optional(),
    stop: z.array(z.string()).optional(),
  })
  .strict();

const ModelEntry = z
  .object({
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    apiKeyEnv: z.string().optional(),
    contextWindow: z.number().int().positive(),
    params: GenParams.optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    defaultModel: z.string().min(1),
    models: z.record(z.string(), ModelEntry),
    maxIterations: z.number().int().positive().default(25),
    approval: z.enum(["ask", "auto-edit", "full-auto"]).default("ask"),
    retry: z
      .object({
        maxRetries: z.number().int().nonnegative().default(4),
        baseDelayMs: z.number().int().positive().default(500),
      })
      .strict()
      .default({ maxRetries: 4, baseDelayMs: 500 }),
    logFile: z.string().optional(),
    postgres: z.object({ urlEnv: z.string() }).strict().optional(),
    redis: z.object({ urlEnv: z.string() }).strict().optional(),
    skillsDir: z.string().optional(),
    memory: z
      .object({ recallTopK: z.number().int().positive(), scope: z.enum(["global", "project"]) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((c) => c.defaultModel in c.models, {
    message: "defaultModel must name a key in models",
  });

export type ModelEntryT = z.infer<typeof ModelEntry>;
export type Config = z.infer<typeof ConfigSchema>;

/** A model entry with its API key resolved from the environment (never serialized). */
export interface ResolvedModel extends ModelEntryT {
  name: string;
  apiKey?: string;
}

const DEFAULT_CONFIG: Config = {
  defaultModel: "local",
  models: {
    local: {
      baseUrl: "http://localhost:11434/v1",
      modelId: "gemma4:31b",
      contextWindow: 256000,
      params: { temperature: 0.2 },
    },
  },
  maxIterations: 25,
  approval: "ask",
  retry: { maxRetries: 4, baseDelayMs: 500 },
};

export class ConfigError extends Error {}

/** Parse + validate a JSONC config object. Returns documented defaults on `undefined`. */
export function parseConfig(text: string | undefined): Config {
  if (text === undefined) return DEFAULT_CONFIG;
  const errors: ParseError[] = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ConfigError(`malformed JSONC config at offset ${errors[0]!.offset}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new ConfigError(`invalid config: ${first.path.join(".")} — ${first.message}`);
  }
  return result.data;
}

/** Load config from disk; missing file → defaults. */
export function loadConfig(path?: string): Config {
  if (!path) return DEFAULT_CONFIG;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  return parseConfig(text);
}

/**
 * Resolve the active model: `override` (--model) beats `defaultModel`.
 * Reads the API key from env only — keys never live in the config file.
 */
export function resolveModel(config: Config, override?: string): ResolvedModel {
  const name = override ?? config.defaultModel;
  const entry = config.models[name];
  if (!entry) {
    const available = Object.keys(config.models).join(", ");
    throw new ConfigError(`unknown model '${name}'. Available: ${available || "(none)"}`);
  }
  const apiKey = entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;
  return { ...entry, name, apiKey };
}
