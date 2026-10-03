/** Slash commands typed at the REPL prompt (`/help`, `/clear`, ...). Only `prompt` results reach the model. */

import fs from "node:fs";
import { createProvider, EFFORTS, type Effort, type Message, type Provider } from "./llm/index.ts";
import { memoryFiles } from "./memory.ts";
import * as safety from "./safety.ts";

/** What a command can read and change: the REPL's history, model and effort. */
export type Session = { messages: Message[]; provider: Provider; effort?: Effort };
/** `prompt` is sent to the model as if the user typed it. */
export type CommandResult = { text: string; exit?: boolean; prompt?: string };

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
  mode: {
    usage: "/mode [mode]",
    description: `Show or set permission mode: ${safety.MODES.join(", ")}`,
    run: (_session, next) => {
      if (!next) return { text: `Mode: ${safety.getMode()}` };
      if (!(safety.MODES as readonly string[]).includes(next)) {
        return { text: `Unknown mode "${next}". Use one of: ${safety.MODES.join(", ")}` };
      }
      safety.setMode(next as safety.Mode);
      return { text: `Mode: ${next}` };
    },
  },
  rewind: {
    usage: "/rewind [number]",
    description: "List your messages, or drop the conversation back to before one (files are not restored)",
    run: rewind,
  },
  status: {
    usage: "/status",
    description: "Show model, effort, mode, folder and history size",
    run: (session) => ({
      text: [
        `Model:   ${session.provider.name}: ${session.provider.model}`,
        `Effort:  ${session.effort ?? "default"}`,
        `Mode:    ${safety.getMode()}`,
        `Folder:  ${process.cwd()}`,
        `History: ${session.messages.length} messages`,
      ].join("\n"),
    }),
  },
  permissions: {
    usage: "/permissions",
    description: "Show allow/deny rules and this session's always-allowed calls",
    run: () => {
      const { allow, deny, approved } = safety.rules();
      const list = (xs: string[]) => (xs.length ? xs.map((x) => `  ${x}`).join("\n") : "  (none)");
      return { text: `Deny:\n${list(deny)}\nAllow:\n${list(allow)}\nAlways (this session):\n${list(approved)}` };
    },
  },
  memory: {
    usage: "/memory",
    description: "List the memory files loaded into the system prompt",
    run: () => {
      const files = memoryFiles();
      return { text: files.length ? files.join("\n") : "No memory files. /init creates AGENT.md." };
    },
  },
  init: {
    usage: "/init",
    description: "Have the model study the project and write AGENT.md",
    run: () => ({
      text: "Writing AGENT.md...",
      prompt:
        "Study this project (layout, build/test commands, conventions) and write a short AGENT.md in the project root " +
        "with what a new contributor needs to know. If AGENT.md or CLAUDE.md exists, improve it instead.",
    }),
  },
  export: {
    usage: "/export [file]",
    description: "Save the conversation as text",
    run: (session, file) => {
      const out = file || `conversation-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      fs.writeFileSync(out, transcript(session.messages));
      return { text: `Saved to ${out}` };
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

function rewind(session: Session, arg: string): CommandResult {
  const turns = session.messages.flatMap((m, i) => (m.role === "user" ? [{ i, text: m.text }] : []));
  if (!turns.length) return { text: "Nothing to rewind." };
  if (!arg) {
    const list = turns.map((t, n) => `  ${String(n + 1).padStart(2)}. ${t.text.slice(0, 80)}`);
    return { text: `${list.join("\n")}\nType /rewind <number> to go back to before that message.` };
  }
  const turn = turns[Number(arg) - 1];
  if (!/^\d+$/.test(arg) || !turn) return { text: `No message #${arg}. Type /rewind to see the list.` };
  session.messages.splice(turn.i); // in place: the REPL holds this array
  return { text: `Rewound to before: ${turn.text.slice(0, 80)}` };
}

function transcript(messages: Message[]): string {
  return messages
    .map((m) => {
      if (m.role === "user") return `> ${m.text}`;
      if (m.role === "tool") return m.results.map((r) => `[result${r.isError ? " error" : ""}] ${r.content.slice(0, 500)}`).join("\n");
      return [m.text, ...m.toolCalls.map((c) => `[${c.name}] ${JSON.stringify(c.input).slice(0, 500)}`)].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/** Run `line` if it is a slash command; undefined means it is a normal message for the model. */
export async function handleCommand(line: string, session: Session): Promise<CommandResult | undefined> {
  if (!line.startsWith("/")) return undefined;
  const [name = "", ...rest] = line.slice(1).split(/\s+/);
  const command = COMMANDS[name.toLowerCase()];
  if (!command) return { text: `Unknown command /${name}. Type /help for the list.` };
  return command.run(session, rest.join(" ").trim());
}
