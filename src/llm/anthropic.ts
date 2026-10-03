/** Claude via the Anthropic SDK. The only module that imports `@anthropic-ai/sdk`. */

import Anthropic from "@anthropic-ai/sdk";
import {
  type CompleteOptions,
  type Message,
  type Provider,
  ProviderError,
  type Reply,
  type ToolSchema,
} from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic | undefined;

  constructor(model = DEFAULT_MODEL) {
    this.model = model;
  }

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSchema[],
    { onText, signal }: CompleteOptions = {},
  ): Promise<Reply> {
    this.client ??= new Anthropic(); // reads ANTHROPIC_API_KEY or an `ant auth login` profile
    try {
      // streaming avoids request timeouts at this max_tokens
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 64000,
          system,
          messages: messages.map(toParam),
          tools,
          thinking: { type: "adaptive" },
          // On a safety-classifier refusal, the server retries on Anthropic's recommended model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      if (onText) stream.on("text", (delta) => onText(delta));
      return toReply(await stream.finalMessage());
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ProviderError(error.message, { cause: error });
      }
      throw error;
    }
  }
}

function toParam(m: Message): Anthropic.Beta.BetaMessageParam {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.text };
    case "tool":
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: r.isError,
        })),
      };
    case "assistant":
      // raw keeps thinking blocks, which must go back unchanged while tools are in use
      if (m.raw) return { role: "assistant", content: m.raw as Anthropic.Beta.BetaContentBlock[] };
      return {
        role: "assistant",
        content: [
          ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool_use" as const,
            id: c.id,
            name: c.name,
            input: c.input,
          })),
        ],
      };
  }
}

function toReply(response: Anthropic.Beta.BetaMessage): Reply {
  const reason = response.stop_reason;
  return {
    text: response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
    toolCalls: response.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
    stop:
      reason === "tool_use" || reason === "max_tokens" || reason === "refusal" ? reason : "end",
    raw: response.content,
  };
}
