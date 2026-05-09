---
description: Delegate a multi-step task to Codex with the A+ pattern — Codex proposes diffs (read-only), Claude applies them and reports back, looping until DONE
argument-hint: "[--background|--wait] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--no-auto-context] <task description>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent, Edit, Write, Read, Grep, Glob
---

Invoke the `codex:codex-delegate` subagent via the `Agent` tool (`subagent_type: "codex:codex-delegate"`), forwarding the user's task description as the prompt.

`codex:codex-delegate` is a **multi-turn orchestrator**, not a thin forwarder. It:

1. Drives the first Codex turn in `--delegate-mode` (sandbox: `read-only`, `persistThread: true`).
2. Parses Codex's response — extracts the unified diff or structured change set.
3. Applies the changes with `Edit` / `Write`, runs verification commands the user / repo expects (e.g. `npm test`).
4. Sends a follow-up turn with the verification result, asking Codex for the next step.
5. Loops until Codex emits `STATUS: DONE` (or 5+ turns trigger a confirm via `AskUserQuestion`).

Use `/codex:rescue` instead when:
- The task is small enough for one turn (single-file fix, trivial chore).
- You want Codex to write directly with `--write` (workspace-write sandbox).

Use `/codex:delegate` when:
- The task spans multiple files / verification steps and benefits from turn-by-turn progress.
- You want explicit separation of concerns: Codex thinks, Claude applies.

Raw user request:

$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-delegate` subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither is present, default to **foreground** (delegate is interactive — turn-by-turn updates are the point).
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to the underlying `task` calls, and do not include them in the natural-language task text.
- `--model`, `--effort`, `--no-auto-context` are runtime-selection flags. Preserve them for the forwarded `task` calls, but do not include them in the natural-language task text.

Operating rules:

- The subagent runs the multi-turn loop. Do **not** poll `/codex:status` from this command (the subagent uses its own thread).
- Default to a **read-only** Codex sandbox. The whole point of A+ is that Claude is the only writer.
- If the user explicitly asks for `--write`, redirect them to `/codex:rescue --write` (delegate is read-only by contract).
- Leave `--effort` unset unless the user explicitly asks.
- Leave `--model` unset unless the user explicitly asks. If they ask for `spark`, map it to `--model gpt-5.3-codex-spark`.
- Auto-Context (cwd / branch / git status / recent commits / modified files) is **on by default**. Pass `--no-auto-context` to opt out.

Examples:

```
/codex:delegate refactor the auth middleware to use JWT tokens
/codex:delegate find and fix the race condition in OrderService
/codex:delegate --model gpt-5.4 migrate the cache layer from in-memory to Redis
/codex:delegate --no-auto-context just answer this — what does this regex do?
```

Refs Linear SUP-369 (Wave 2.1+2.2). See `prompts/delegate.md` for the prompt template Codex receives, and `agents/codex-delegate.md` for the orchestration loop.
