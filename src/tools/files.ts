import type { ToolSchema } from "../llm/index.ts";
import fs from "node:fs";
import path from "node:path";
import type { Handler } from "./index.ts";

const MAX_CHARS = 100_000;

/** File text, or `limit` lines from line `offset` (1-based) to page through big files. */
export function readFile(file: string, offset?: number, limit?: number): string {
  let text = fs.readFileSync(file, "utf8");
  if (offset !== undefined || limit !== undefined) {
    const start = Math.max((offset ?? 1) - 1, 0);
    const end = limit === undefined ? undefined : start + limit;
    text = text.split(/\r?\n/).slice(start, end).join("\n");
  }
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n...[truncated; use offset/limit]`;
}

/** Replace an exact string; must match once unless replaceAll, so an edit never hits the wrong spot. */
export function editFile(file: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) throw new Error("old_string and new_string are the same");
  let text = fs.readFileSync(file, "utf8");
  if (text.includes("\r\n")) {
    // the model writes \n; make it match CRLF files
    oldString = oldString.replace(/\r?\n/g, "\r\n");
    newString = newString.replace(/\r?\n/g, "\r\n");
  }
  const count = text.split(oldString).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${file}`);
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string matches ${count} times in ${file}; add context or set replace_all`);
  }
  // function replacer so `$&` etc. in new code stay literal
  text = replaceAll ? text.replaceAll(oldString, () => newString) : text.replace(oldString, () => newString);
  fs.writeFileSync(file, text, "utf8");
  return `Edited ${file} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? "s" : ""})`;
}

export function writeFile(file: string, content: string): string {
  const dir = path.dirname(file);
  // Bun on Windows throws EEXIST for mkdirSync(".", { recursive: true }), so only create missing dirs
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return `Wrote ${content.length} chars to ${file}`;
}

export function listDir(dir = "."): string {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  return entries.join("\n") || "(empty)";
}

export const HANDLERS: Record<string, Handler> = {
  read_file: ({ path, offset, limit }) => readFile(path, offset, limit),
  write_file: ({ path, content }) => writeFile(path, content),
  edit_file: ({ path, old_string, new_string, replace_all }) =>
    editFile(path, old_string, new_string, replace_all),
  list_dir: ({ path }) => listDir(path),
};

const pathProp = { type: "string", description: "Path relative to the working directory." };

export const SCHEMAS: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file. For big files pass offset/limit (lines, 1-based) to read part.",
    input_schema: {
      type: "object",
      properties: {
        path: pathProp,
        offset: { type: "integer", description: "First line to read (1-based)." },
        limit: { type: "integer", description: "Number of lines to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match exactly once (add surrounding lines " +
      "to make it unique) unless replace_all is true. Prefer this over write_file for changes.",
    input_schema: {
      type: "object",
      properties: {
        path: pathProp,
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Replace every match. Default false." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    input_schema: {
      type: "object",
      properties: { path: pathProp, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory. Directories end with '/'.",
    input_schema: { type: "object", properties: { path: pathProp } },
  },
];
