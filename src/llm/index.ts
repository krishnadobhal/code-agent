/** Model access. Pick the backend with env vars; everything else uses the `Provider` interface. */

import { AnthropicProvider } from "./anthropic.ts";
import { DEFAULT_BASE_URL, OpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

export * from "./types.ts";

/**
 * LLM_PROVIDER = anthropic (default) | openai
 * LLM_MODEL    = model id (required for openai)
 * OPENAI_BASE_URL, OPENAI_API_KEY = for openai-compatible servers (key optional for local ones)
 */
export function createProvider(env: Record<string, string | undefined> = process.env): Provider {
  const name = env.LLM_PROVIDER ?? "anthropic";
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(env.LLM_MODEL);
    case "openai":
      if (!env.LLM_MODEL) throw new Error("LLM_PROVIDER=openai needs LLM_MODEL (e.g. a model id)");
      return new OpenAIProvider(
        env.LLM_MODEL,
        env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
        env.OPENAI_API_KEY,
      );
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}". Use "anthropic" or "openai".`);
  }
}
