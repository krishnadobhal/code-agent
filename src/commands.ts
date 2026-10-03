/** Slash commands typed at the REPL prompt (`/help`, `/clear`, ...). They never reach the model. */

import { createProvider, EFFORTS, type Effort, type Message, type Provider } from "./llm/index.ts";

/** What a command can read and change: the REPL's history, model and effort. */
export type Session = { messages: Message[]; provider: Provider; effort?: Effort };
export type CommandResult = { text: string; exit?: boolean };

type Command = {
  usage: string;
  description: string;
  run: (session: Session, args: string) => CommandResult | Promise<CommandResult>;
};

const COMMANDS: Record<string, Command> = {
  help: {
    usage: "/help",
    description: "List commands",
    run: () => ({
      text: Object.values(COMMANDS)
        .map((c) => `  ${c.usage.padEnd(24)} ${c.description}`)
        .join("\n"),
    }),
  },
  clear: {
    usage: "/clear",
    description: "Forget the conversation and start fresh",
    run: (session) => {
      session.messages.length = 0; // in place: the REPL holds this array
      return { text: "Conversation cleared." };
    },
  },
  model: {
    usage: "/model [number|id]",
    description: "List models, or switch by number or id (same backend)",
    run: model,
  },
  effort: {
    usage: `/effort [level|default]`,
    description: `Show or set reasoning effort: ${EFFORTS.join(", ")}`,
    run: (session, level) => {
      if (!level) return { text: `Effort: ${session.effort ?? "default (the model decides)"}` };
      if (level === "default") {
        session.effort = undefined;
        return { text: "Effort: default" };
      }
      if (!(EFFORTS as readonly string[]).includes(level)) {
        return { text: `Unknown effort "${level}". Use one of: ${EFFORTS.join(", ")}, default` };
      }
      session.effort = level as Effort;
      return { text: `Effort: ${level}` };
    },
  },
  exit: { usage: "/exit", description: "Quit", run: () => ({ text: "", exit: true }) },
};

async function model(session: Session, arg: string): Promise<CommandResult> {
  const current = `${session.provider.name}: ${session.provider.model}`;
  let ids: string[] = [];
  try {
    ids = await session.provider.listModels();
  } catch (error) {
    // listing is a convenience; switching by id still works without it
    if (!arg) return { text: `Current: ${current}\n(could not list models: ${(error as Error).message})` };
  }

  if (!arg) {
    const list = ids.map((id, i) => `  ${String(i + 1).padStart(2)}. ${id}${id === session.provider.model ? "  <- current" : ""}`);
    return { text: `Current: ${current}\n${list.join("\n")}\nType /model <number> or /model <id> to switch.` };
  }

  const picked = /^\d+$/.test(arg) ? ids[Number(arg) - 1] : arg;
  if (!picked) return { text: `No model #${arg}. Type /model to see the list.` };
  session.provider = createProvider({ ...process.env, LLM_MODEL: picked });
  return { text: `Switched to ${session.provider.name}: ${session.provider.model}` };
}

/** Run `line` if it is a slash command; undefined means it is a normal message for the model. */
export async function handleCommand(line: string, session: Session): Promise<CommandResult | undefined> {
  if (!line.startsWith("/")) return undefined;
  const [name = "", ...rest] = line.slice(1).split(/\s+/);
  const command = COMMANDS[name.toLowerCase()];
  if (!command) return { text: `Unknown command /${name}. Type /help for the list.` };
  return command.run(session, rest.join(" ").trim());
}
