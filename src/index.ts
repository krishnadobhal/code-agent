#!/usr/bin/env bun
/** REPL entry point: `bun start` or `bun src/index.ts`. */

import { runTurn } from "./agent.ts";
import * as jev from "./jev.ts";
import { createProvider, type Message, ProviderError } from "./llm/index.ts";

const provider = createProvider();
const messages: Message[] = [];
console.log(`code-agent (${provider.name}: ${provider.model}) - type 'exit' or press Ctrl+C to quit`);
if (!jev.enabled()) {
  console.log("(Jev off: no TYPESAFE_API_KEY. Shell commands outside the safe list will ask.)");
}

while (true) {
  const line = prompt("\n>");
  if (line === null) break; // EOF (Ctrl+D / Ctrl+Z)

  const text = line.trim();
  if (text === "exit" || text === "quit") break;
  if (!text) continue;

  const start = messages.length;
  messages.push({ role: "user", text });
  try {
    console.log(await runTurn(messages, provider));
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    messages.splice(start); // roll back the half-finished turn so history stays valid
    console.log(`\n[turn aborted] ${error.message}`);
  }
}
