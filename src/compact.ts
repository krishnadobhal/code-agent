/** Keeping long conversations inside the context window: clear stale tool output, summarize when full. */

import { addUsage, type CompleteOptions, type Message, type Provider, ProviderError, type Usage } from "./llm/index.ts";
import * as tools from "./tools/index.ts";

// big outputs the model can get again by re-running the tool; edit/write results are tiny
const CLEARABLE = new Set(["read_file", "grep", "glob", "list_dir", "run_command"]);
const KEEP_RECENT = 5;
const CACHE_TTL_MS = 5 * 60_000; // Anthropic's default prompt-cache lifetime
export const CLEARED = "[Old tool result cleared - re-run the tool if needed]";

// ponytail: fixed threshold; read each model's context window from the Models API if this misfires
const COMPACT_AT = Number(process.env.COMPACT_AT_TOKENS ?? 200_000);

const SUMMARY_PROMPT = `Summarize this conversation so you can continue the work from the summary alone. Do not call tools.
Include: the user's goals and requests, decisions made, files read or changed (with paths), commands run and their results, errors and how they were fixed, and what is left to do. Be specific and brief.`;

/**
 * Once the prompt cache has expired the next call rewrites the whole prefix anyway, so clear old
 * tool results first to make that rewrite smaller. While the cache is warm, clearing would cost more than it saves.
 */
export function microcompact(messages: Message[], now = Date.now()): number {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last || (last.at !== undefined && now - last.at < CACHE_TTL_MS)) return 0; // no stamp: resumed old session, treat as cold

  const names = new Map(messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => [c.id, c.name] as const) : [])));
  const results = messages
    .flatMap((m) => (m.role === "tool" ? m.results : []))
    .filter((r) => CLEARABLE.has(names.get(r.toolCallId) ?? "") && r.content !== CLEARED);
  const old = results.slice(0, -KEEP_RECENT);
  for (const r of old) r.content = CLEARED; // in place, so every later request sends the same bytes
  return old.length;
}

/** True when the last call's prompt was over the threshold. */
export function needsCompact(messages: Message[]): boolean {
  const last = messages.findLast((m) => m.role === "assistant");
  return (last?.role === "assistant" && (last.promptTokens ?? 0) >= COMPACT_AT);
}

/** Replace the whole history with a model-written summary. Throws (history untouched) on failure. */
export async function compact(
  messages: Message[],
  provider: Provider,
  system: string,
  opts: Pick<CompleteOptions, "signal" | "effort"> & { usage?: Usage } = {},
): Promise<void> {
  // same system and tools as normal turns, so this call reads the existing prompt cache
  const reply = await provider.complete(system, [...messages, { role: "user", text: SUMMARY_PROMPT }], tools.SCHEMAS, opts);
  if (reply.usage && opts.usage) addUsage(opts.usage, reply.usage);
  if (!reply.text.trim()) throw new ProviderError("Compaction returned no summary; history kept.");
  messages.splice(
    0,
    Infinity,
    { role: "user", text: `This conversation was compacted. Summary of everything before this point:\n\n${reply.text.trim()}` },
    { role: "assistant", text: "Understood. I'll continue from this summary.", toolCalls: [] },
  );
}
