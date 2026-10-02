/** Agent loop: call the model, run the tools it asks for, repeat until it answers. */

import type { Message, Provider, ToolCall, ToolResult } from "./llm/index.ts";
import * as safety from "./safety.ts";
import * as tools from "./tools/index.ts";

const SYSTEM = `You are a coding agent running in the user's terminal.
Working directory: ${process.cwd()}
Platform: ${process.platform}
Use the tools to inspect and change files. Keep answers short.`;

const PREVIEW_CHARS = 120; // how much of a tool's input to echo to the terminal

/** Run one user turn to the final answer; appends to `messages` in place (tests pass a fake provider). */
export async function runTurn(messages: Message[], provider: Provider): Promise<string> {
  while (true) {
    const reply = await provider.complete(SYSTEM, messages, tools.SCHEMAS);

    if (reply.stop === "refusal") {
      messages.push({ role: "assistant", text: "(declined)", toolCalls: [] });
      return "[The model declined this request]";
    }

    // a max_tokens cut mid tool call leaves a dangling tool_use; fixed by streaming (ROADMAP step 3)
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });

    if (reply.stop !== "tool_use") return reply.text;

    // one at a time, since a call may stop to ask the user
    const results: ToolResult[] = [];
    for (const call of reply.toolCalls) results.push(await execute(call));
    messages.push({ role: "tool", results });
  }
}

/** Run one tool call and wrap the outcome as a tool result. */
export async function execute(call: ToolCall): Promise<ToolResult> {
  console.log(`  > ${call.name} ${JSON.stringify(call.input).slice(0, PREVIEW_CHARS)}`);

  if (!(await safety.allowed(call.name, call.input))) {
    return { toolCallId: call.id, content: "The user denied this tool call.", isError: true };
  }

  try {
    return { toolCallId: call.id, content: tools.run(call.name, call.input), isError: false };
  } catch (error) {
    // any tool failure goes back to the model instead of crashing the CLI
    return { toolCallId: call.id, content: String(error), isError: true };
  }
}
