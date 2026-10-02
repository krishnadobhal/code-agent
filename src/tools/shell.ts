import type { ToolSchema } from "../llm/index.ts";
import { spawnSync } from "node:child_process";
import type { Handler } from "./index.ts";

const MAX_CHARS = 30_000;
const TIMEOUT_MS = 120_000;

export function runCommand(command: string): string {
  // shell: true is the point of this tool; safety.allowed() makes the user approve every call.
  const result = spawnSync(command, { shell: true, encoding: "utf8", timeout: TIMEOUT_MS });
  if (result.error) throw result.error; // e.g. timed out

  const out = `exit code ${result.status}\n${result.stdout}${result.stderr}`;
  return out.length <= MAX_CHARS ? out : `${out.slice(0, MAX_CHARS)}\n...[truncated]`;
}

export const HANDLERS: Record<string, Handler> = {
  run_command: ({ command }) => runCommand(command),
};

export const SCHEMAS: ToolSchema[] = [
  {
    name: "run_command",
    description:
      "Run a shell command in the working directory. Returns exit code and output. " +
      "Times out after 120 seconds.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];
