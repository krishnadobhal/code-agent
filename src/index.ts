#!/usr/bin/env bun
/** Entry point: `bun start [--continue | --resume [id]]`. Ink UI in a terminal, plain REPL when piped. */

import { handleCommand, newSession } from "./commands.ts";
import * as jev from "./jev.ts";
import { createProvider } from "./llm/index.ts";
import * as safety from "./safety.ts";
import { listSessions } from "./sessions.ts";
import { runInk, runPlain } from "./ui/index.tsx";

try {
  safety.loadSettings();
} catch (error) {
  console.error(`Bad .code-agent/settings.json: ${(error as Error).message}`);
  process.exit(1);
}

const session = newSession(createProvider());
const intro = [
  `code-agent (${session.provider.name}: ${session.provider.model}) - mode ${safety.getMode()} - /help for commands, Ctrl+C cancels a reply`,
  ...(jev.enabled() ? [] : ["(Jev off: no TYPESAFE_API_KEY. Shell commands outside the safe list will ask.)"]),
];

// --continue loads the newest conversation; --resume <id> a given one, bare --resume lists them
const args = process.argv.slice(2);
const flag = args.findIndex((a) => a === "--resume" || a === "--continue" || a === "-c");
if (flag >= 0) {
  const pick = args[flag] === "--resume" ? (args[flag + 1] ?? "") : listSessions()[0]?.id;
  const result = pick === undefined ? { text: "No saved conversation to continue." } : await handleCommand(`/resume ${pick}`, session);
  if (result?.text) intro.push(result.text);
}

if (process.stdin.isTTY && process.stdout.isTTY) await runInk(session, intro);
else await runPlain(session, intro);
