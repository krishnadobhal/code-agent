/**
 * Any OpenAI-compatible Chat Completions API: OpenAI, Ollama, OpenRouter, Groq, LM Studio, ...
 * The only module that imports the `openai` SDK.
 */

import OpenAI from "openai";
import {
  type CompleteOptions,
  type Message,
  type Provider,
  ProviderError,
  type Reply,
  type ToolCall,
  type ToolSchema,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private client: OpenAI | undefined;

  constructor(model: string, baseUrl = DEFAULT_BASE_URL, apiKey?: string) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSchema[],
    { onText, signal, effort }: CompleteOptions = {},
  ): Promise<Reply> {
    // The SDK requires a key; local servers (Ollama, LM Studio) ignore it.
    this.client ??= new OpenAI({ apiKey: this.apiKey ?? "not-needed", baseURL: this.baseUrl });

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      const stream = this.client.chat.completions.stream(
        {
          model: this.model,
          messages: [{ role: "system", content: system }, ...messages.flatMap(toChat)],
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          ...(effort ? { reasoning_effort: effort } : {}),
        },
        { signal },
      );
      if (onText) stream.on("content", (delta) => onText(delta));
      completion = await stream.finalChatCompletion();
    } catch (error) {
      if (error instanceof OpenAI.OpenAIError) {
        throw new ProviderError(`${this.baseUrl}: ${error.message}`, { cause: error });
      }
      throw error;
    }

    const choice = completion.choices[0];
    if (!choice) throw new ProviderError("Response had no choices");
    const msg = choice.message;
    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((c) => c.type === "function")
      .map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }));

    let stop: Reply["stop"] = "end";
    if (msg.refusal || choice.finish_reason === "content_filter") stop = "refusal";
    else if (toolCalls.length) stop = "tool_use"; // some servers say "stop" even with tool calls
    else if (choice.finish_reason === "length") stop = "max_tokens";

    return { text: msg.content ?? msg.refusal ?? "", toolCalls, stop };
  }

  async listModels(): Promise<string[]> {
    this.client ??= new OpenAI({ apiKey: this.apiKey ?? "not-needed", baseURL: this.baseUrl });
    const ids: string[] = [];
    try {
      for await (const m of this.client.models.list()) ids.push(m.id);
    } catch (error) {
      if (error instanceof OpenAI.OpenAIError) throw new ProviderError(`${this.baseUrl}: ${error.message}`, { cause: error });
      throw error;
    }
    return ids.sort();
  }
}

function toChat(m: Message): OpenAI.Chat.ChatCompletionMessageParam[] {
  switch (m.role) {
    case "user":
      return [{ role: "user", content: m.text }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        },
      ];
    case "tool":
      // Chat Completions has no is_error flag, so mark failures in the text.
      return m.results.map((r) => ({
        role: "tool" as const,
        tool_call_id: r.toolCallId,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      }));
  }
}

function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (error) {
    // Abort the turn rather than run a tool with garbage input.
    throw new ProviderError(`Model sent invalid tool arguments: ${json.slice(0, 200)}`, {
      cause: error,
    });
  }
}
