#!/usr/bin/env bun
/** REPL entry point: `bun start` or `bun src/index.ts`. */

import { runTurn } from "./agent.ts";
import * as jev from "./jev.ts";
import { createProvider, type Message, ProviderError } from "./llm/index.ts";

const provider = createProvider();
const messages: Message[] = [];
console.log(`code-agent (${provider.name}: ${provider.model}) - Ctrl+C cancels a reply, 'exit' quits`);
if (!jev.enabled()) {
  console.log("(Jev off: no TYPESAFE_API_KEY. Shell commands outside the safe list will ask.)");
}

let turn: AbortController | undefined;
process.on("SIGINT", () => {
  if (!turn || turn.signal.aborted) process.exit(130); // idle, or a second Ctrl+C: quit
  turn.abort();
});

while (true) {
  const line = prompt("\n>");
  if (line === null) break; // EOF (Ctrl+D / Ctrl+Z) or Ctrl+C at the prompt

  const text = line.trim();
  if (text === "exit" || text === "quit") break;
  if (!text) continue;

  const start = messages.length;
  messages.push({ role: "user", text });
  turn = new AbortController();
  try {
    await runTurn(messages, provider, {
      onText: (delta) => process.stdout.write(delta),
      signal: turn.signal,
    });
    process.stdout.write("\n");
  } catch (error) {
    if (!turn.signal.aborted && !(error instanceof ProviderError)) throw error;
    messages.splice(start); // roll back the half-finished turn so history stays valid
    console.log(turn.signal.aborted ? "\n[cancelled]" : `\n[turn aborted] ${(error as Error).message}`);
  } finally {
    turn = undefined;
  }
}
