import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newSession, type Session } from "../src/commands.ts";
import type { Provider, Reply } from "../src/llm/index.ts";
import { App } from "../src/ui/index.tsx";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-ui-"));
  process.chdir(tmp);
  process.env.CODE_AGENT_HOME = path.join(tmp, "home");
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tick = () => Bun.sleep(50); // let Ink re-render after input

function session(replies: Reply[]): Session {
  const provider: Provider = {
    name: "fake",
    model: "fake",
    complete: async (_s, _m, _t, opts) => {
      const reply = replies.shift()!;
      opts?.onText?.(reply.text);
      return reply;
    },
    listModels: async () => [],
  };
  return newSession(provider);
}

test("ui runs slash commands", async () => {
  const ui = render(<App session={session([])} intro={["hello"]} />);
  ui.stdin.write("/effort max");
  await tick();
  ui.stdin.write("\r");
  await tick();
  expect(ui.lastFrame()).toContain("Effort: max");
  ui.unmount();
});

test("ui asks y/N for a write, runs it on y, and shows the answer", async () => {
  const s = session([
    { stop: "tool_use", text: "Writing.", toolCalls: [{ id: "t1", name: "write_file", input: { path: "out.txt", content: "x" } }] },
    { stop: "end", text: "Done.", toolCalls: [] },
  ]);
  const ui = render(<App session={s} intro={[]} />);
  ui.stdin.write("make a file");
  await tick();
  ui.stdin.write("\r");
  await tick();
  expect(ui.lastFrame()).toContain("Allow write_file");
  ui.stdin.write("y");
  await tick();
  expect(fs.readFileSync("out.txt", "utf8")).toBe("x");
  expect(ui.lastFrame()).toContain("Done.");
  expect(s.messages).toHaveLength(4); // user, assistant(tool_use), tool result, assistant
  ui.unmount();
});
