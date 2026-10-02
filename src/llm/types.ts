/** Provider-neutral shapes. The agent, tools and REPL only see these, never an SDK's types. */

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
};

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ToolResult = { toolCallId: string; content: string; isError: boolean };

export type Message =
  | { role: "user"; text: string }
  // `raw` is the provider's own reply content, sent back unchanged (Anthropic needs its thinking blocks).
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export type Reply = {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  raw?: unknown;
};

/** One LLM backend. Add a backend = add a class implementing this + a case in `createProvider`. */
export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(system: string, messages: Message[], tools: ToolSchema[]): Promise<Reply>;
}

/** Thrown for API/network failures; the REPL rolls back the turn on it. */
export class ProviderError extends Error {}
