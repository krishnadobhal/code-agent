/** Plain line-by-line REPL, used when stdin/stdout is not a terminal (pipes, scripts). */

import { runTurn } from "../agent.ts";
import { handleCommand, type Session } from "../commands.ts";
import { ProviderError } from "../llm/index.ts";

/** Read lines with prompt() until EOF or exit; same commands and turn handling as the Ink UI. */
export async function runPlain(session: Session, intro: string[]): Promise<void> {
  for (const line of intro) console.log(line);
  const { messages } = session; // /clear empties this same array

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

    const command = await handleCommand(text, session);
    if (command) {
      if (command.text) console.log(command.text);
      if (command.exit) break;
      continue;
    }

    const start = messages.length;
    messages.push({ role: "user", text });
    turn = new AbortController();
    try {
      await runTurn(messages, session.provider, {
        onText: (delta) => process.stdout.write(delta),
        signal: turn.signal,
        effort: session.effort,
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
}
