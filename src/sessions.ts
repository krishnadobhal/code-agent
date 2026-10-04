/** Saved conversations: one JSONL file per session (one message per line), grouped by project folder. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "./llm/index.ts";

export type SavedSession = { id: string; when: Date; first: string };

/** ~/.code-agent, or CODE_AGENT_HOME (tests point it at a temp dir). */
export const home = () => process.env.CODE_AGENT_HOME ?? path.join(os.homedir(), ".code-agent");
const dir = () => path.join(home(), "projects", process.cwd().replace(/[^\w-]+/g, "-"));
const file = (id: string) => path.join(dir(), `${id}.jsonl`);

/** Sortable and readable: 2026-10-04T10-22-01-123Z-ab12 */
export const newId = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 4)}`;

export function saveSession(id: string, messages: Message[]): void {
  if (!messages.length) return; // no files for sessions that never started
  if (!fs.existsSync(dir())) fs.mkdirSync(dir(), { recursive: true });
  // ponytail: rewrites the whole file each turn so /rewind and /clear need no special cases; append if sessions get huge
  fs.writeFileSync(file(id), `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
}

export function loadSession(id: string): Message[] {
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(file(id))) throw new Error(`No session "${id}" for this folder.`);
  return fs
    .readFileSync(file(id), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
}

/** This folder's sessions, newest first, with the first user message as a label. */
export function listSessions(): SavedSession[] {
  if (!fs.existsSync(dir())) return [];
  return fs
    .readdirSync(dir())
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const id = f.slice(0, -".jsonl".length);
      const first = loadSession(id).find((m) => m.role === "user");
      return { id, when: fs.statSync(file(id)).mtime, first: first?.role === "user" ? first.text : "" };
    })
    .sort((a, b) => b.when.getTime() - a.when.getTime());
}
