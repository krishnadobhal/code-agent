/** Project memory: instruction files from the working directory and its parents. */

import fs from "node:fs";
import path from "node:path";

const NAMES = ["CLAUDE.md", "AGENT.md", "AGENTS.md"];
const MAX_LINES = 100; // per file; keeps a huge doc from eating the context window

/** Memory files from the filesystem root down to `dir`, closest last so it wins. */
export function memoryFiles(dir = process.cwd()): string[] {
  const files: string[] = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const here = NAMES.map((name) => path.join(d, name)).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    files.unshift(...here);
    if (path.dirname(d) === d) break;
  }
  return files;
}

/** First MAX_LINES lines of every memory file, tagged so the model can tell project rules from the base prompt. */
export function loadMemory(dir = process.cwd()): string {
  return memoryFiles(dir)
    .map((file) => `<project_instructions path="${file}">\n${firstLines(file)}\n</project_instructions>`)
    .join("\n\n");
}

/** The file's first MAX_LINES lines, with a pointer to the rest so the model can read_file it. */
function firstLines(file: string): string {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (lines.length <= MAX_LINES) return lines.join("\n");
  const more = lines.length - MAX_LINES;
  return `${lines.slice(0, MAX_LINES).join("\n")}\n[${more} more lines: read_file "${file}" with offset ${MAX_LINES + 1}]`;
}
