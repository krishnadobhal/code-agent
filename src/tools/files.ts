import type { ToolSchema } from "../llm/index.ts";
import fs from "node:fs";
import path from "node:path";
import type { Handler } from "./index.ts";

const MAX_CHARS = 100_000;

export function readFile(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  // hard cut for huge files; add offset/limit params when Claude needs to page
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n...[truncated]`;
}

export function writeFile(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  read_file: ({ path }) => readFile(path),
  write_file: ({ path, content }) => writeFile(path, content),
  list_dir: ({ path }) => listDir(path),
};

const pathProp = { type: "string", description: "Path relative to the working directory." };

export const SCHEMAS: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file and return its contents.",
    input_schema: { type: "object", properties: { path: pathProp }, required: ["path"] },
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
