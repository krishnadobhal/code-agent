/** Permission gate: every tool call passes through allowed() before it runs. */

import fs from "node:fs";
import path from "node:path";
import * as jev from "./jev.ts";

const READ_ONLY = new Set(["read_file", "list_dir", "glob", "grep"]);
const EDITS = new Set(["write_file", "edit_file"]);

// read-only commands skip the prompt; chaining, redirects or --output always ask
const SAFE_COMMAND = /^(git (status|diff|log|show)|ls|dir|pwd)( [^;&|<>$`\r\n]*)?$/;
const UNSAFE_ANYWHERE = /[;&|<>$`\r\n]|--output/;

// guessed threshold; tune on real commands
const JEV_MIN_READ_ONLY = 0.99;

export const MODES = ["default", "accept-edits", "plan"] as const;
export type Mode = (typeof MODES)[number];
export type Judge = (command: string) => Promise<number>;

// rules look like "write_file" or "run_command(git *)"; * matches anything
let allowRules: string[] = [];
let denyRules: string[] = [];
let mode: Mode = "default";
const approved = new Set<string>(); // "always" answers, this session only

/** Load .code-agent/settings.json from `dir`; throws on bad JSON so deny rules never silently vanish. */
export function loadSettings(dir = process.cwd()): void {
  const file = path.join(dir, ".code-agent", "settings.json");
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  allowRules = settings.permissions?.allow ?? [];
  denyRules = settings.permissions?.deny ?? [];
  mode = MODES.includes(settings.mode) ? settings.mode : "default";
  approved.clear();
}

export const getMode = (): Mode => mode;
export const rules = () => ({ allow: allowRules, deny: denyRules, approved: [...approved] });
export function setMode(next: Mode): void {
  mode = next;
}

// Checks that the path stays inside the folder you started the agent in (process.cwd()):
export function insideCwd(target: string): boolean {
  // doesn't follow symlinks; use fs.realpathSync if links out of the project matter
  const rel = path.relative(process.cwd(), path.resolve(target));
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** What a rule's pattern is matched against: the command, or the path relative to cwd. */
function subjectOf(name: string, args: Record<string, unknown>): string {
  if (name === "run_command") return String(args.command ?? "").trim();
  const target = typeof args.path === "string" ? args.path : ".";
  return path.relative(process.cwd(), path.resolve(target)).replaceAll("\\", "/") || ".";
}

function matches(rule: string, name: string, subject: string): boolean {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m || m[1] !== name) return false;
  if (m[2] === undefined) return true;
  const re = m[2].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${re}$`).test(subject);
}

/** Deny checks every piece of a chained command, so "ls; rm x" still hits "run_command(rm *)". */
function denied(name: string, subject: string): boolean {
  const pieces = name === "run_command" ? [subject, ...subject.split(/[;&|\r\n]+/).map((s) => s.trim())] : [subject];
  return denyRules.some((rule) => pieces.some((piece) => matches(rule, name, piece)));
}

async function readOnlyCommand(command: string, judge: Judge): Promise<boolean> {
  if (UNSAFE_ANYWHERE.test(command)) return false;
  if (SAFE_COMMAND.test(command)) return true;
  try {
    return (await judge(command)) >= JEV_MIN_READ_ONLY;
  } catch (error) {
    console.log(`[jev] unavailable, asking instead: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** Deny rules, then read-only checks, then mode, allow rules and approvals; ask for the rest. `judge` (Jev) can only skip a prompt. */
export async function allowed(name: string, args: Record<string, unknown>, judge: Judge = jev.readOnlyCommand): Promise<boolean> {
  const subject = subjectOf(name, args);
  const isCommand = name === "run_command";
  const inside = !isCommand && insideCwd(subject);

  if (denied(name, subject)) return false;
  if (READ_ONLY.has(name) && inside) return true;
  if (isCommand && (await readOnlyCommand(subject, judge))) return true;
  if (mode === "plan" && !READ_ONLY.has(name)) return false; // plan never changes anything

  // allow rules can't approve chained commands; their tail isn't what the rule names
  if (!(isCommand && UNSAFE_ANYWHERE.test(subject)) && allowRules.some((rule) => matches(rule, name, subject))) return true;
  if (isCommand ? approved.has(`run_command(${subject})`) : approved.has(name) && inside) return true;
  if (mode === "accept-edits" && EDITS.has(name) && inside) return true;

  const answer = await ask(`${name} ${JSON.stringify(args).slice(0, 1000)}`);
  // "always" remembers the exact command, or the whole tool for files inside the project
  if (answer === "always") approved.add(isCommand ? `run_command(${subject})` : name);
  return answer !== "no";
}

/** Asks the user to approve one tool call; the Ink UI swaps in its own with setAsk. */
export type Answer = "yes" | "no" | "always";
export type Ask = (request: string) => Promise<Answer>;

let ask: Ask = async (request) => {
  console.log(`\n[permission] ${request}`);
  const reply = prompt("Allow? [y/N/a=always this session]")?.trim().toLowerCase();
  return reply === "y" ? "yes" : reply === "a" ? "always" : "no";
};

export function setAsk(fn: Ask): void {
  ask = fn;
}
