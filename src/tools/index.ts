/** Tool registry: schemas sent to Claude and the functions that run them. */

import type { ToolSchema } from "../llm/index.ts";
import * as files from "./files.ts";
import * as search from "./search.ts";
import * as shell from "./shell.ts";

export type Handler = (args: Record<string, any>) => string;

export const SCHEMAS: ToolSchema[] = [...files.SCHEMAS, ...search.SCHEMAS, ...shell.SCHEMAS];
const HANDLERS: Record<string, Handler> = { ...files.HANDLERS, ...search.HANDLERS, ...shell.HANDLERS };

export function run(name: string, args: Record<string, unknown>): string {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}
