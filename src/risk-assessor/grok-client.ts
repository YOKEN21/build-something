import type { ModelProvider, ModelRequest, ModelResult, TokenUsage } from "./types";

/**
 * One logical Grok request, with a timeout and bounded retries.
 *
 * The call follows the current xAI Responses API:
 * - https://docs.x.ai/developers/model-capabilities/text/structured-outputs
 * - https://docs.x.ai/developers/model-capabilities/text/best-practices
 * - https://docs.x.ai/developers/model-capabilities/text/comparison
 * - https://docs.x.ai/developers/model-capabilities/text/generate-text
 * - https://docs.x.ai/developers/rest-api-reference/inference/responses
 *
 * POST https://api.x.ai/v1/responses
 * Structured output uses text.format type json_schema with strict true.
 * Chat Completions is deprecated, so this client does not call it.
 * The key is sent only in the Authorization header and is never written to a log field.
 */

export const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
export const DEFAULT_MODEL = "grok-4.7";
export const DEFAULT_TIMEOUT_MS = 900_000;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_REASONING_EFFORT = "high";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function retryDelayMs(attempt: number, random: () => number): number {
  const base = 500 * 2 ** (attempt - 1);
  const jitter = Math.floor(random() * base);
  return Math.min(8000, jitter);
}

export function buildResponsesBody(request: ModelRequest, effort: string): object {
  return {
    model: request.model,
    store: false,
    temperature: 0.7,
    top_p: 0.95,
    max_output_tokens: 4096,
    reasoning: { effort },
    input: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "risk_judgment",
        strict: true,
        schema: request.schema,
      },
    },
  };
}

export function extractOutputText(payload: unknown): { text?: string; refusal: boolean; incomplete: boolean } {
  if (payload === null || typeof payload !== "object") {
    return { refusal: false, incomplete: false };
  }
  const record = payload as Record<string, unknown>;
  const incomplete = record.status === "incomplete" || record.status === "failed";
  const output = record.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item === null || typeof item !== "object") {
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "refusal") {
        return { refusal: true, incomplete };
      }
      if (!Array.isArray(entry.content)) {
        continue;
      }
      for (const part of entry.content) {
        if (part !== null && typeof part === "object" && (part as { type?: string }).type === "refusal") {
          return { refusal: true, incomplete };
        }
      }
    }
  }
  if (incomplete) {
    return { refusal: false, incomplete: true };
  }
  if (typeof record.output_text === "string" && record.output_text.length > 0) {
    return { text: record.output_text, refusal: false, incomplete: false };
  }
  if (!Array.isArray(output)) {
    return { refusal: false, incomplete: false };
  }
  const chunks: string[] = [];
  for (const item of output) {
    if (item === null || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) {
      continue;
    }
    for (const part of (item as { content: unknown[] }).content) {
      if (part !== null && typeof part === "object") {
        const piece = part as { type?: string; text?: string };
        if (piece.type === "output_text" && typeof piece.text === "string") {
          chunks.push(piece.text);
        }
      }
    }
  }
  if (chunks.length === 0) {
    return { refusal: false, incomplete: false };
  }
  return { text: chunks.join(""), refusal: false, incomplete: false };
}

function usageOf(payload: unknown): TokenUsage {
  if (payload === null || typeof payload !== "object") {
    return { input_tokens: null, output_tokens: null, reasoning_tokens: null };
  }
  const usage = (payload as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") {
    return { input_tokens: null, output_tokens: null, reasoning_tokens: null };
  }
  const record = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
  const reasoning = record.output_tokens_details?.reasoning_tokens;
  return {
    input_tokens: typeof record.input_tokens === "number" ? record.input_tokens : null,
    output_tokens: typeof record.output_tokens === "number" ? record.output_tokens : null,
    reasoning_tokens: typeof reasoning === "number" ? reasoning : null,
  };
}

function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function grokProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  reasoningEffort?: string;
}): ModelProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, options.maxAttempts ?? MAX_ATTEMPTS));
  const effort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;

  return async (request: ModelRequest): Promise<ModelResult> => {
    if (options.apiKey.length === 0) {
      return { ok: false, reason: "XAI_API_KEY is not set", attempts: 0, usage: null };
    }
    let lastReason = "model request failed";
    let lastUsage: TokenUsage | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetchImpl(XAI_RESPONSES_URL, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildResponsesBody(request, effort)),
        });
        if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
          lastReason = `HTTP ${response.status}`;
          await sleep(retryDelayMs(attempt, random));
          continue;
        }
        if (!response.ok) {
          return { ok: false, reason: `HTTP ${response.status}`, attempts: attempt, usage: null };
        }
        const payload = (await response.json()) as unknown;
        lastUsage = usageOf(payload);
        const extracted = extractOutputText(payload);
        if (extracted.refusal || extracted.incomplete || extracted.text === undefined) {
          lastReason = extracted.refusal ? "model refusal" : "malformed or incomplete model output";
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs(attempt, random));
            continue;
          }
          return { ok: false, reason: lastReason, attempts: attempt, usage: lastUsage };
        }
        const parsed = parseModelJson(extracted.text);
        if (!parsed.ok) {
          lastReason = "malformed model output";
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs(attempt, random));
            continue;
          }
          return { ok: false, reason: lastReason, attempts: attempt, usage: lastUsage };
        }
        return { ok: true, content: parsed.value, attempts: attempt, usage: lastUsage };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("real network call attempted")) {
          throw error;
        }
        lastReason = "model request failed";
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs(attempt, random));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, reason: lastReason, attempts: maxAttempts, usage: lastUsage };
  };
}
