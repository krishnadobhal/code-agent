#!/usr/bin/env bun
/** Entry point: `bun start`. Ink UI in a terminal, plain REPL when input or output is piped. */

import type { Session } from "./commands.ts";
import * as jev from "./jev.ts";
import { createProvider } from "./llm/index.ts";
import * as safety from "./safety.ts";
import { runInk, runPlain } from "./ui/index.tsx";

try {
  safety.loadSettings();
} catch (error) {
  console.error(`Bad .code-agent/settings.json: ${(error as Error).message}`);
  process.exit(1);
}

const session: Session = { messages: [], provider: createProvider() };
const intro = [
  `code-agent (${session.provider.name}: ${session.provider.model}) - mode ${safety.getMode()} - /help for commands, Ctrl+C cancels a reply`,
  ...(jev.enabled() ? [] : ["(Jev off: no TYPESAFE_API_KEY. Shell commands outside the safe list will ask.)"]),
];

if (process.stdin.isTTY && process.stdout.isTTY) await runInk(session, intro);
else await runPlain(session, intro);
