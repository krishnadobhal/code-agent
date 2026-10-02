/** Permission gate: every tool call passes through allowed() before it runs. */

import path from "node:path";
import * as jev from "./jev.ts";

const READ_ONLY = new Set(["read_file", "list_dir"]);

// read-only commands skip the prompt; chaining, redirects or --output always ask
const SAFE_COMMAND = /^(git (status|diff|log|show)|ls|dir|pwd)( [^;&|<>$`\r\n]*)?$/;
const UNSAFE_ANYWHERE = /[;&|<>$`\r\n]|--output/;

// guessed threshold; tune on real commands
const JEV_MIN_READ_ONLY = 0.99;

export type Judge = (command: string) => Promise<number>;

export function insideCwd(target: string): boolean {
  // doesn't follow symlinks; use fs.realpathSync if links out of the project matter
  const rel = path.relative(process.cwd(), path.resolve(target));
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Allow project reads and read-only commands; ask for the rest. `judge` (Jev) can only skip a prompt. */
export async function allowed(
  name: string,
  args: Record<string, unknown>,
  judge: Judge = jev.readOnlyCommand,
): Promise<boolean> {
  const target = typeof args.path === "string" ? args.path : ".";
  if (READ_ONLY.has(name) && insideCwd(target)) return true;

  if (name === "run_command" && typeof args.command === "string") {
    const command = args.command.trim();
    if (!UNSAFE_ANYWHERE.test(command)) {
      if (SAFE_COMMAND.test(command)) return true;
      try {
        if ((await judge(command)) >= JEV_MIN_READ_ONLY) return true;
      } catch (error) {
        console.log(`[jev] unavailable, asking instead: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  console.log(`\n[permission] ${name} ${JSON.stringify(args).slice(0, 1000)}`);
  return prompt("Allow? [y/N]")?.trim().toLowerCase() === "y";
}
