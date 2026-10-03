import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, runTurn } from "../src/agent.ts";
import { createProvider, type Message, type Provider, ProviderError, type Reply } from "../src/llm/index.ts";
import { OpenAIProvider } from "../src/llm/openai.ts";
import * as jev from "../src/jev.ts";
import * as safety from "../src/safety.ts";
import * as tools from "../src/tools/index.ts";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

function fakeProvider(replies: Reply[]): Provider {
  return { name: "fake", model: "fake", complete: async () => replies.shift()! };
}

test("loop runs a tool, then returns the answer", async () => {
  fs.writeFileSync("hello.txt", "hi there");
  const provider = fakeProvider([
    {
      stop: "tool_use",
      text: "",
      toolCalls: [{ id: "t1", name: "read_file", input: { path: "hello.txt" } }],
    },
    { stop: "end", text: "It says hi there", toolCalls: [] },
  ]);

  const messages: Message[] = [{ role: "user", text: "read hello.txt" }];
  expect(await runTurn(messages, provider)).toBe("It says hi there");

  const toolMsg = messages[2] as Extract<Message, { role: "tool" }>;
  expect(toolMsg.results[0]).toEqual({ toolCallId: "t1", content: "hi there", isError: false });
  expect(messages).toHaveLength(4); // user, assistant(tool call), tool(result), assistant
});

test("tool errors go back to the model", async () => {
  const result = await execute({ id: "t1", name: "read_file", input: { path: "missing.txt" } });
  expect(result.isError).toBe(true);
  expect(result.content).toContain("ENOENT");
});

test("reads outside the project need approval", async () => {
  globalThis.prompt = () => "n";
  const never = async () => 0;
  expect(await safety.allowed("read_file", { path: "x.txt" }, never)).toBe(true);
  expect(await safety.allowed("read_file", { path: "../secret" }, never)).toBe(false);
  expect(await safety.allowed("run_command", { command: "rm x.txt" }, never)).toBe(false);
});

test("shell triage: safe list, then Jev, never past chaining or errors", async () => {
  globalThis.prompt = () => "n"; // the user says no whenever asked
  const run = (command: string, judge: safety.Judge) =>
    safety.allowed("run_command", { command }, judge);
  const sure = async () => 0.999;
  const unsure = async () => 0.5;
  const broken = async () => {
    throw new Error("down");
  };

  expect(await run("git status", unsure)).toBe(true); // safe list, Jev not needed
  expect(await run("git diff --output=x", sure)).toBe(false); // writes a file
  expect(await run("cat README.md", sure)).toBe(true); // Jev is sure
  expect(await run("cat README.md", unsure)).toBe(false); // Jev unsure -> ask
  expect(await run("cat README.md", broken)).toBe(false); // Jev down -> ask
  expect(await run("ls; rm -rf x", sure)).toBe(false); // chaining always asks
  expect(await run("git status && rm x", sure)).toBe(false);
});

test("createProvider picks the backend from env", () => {
  expect(createProvider({}).name).toBe("anthropic");
  expect(createProvider({ LLM_PROVIDER: "openai", LLM_MODEL: "m" }).name).toBe("openai");
  expect(() => createProvider({ LLM_PROVIDER: "openai" })).toThrow("LLM_MODEL");
  expect(() => createProvider({ LLM_PROVIDER: "nope" })).toThrow("Unknown");
});

test("openai provider maps history and tool calls both ways", async () => {
  let sent: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              { id: "c2", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
            ],
          },
        },
      ],
    });
  }) as unknown as typeof fetch;

  const reply = await new OpenAIProvider("m", "http://x/v1/").complete(
    "sys",
    [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", input: {} }] },
      { role: "tool", results: [{ toolCallId: "c1", content: "boom", isError: true }] },
    ],
    [],
  );

  expect(reply).toEqual({
    text: "",
    stop: "tool_use",
    toolCalls: [{ id: "c2", name: "list_dir", input: { path: "." } }],
  });
  expect(sent.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(sent.messages[2].tool_calls[0].function.arguments).toBe("{}");
  expect(sent.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ERROR: boom" });
});

test("Jev is off without a key, and turns off when the key is rejected", async () => {
  const savedKey = process.env.TYPESAFE_API_KEY;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
  }) as unknown as typeof fetch;
  try {
    delete process.env.TYPESAFE_API_KEY;
    expect(jev.enabled()).toBe(false);
    expect(await jev.readOnlyCommand("cat x")).toBe(0);
    expect(calls).toBe(0); // no key -> no network

    process.env.TYPESAFE_API_KEY = "wrong";
    expect(jev.enabled()).toBe(true);
    await expect(jev.readOnlyCommand("cat x")).rejects.toThrow("rejected");
    expect(jev.enabled()).toBe(false); // off for the rest of the session
    expect(await jev.readOnlyCommand("cat x")).toBe(0);
    expect(calls).toBe(1);
  } finally {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
  }
});

test("openai provider turns API errors into ProviderError", async () => {
  globalThis.fetch = (async () =>
    Response.json({ error: { message: "bad key" } }, { status: 401 })) as unknown as typeof fetch;
  await expect(
    new OpenAIProvider("m", "http://x/v1").complete("sys", [{ role: "user", text: "hi" }], []),
  ).rejects.toBeInstanceOf(ProviderError);
});

test("edit_file replaces one exact match, keeps CRLF, refuses ambiguity", () => {
  fs.writeFileSync("a.ts", "const a = 1;\r\nconst b = 1;\r\n");
  expect(() => tools.run("edit_file", { path: "a.ts", old_string: "= 1", new_string: "= 2" })).toThrow("2 times");
  expect(() => tools.run("edit_file", { path: "a.ts", old_string: "nope", new_string: "x" })).toThrow("not found");
  tools.run("edit_file", { path: "a.ts", old_string: "a = 1;\nconst b", new_string: "a = '$&';\nconst b" });
  expect(fs.readFileSync("a.ts", "utf8")).toBe("const a = '$&';\r\nconst b = 1;\r\n");
  tools.run("edit_file", { path: "a.ts", old_string: "const", new_string: "let", replace_all: true });
  expect(fs.readFileSync("a.ts", "utf8")).toBe("let a = '$&';\r\nlet b = 1;\r\n");
});

test("read_file pages, glob and grep search the project but skip node_modules", async () => {
  fs.mkdirSync("src/node_modules", { recursive: true });
  fs.writeFileSync("src/x.ts", "one\ntwo\nfind me\n");
  fs.writeFileSync("src/node_modules/y.ts", "find me\n");
  expect(tools.run("read_file", { path: "src/x.ts", offset: 2, limit: 2 })).toBe("two\nfind me");
  expect(tools.run("glob", { pattern: "**/*.ts" })).toBe("src/x.ts");
  expect(tools.run("grep", { pattern: "find", include: "**/*.ts" })).toBe("src/x.ts:3: find me");
  expect(() => tools.run("glob", { pattern: "../**" })).toThrow("..");
  const never = async () => 0;
  expect(await safety.allowed("grep", { pattern: "x" }, never)).toBe(true); // read-only, auto-allowed
});
