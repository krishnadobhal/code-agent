# code-agent

A small Claude Code-style coding agent for the terminal. Chat with a model that can read, search and
edit files and run shell commands in the current folder, asking you before anything risky.

Built with TypeScript on [Bun](https://bun.sh), with a React + [Ink](https://github.com/vadimdemedes/ink) terminal UI.

## Quick start

```sh
bun install
bun start            # needs ANTHROPIC_API_KEY
```

Type a request at the `>` prompt (`/help` lists commands: `/clear`, `/model` to list and pick a model, `/effort low|medium|high|xhigh|max`, `/exit`). Replies stream as they are written; Ctrl+C cancels the
current reply (twice, or at an empty prompt, quits); `exit` quits.

Project instructions: put them in `AGENT.md`, `AGENTS.md` or `CLAUDE.md`. Files in the current folder
and every parent folder are added to the model's instructions each turn.

## Models

| Backend | How |
|---|---|
| Claude (default) | `ANTHROPIC_API_KEY=...`; `LLM_MODEL` overrides the model (default `claude-opus-5`) |
| OpenAI / compatible | `LLM_PROVIDER=openai LLM_MODEL=<id>` + `OPENAI_API_KEY`; set `OPENAI_BASE_URL` for Ollama, OpenRouter, Groq, LM Studio |

Bun loads a `.env` file automatically.

## Tools

`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_command`.

## Safety

- Reads and searches inside the project run without asking.
- Writes, edits and shell commands ask for approval (`y/N`).
- Read-only commands like `git status` or `ls` skip the prompt. Commands with `; & | < > $` always ask.
- Optional: set `TYPESAFE_API_KEY` to let [Jev](https://typesafe.ai/) auto-approve other commands it is
  very sure only read. Without the key, those commands ask.

## Development

```sh
bun test             # tests (no real API calls)
bun run typecheck    # tsc --noEmit
```
