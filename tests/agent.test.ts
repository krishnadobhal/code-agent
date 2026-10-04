import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactIfFull, execute, runTurn, systemPrompt } from "../src/agent.ts";
import { CLEARED, microcompact } from "../src/compact.ts";
import { handleCommand, newSession, type Session } from "../src/commands.ts";
import { createProvider, type Message, type Provider, ProviderError, type Reply } from "../src/llm/index.ts";
import { OpenAIProvider } from "../src/llm/openai.ts";
import * as jev from "../src/jev.ts";
import { loadMemory } from "../src/memory.ts";
import { saveSession } from "../src/sessions.ts";
import * as safety from "../src/safety.ts";
import * as tools from "../src/tools/index.ts";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-"));
  process.chdir(tmp);
  process.env.CODE_AGENT_HOME = path.join(tmp, "home"); // saved sessions go here
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

function fakeProvider(replies: Reply[]): Provider {
  return { name: "fake", model: "fake", complete: async () => replies.shift()!, listModels: async () => ["a", "b"] };
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

/** A Chat Completions server-sent-events body made of the given chunk deltas. */
function sse(...chunks: object[]): Response {
  const body = chunks
    .map((c) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", ...c })}\n\n`)
    .join("");
  return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("openai provider streams text and maps history and tool calls both ways", async () => {
  let sent: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return sse(
      { choices: [{ index: 0, delta: { role: "assistant", content: "Let me " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "look" }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c2", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    );
  }) as unknown as typeof fetch;

  const streamed: string[] = [];
  const reply = await new OpenAIProvider("m", "http://x/v1/").complete(
    "sys",
    [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", input: {} }] },
      { role: "tool", results: [{ toolCallId: "c1", content: "boom", isError: true }] },
    ],
    [],
    { onText: (d) => streamed.push(d), effort: "low" },
  );

  expect(streamed).toEqual(["Let me ", "look"]);
  expect(sent.reasoning_effort).toBe("low");
  expect(reply).toEqual({
    text: "Let me look",
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

test("max_tokens cut keeps the text but drops half-written tool calls", async () => {
  const provider = fakeProvider([
    { stop: "max_tokens", text: "partial", toolCalls: [{ id: "t1", name: "read_file", input: {} }] },
  ]);
  const messages: Message[] = [{ role: "user", text: "go" }];
  expect(await runTurn(messages, provider)).toContain("cut off");
  expect(messages[1]).toMatchObject({ role: "assistant", text: "partial", toolCalls: [] });
});

test("an aborted turn stops before the next model call", async () => {
  fs.writeFileSync("a.txt", "x");
  const turn = new AbortController();
  let calls = 0;
  const provider: Provider = {
    name: "fake",
    listModels: async () => [],
    model: "fake",
    complete: async () => {
      calls++;
      turn.abort(); // Ctrl+C while the model is replying
      return { stop: "tool_use", text: "", toolCalls: [{ id: "t1", name: "read_file", input: { path: "a.txt" } }] };
    },
  };
  const messages: Message[] = [{ role: "user", text: "go" }];
  await expect(runTurn(messages, provider, { signal: turn.signal })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("memory loads AGENT.md/CLAUDE.md from parents, closest last", () => {
  fs.mkdirSync("sub");
  fs.writeFileSync("AGENT.md", "root rule");
  fs.writeFileSync("sub/CLAUDE.md", "sub rule");
  const memory = loadMemory(path.join(tmp, "sub"));
  expect(memory.indexOf("root rule")).toBeGreaterThanOrEqual(0);
  expect(memory.indexOf("root rule")).toBeLessThan(memory.indexOf("sub rule"));
  process.chdir("sub");
  expect(systemPrompt()).toContain("sub rule");
});

test("memory keeps only the first 100 lines of each file", () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync("AGENT.md", lines.join("\n"));
  const memory = loadMemory(tmp);
  expect(memory).toContain("line 100\n[50 more lines");
  expect(memory).not.toContain("line 101");
});

test("slash commands: help, clear, model list/switch, effort, exit, unknown", async () => {
  const session: Session = { ...newSession(fakeProvider([])), messages: [{ role: "user", text: "hi" }] };
  expect(await handleCommand("hello", session)).toBeUndefined();
  expect((await handleCommand("/help", session))!.text).toContain("/effort");
  expect((await handleCommand("/clear", session))!.text).toContain("cleared");
  expect(session.messages).toHaveLength(0);

  const list = (await handleCommand("/model", session))!.text;
  expect(list).toContain(" 1. a");
  expect(list).toContain(" 2. b");
  expect((await handleCommand("/model 9", session))!.text).toContain("No model #9");
  await handleCommand("/model 2", session);
  expect(session.provider.model).toBe("b");
  await handleCommand("/model claude-sonnet-5", session);
  expect(session.provider.model).toBe("claude-sonnet-5");

  expect((await handleCommand("/effort", session))!.text).toContain("default");
  await handleCommand("/effort high", session);
  expect(session.effort).toBe("high");
  expect((await handleCommand("/effort turbo", session))!.text).toContain("Unknown effort");
  await handleCommand("/effort default", session);
  expect(session.effort).toBeUndefined();

  expect((await handleCommand("/exit", session))!.exit).toBe(true);
  expect((await handleCommand("/nope", session))!.text).toContain("Unknown command");
});

test("settings rules, modes and always-allow", async () => {
  const never = async () => 0;
  fs.mkdirSync(".code-agent");
  fs.writeFileSync(
    ".code-agent/settings.json",
    JSON.stringify({ permissions: { allow: ["run_command(npm test*)", "write_file(src/*)"], deny: ["run_command(cat *)", "read_file(.env)"] } }),
  );
  safety.loadSettings();
  let asked = 0;
  safety.setAsk(async () => (asked++, "no"));
  const run = (command: string) => safety.allowed("run_command", { command }, never);

  expect(await safety.allowed("run_command", { command: "cat README.md" }, async () => 0.999)).toBe(false); // deny beats Jev
  expect(await run("ls; cat x")).toBe(false); // deny sees chained pieces
  expect(await safety.allowed("read_file", { path: "./.env" })).toBe(false);
  expect(await run("npm test --watch")).toBe(true); // allow rule
  expect(await run("npm test && rm -rf x")).toBe(false); // allow rules skip chains
  expect(await safety.allowed("write_file", { path: "src/a.ts" })).toBe(true);
  expect(asked).toBe(1); // only the chained command asked

  safety.setMode("plan");
  expect(await safety.allowed("write_file", { path: "src/a.ts" })).toBe(false); // plan beats allow
  expect(await safety.allowed("read_file", { path: "x.txt" })).toBe(true);
  expect((await execute({ id: "t", name: "edit_file", input: { path: "x" } })).content).toContain("plan mode");

  safety.setMode("accept-edits");
  expect(await safety.allowed("edit_file", { path: "x.txt" })).toBe(true);
  expect(await safety.allowed("edit_file", { path: "../x.txt" })).toBe(false); // outside the project still asks

  safety.setMode("default");
  safety.setAsk(async () => (asked++, "always"));
  expect(await run("make build")).toBe(true);
  safety.setAsk(async () => (asked++, "no"));
  expect(await run("make build")).toBe(true); // remembered, no prompt
  expect(await run("make clean")).toBe(false); // only that exact command
  expect(asked).toBe(4); // chain, outside edit, make build once, make clean

  fs.writeFileSync(".code-agent/settings.json", "{bad");
  expect(() => safety.loadSettings()).toThrow();
  fs.rmSync(".code-agent", { recursive: true });
  safety.loadSettings(); // reset for other tests
});

test("/rewind, /status, /memory, /init and /export", async () => {
  const session: Session = {
    ...newSession(fakeProvider([])),
    messages: [
      { role: "user", text: "first" },
      { role: "assistant", text: "one", toolCalls: [] },
      { role: "user", text: "second" },
      { role: "assistant", text: "two", toolCalls: [] },
    ],
  };
  expect((await handleCommand("/rewind", session))?.text).toContain("2. second");
  expect((await handleCommand("/rewind 9", session))?.text).toContain("No message #9");
  await handleCommand("/rewind 2", session);
  expect(session.messages).toHaveLength(2); // back to before "second"

  expect((await handleCommand("/status", session))?.text).toContain("History: 2 messages");
  fs.writeFileSync("AGENT.md", "rules");
  expect((await handleCommand("/memory", session))?.text).toContain("AGENT.md");
  expect((await handleCommand("/init", session))?.prompt).toContain("AGENT.md");
  await handleCommand("/export out.txt", session);
  expect(fs.readFileSync("out.txt", "utf8")).toBe("> first\n\none");
});

test("usage adds up, /cost reports it, sessions save and resume", async () => {
  const usage = { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 };
  const s = newSession(fakeProvider([
    { stop: "tool_use", text: "", toolCalls: [{ id: "t1", name: "list_dir", input: {} }], usage },
    { stop: "end", text: "done", toolCalls: [], usage },
  ]));
  s.messages.push({ role: "user", text: "look around" });
  await runTurn(s.messages, s.provider, { usage: s.usage });
  expect(s.usage).toEqual({ input: 200, output: 40, cacheRead: 1800, cacheWrite: 0 });
  expect((await handleCommand("/cost", s))?.text).toContain("Cache hit rate: 90%");

  saveSession(s.id, s.messages);
  const next = newSession(s.provider);
  expect((await handleCommand("/resume", next))?.text).toContain("1. ");
  await handleCommand("/resume 1", next);
  expect(next.messages).toEqual(JSON.parse(JSON.stringify(s.messages)));
  expect(next.id).toBe(s.id); // keeps writing the same file
  expect((await handleCommand("/resume ../x", next))?.text).toContain("No session");
});

test("microcompact clears old big tool results only once the cache is cold", () => {
  const messages: Message[] = [{ role: "user", text: "go" }];
  for (let i = 0; i < 8; i++) {
    const name = i === 0 ? "edit_file" : "read_file"; // edit results are never cleared
    messages.push({ role: "assistant", text: "", toolCalls: [{ id: `t${i}`, name, input: {} }], at: 0 });
    messages.push({ role: "tool", results: [{ toolCallId: `t${i}`, content: `out ${i}`, isError: false }] });
  }
  const contents = () => messages.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.content) : []));

  expect(microcompact(messages, 60_000)).toBe(0); // 1 minute after the last call: cache warm, leave it
  expect(microcompact(messages, 10 * 60_000)).toBe(2); // 10 minutes: cold, clear all but the last 5 reads
  expect(contents()).toEqual(["out 0", CLEARED, CLEARED, "out 3", "out 4", "out 5", "out 6", "out 7"]);
  expect(microcompact(messages, 10 * 60_000)).toBe(0); // already cleared ones don't count again
});

test("compaction summarizes the history when the last prompt was too big, and /compact does it on demand", async () => {
  const sent: Message[][] = [];
  const provider: Provider = {
    name: "fake",
    model: "fake",
    complete: async (_s, messages) => {
      sent.push(messages);
      return { stop: "end", text: "User wants X. Changed a.ts.", toolCalls: [] };
    },
    listModels: async () => [],
  };
  const messages: Message[] = [
    { role: "user", text: "do X" },
    { role: "assistant", text: "ok", toolCalls: [], at: Date.now(), promptTokens: 1000 },
  ];
  expect(await compactIfFull(messages, provider)).toBe(false); // small prompt: leave it

  (messages[1] as Extract<Message, { role: "assistant" }>).promptTokens = 250_000;
  expect(await compactIfFull(messages, provider)).toBe(true);
  expect(sent[0]?.at(-1)).toMatchObject({ role: "user", text: expect.stringContaining("Summarize") });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ role: "user", text: expect.stringContaining("User wants X. Changed a.ts.") });

  const session = { ...newSession(provider), messages };
  expect((await handleCommand("/compact", session))?.text).toContain("Compacted 2 messages");
});
