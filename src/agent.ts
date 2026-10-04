/** Agent loop: call the model, run the tools it asks for, repeat until it answers. */

import { addUsage, type CompleteOptions, type Message, type Provider, type ToolCall, type ToolResult, type Usage } from "./llm/index.ts";
import { compact, microcompact, needsCompact } from "./compact.ts";
import { loadMemory } from "./memory.ts";
import * as safety from "./safety.ts";
import * as tools from "./tools/index.ts";

const PREVIEW_CHARS = 120; // how much of a tool's input to echo to the terminal

/** Model options plus `onTool` (a line per tool call) and `usage` (a running total, added to in place). */
export type TurnOptions = CompleteOptions & { onTool?: (line: string) => void; usage?: Usage };

/** Base instructions plus the project's memory files, re-read each turn. */
export function systemPrompt(): string {
  // stable part first, memory last: keeps the prompt prefix cacheable
  const base = `You are a coding agent working in the user's terminal, on the project in the working directory.
Working directory: ${process.cwd()}
Platform: ${process.platform}

How to work:
- Find before you read: use glob and grep to locate code, then read_file with offset/limit for just the part you need.
- Read a file before you change it. Change files with edit_file; use write_file only for new files or full rewrites.
- Keep changes to what was asked. Match the surrounding code's style.
- run_command is for builds, tests and git. Don't run commands that delete data or touch things outside the project unless the user asked.
- The user approves risky tool calls. If one is denied, don't retry it; ask or take another approach.
- After changing code, run the project's tests or type check if it has them, and report the real result.
- Answer briefly in plain text. Reference code as path:line.`;
  const memory = loadMemory();
  if (!memory) return base;
  return `${base}\n\nThe user's project instructions follow. They override the defaults above.\n\n${memory}`;
}

/** Run one user turn to the final answer; appends to `messages` in place (tests pass a fake provider). */
export async function runTurn(messages: Message[], provider: Provider, opts: TurnOptions = {}): Promise<string> {
  const system = systemPrompt();
  while (true) {
    const cleared = microcompact(messages);
    if (cleared) opts.onTool?.(`[cleared ${cleared} old tool results: the prompt cache had expired]`);

    const at = Date.now();
    const reply = await provider.complete(system, messages, tools.SCHEMAS, opts);
    if (reply.usage && opts.usage) addUsage(opts.usage, reply.usage);
    const u = reply.usage;
    const stamp = { at, ...(u ? { promptTokens: u.input + u.cacheRead + u.cacheWrite } : {}) };

    if (reply.stop === "refusal") {
      messages.push({ role: "assistant", text: "(declined)", toolCalls: [], ...stamp });
      return notice(opts, "[The model declined this request]");
    }

    if (reply.stop === "max_tokens") {
      // keep only the text: a half-written tool call would leave a tool_use with no result
      messages.push({ role: "assistant", text: reply.text, toolCalls: [], ...stamp });
      return reply.text + notice(opts, "\n[reply cut off at max_tokens]");
    }

    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw, ...stamp });
    if (reply.stop !== "tool_use") return reply.text;
    if (reply.text) opts.onText?.("\n"); // end the streamed line before tool logs

    // one at a time, since a call may stop to ask the user
    const results: ToolResult[] = [];
    for (const call of reply.toolCalls) results.push(await execute(call, opts.onTool));
    messages.push({ role: "tool", results });
    opts.signal?.throwIfAborted(); // Ctrl+C during a tool: stop before the next model call
  }
}

/** Summarize the history first if the last prompt was near the context limit; true if it did. */
export async function compactIfFull(messages: Message[], provider: Provider, opts: TurnOptions = {}): Promise<boolean> {
  if (!needsCompact(messages)) return false;
  await compact(messages, provider, systemPrompt(), opts);
  return true;
}

/** Streams a status line like reply text, so the REPL only prints what streamed. */
function notice(opts: CompleteOptions, text: string): string {
  opts.onText?.(text);
  return text;
}

/** Run one tool call and wrap the outcome as a tool result; `onTool` shows what is running. */
export async function execute(call: ToolCall, onTool: (line: string) => void = console.log): Promise<ToolResult> {
  onTool(`> ${call.name} ${JSON.stringify(call.input).slice(0, PREVIEW_CHARS)}`);

  if (!(await safety.allowed(call.name, call.input))) {
    const content = safety.getMode() === "plan"
      ? "Blocked: plan mode is read-only. Explore and propose a plan; the user will switch modes to apply it."
      : "Denied by the user or a deny rule.";
    return { toolCallId: call.id, content, isError: true };
  }

  try {
    return { toolCallId: call.id, content: tools.run(call.name, call.input), isError: false };
  } catch (error) {
    // any tool failure goes back to the model instead of crashing the CLI
    return { toolCallId: call.id, content: String(error), isError: true };
  }
}
