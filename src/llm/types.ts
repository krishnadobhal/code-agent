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
  usage?: Usage;
};

/** Tokens for one call, or a running total. `input` excludes cached tokens. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(total: Usage, u: Usage): void {
  total.input += u.input;
  total.output += u.output;
  total.cacheRead += u.cacheRead;
  total.cacheWrite += u.cacheWrite;
}

/** One LLM backend. Add a backend = add a class implementing this + a case in `createProvider`. */
export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(system: string, messages: Message[], tools: ToolSchema[], opts?: CompleteOptions): Promise<Reply>;
  /** Model ids this backend's key or server can use. */
  listModels(): Promise<string[]>;
}

/** Levels both Anthropic and OpenAI accept. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** `onText` gets streamed text; `signal` cancels; `effort` is sent only when set (old models reject it). */
export type CompleteOptions = { onText?: (delta: string) => void; signal?: AbortSignal; effort?: Effort };

/** Thrown for API/network failures; the REPL rolls back the turn on it. */
export class ProviderError extends Error {}
