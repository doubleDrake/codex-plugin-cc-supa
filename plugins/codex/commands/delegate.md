---
description: Delegate a multi-step task to Codex with the A+ pattern — Codex proposes diffs (read-only), Claude applies them and reports back, looping until DONE
argument-hint: "[--background|--wait] [--pane] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--no-auto-context] <task description>"
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

Execution models:

There are two ways to run a delegate. The default is unchanged; the second is new.

**(a) DEFAULT — subagent path (INV-1, unchanged).** Invoke the `codex:codex-delegate` subagent via the `Agent` tool exactly as described above. This is the single-delegate, turn-by-turn UX and stays the default for every `/codex:delegate` invocation. `--background`, `--wait`, and `--pane` continue to select Claude Code execution mode within this path. Nothing about this path changes — it remains the path the rest of this command documents.

**(b) NEW — Workflow-native path.** When the user wants **several delegations at once** (e.g. "delegate these three refactors in parallel"), or wants **each delegation isolated in its own git worktree**, run the **Workflow tool** with `workflows/codex-delegate.js` instead of spawning the subagent yourself. That Workflow:
- Takes a list of task descriptions from `args` (one or many).
- For each task, runs the STATUS ping-pong as a deterministic JS `while` loop, calling `agent({ agentType: "codex:codex-delegate", isolation: "worktree", prompt, schema })` until the result signals `STATUS: DONE` or a 5-turn cap.
- Uses `pipeline()` / `parallel()` so multiple tasks run concurrently, each in its own auto-created / auto-cleaned worktree.
- Runs in the background and notifies on completion.

The Workflow expresses the team-bridge STATUS loop and worktree isolation natively, so for parallel / isolated orchestration it supersedes the hand-rolled `codex-team-bridge` + `codex-pane-helper` skills.

**`--pane` remains the Agent-Teams opt-in.** When the user wants an **interactive live teammate** they can SendMessage mid-run (human-in-the-loop), keep using `--pane` (subagent path + the team bridge). The Workflow path is for deterministic orchestration, not live human-in-the-loop chat — it can't do that one case.

Decision:

```
several tasks at once, or each isolated in a worktree?  → Workflow-native path (workflows/codex-delegate.js)
interactive live teammate (SendMessage mid-run)?        → --pane (subagent + team bridge)
otherwise                                               → DEFAULT subagent path (unchanged)
```

Examples:

```
/codex:delegate refactor the auth middleware to use JWT tokens
/codex:delegate find and fix the race condition in OrderService
/codex:delegate --model gpt-5.5 migrate the cache layer from in-memory to Redis
/codex:delegate --no-auto-context just answer this — what does this regex do?
```

Refs Linear SUP-369 (Wave 2.1+2.2). See `prompts/delegate.md` for the prompt template Codex receives, and `agents/codex-delegate.md` for the orchestration loop.
