import fs from "node:fs";
import path from "node:path";
import type { ToolSchema } from "../llm/index.ts";
import type { Handler } from "./index.ts";

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 1_000_000;
const SKIP = /(^|\/)(node_modules|\.git)\//;

/** Files under `dir` matching `pattern`, as `/` paths relative to cwd, sorted. */
export function glob(pattern: string, dir = "."): string[] {
  // safety only checks `dir`, so the pattern must not climb out of it
  if (path.isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new Error("glob pattern must be relative and must not contain '..'; use path instead");
  }
  // walks node_modules before filtering; honor .gitignore if big repos get slow
  return [...new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true })]
    .map((p) => path.join(dir, p).replaceAll("\\", "/"))
    .filter((p) => !SKIP.test(p))
    .sort();
}

/** Lines matching the regex `pattern` as `path:line: text`, capped at MAX_RESULTS. */
export function grep(pattern: string, dir = ".", include = "**/*"): string {
  const regex = new RegExp(pattern); // invalid regex throws back to the model
  const hits: string[] = [];
  for (const file of glob(include, dir)) {
    if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\0")) continue; // binary
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      hits.push(`${file}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
      if (hits.length >= MAX_RESULTS) return `${hits.join("\n")}\n...[stopped at ${MAX_RESULTS} matches]`;
    }
  }
  return hits.join("\n") || "(no matches)";
}

export const HANDLERS: Record<string, Handler> = {
  glob: ({ pattern, path }) => {
    const files = glob(pattern, path);
    const shown = files.slice(0, MAX_RESULTS).join("\n");
    return files.length > MAX_RESULTS ? `${shown}\n...[${files.length - MAX_RESULTS} more]` : shown || "(no files)";
  },
  grep: ({ pattern, path, include }) => grep(pattern, path, include),
};

const dirProp = { type: "string", description: "Directory to search, relative to the working directory. Default '.'." };

export const SCHEMAS: ToolSchema[] = [
  {
    name: "glob",
    description: "Find files by glob pattern, e.g. 'src/**/*.ts'. Skips node_modules and .git.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: dirProp },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a JavaScript regex. Returns 'path:line: text'. " +
      "Use read_file with offset/limit to see the surrounding lines.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: dirProp,
        include: { type: "string", description: "Glob of files to search, e.g. '**/*.ts'. Default all." },
      },
      required: ["pattern"],
    },
  },
];
