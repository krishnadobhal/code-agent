import { Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { runTurn } from "../agent.ts";
import { handleCommand, type Session } from "../commands.ts";
import { ProviderError } from "../llm/index.ts";
import { type Answer, setAsk } from "../safety.ts";
import { ApprovalBox } from "./ApprovalBox.tsx";
import { InputBar } from "./InputBar.tsx";
import { type Item, TranscriptLine } from "./Transcript.tsx";

type Pending = { request: string; resolve: (answer: Answer) => void };

let nextId = 0;

/** The interactive app: owns the transcript, the running turn and pending approvals. */
export function App({ session, intro }: { session: Session; intro: string[] }) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>(() => intro.map((text) => ({ id: nextId++, kind: "info", text })));
  const [input, setInput] = useState("");
  const [live, setLive] = useState(""); // the reply while it streams
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const liveRef = useRef(""); // callbacks need the latest text, not the render-time copy
  const turn = useRef<AbortController>(undefined);

  const add = (kind: Item["kind"], text: string) => setItems((xs) => [...xs, { id: nextId++, kind, text }]);
  // move the streamed text into the transcript, e.g. before a tool line
  const flushLive = () => {
    if (liveRef.current.trim()) add("assistant", liveRef.current.trim());
    liveRef.current = "";
    setLive("");
  };

  useEffect(() => setAsk((request) => new Promise((resolve) => setPending({ request, resolve }))), []);

  const answer = (choice: Answer) => {
    if (!pending) return;
    const label = { yes: "allowed", no: "denied", always: "always allowed" }[choice];
    add("tool", `${label}: ${pending.request.slice(0, 120)}`);
    pending.resolve(choice);
    setPending(undefined);
  };

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      answer("no");
      if (turn.current && !turn.current.signal.aborted) turn.current.abort();
      else exit(); // idle, or a second Ctrl+C
      return;
    }
    if (!pending) return;
    const c = ch.toLowerCase();
    if (c === "y") answer("yes");
    else if (c === "a") answer("always");
    else if (c === "n" || key.return || key.escape) answer("no");
  });

  const submit = async (value: string) => {
    const text = value.trim();
    setInput("");
    if (!text) return;
    if (text === "exit" || text === "quit") return exit();
    add("user", text);

    const command = await handleCommand(text, session);
    if (command) {
      if (command.text) add("info", command.text);
      if (command.exit) exit();
      if (!command.prompt) return;
    }

    const start = session.messages.length;
    session.messages.push({ role: "user", text: command?.prompt ?? text });
    const controller = new AbortController();
    turn.current = controller;
    setBusy(true);
    try {
      await runTurn(session.messages, session.provider, {
        signal: controller.signal,
        effort: session.effort,
        onText: (delta) => {
          liveRef.current += delta;
          setLive(liveRef.current);
        },
        onTool: (line) => {
          flushLive();
          add("tool", line);
        },
      });
      flushLive();
    } catch (error) {
      flushLive();
      session.messages.splice(start); // roll back the half-finished turn so history stays valid
      if (controller.signal.aborted) add("error", "[cancelled]");
      else if (error instanceof ProviderError) add("error", `[turn aborted] ${error.message}`);
      else add("error", `[bug] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    } finally {
      turn.current = undefined;
      setBusy(false);
    }
  };

  return (
    <>
      <Static items={items}>{(item) => <TranscriptLine key={item.id} item={item} />}</Static>
      {live ? <Text>{live}</Text> : null}
      {pending ? (
        <ApprovalBox request={pending.request} />
      ) : (
        <InputBar busy={busy} value={input} onChange={setInput} onSubmit={submit} />
      )}
    </>
  );
}
