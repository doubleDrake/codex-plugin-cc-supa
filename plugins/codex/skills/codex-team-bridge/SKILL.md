---
name: codex-team-bridge
description: Translate layer between Codex (which knows nothing about Agent Teams) and Claude Code's SendMessage / Agent / TeamCreate primitives. Use this skill when an agent in a team is wrapping codex-companion calls and needs to relay codex events to team-lead, or relay team-lead decisions back to codex on STATUS: NEEDS_FOLLOW_UP. Loads inside agents/codex-delegate.md, can be reused by any other team-aware agent that wraps codex-companion.
---

# codex-team-bridge — translation layer

Codex (OpenAI) does not see Claude Code's team primitives. It does not know about `SendMessage`, `team_name`, `Agent` tool, inboxes, idle wakeup, or `TeamDelete`. It only knows the rules in `prompts/delegate.md` and its own thread (`--resume-last` for follow-ups).

You — the wrapping Claude agent — are the **bridge**. Your job is to translate between two protocols:

| Side | Protocol |
|------|----------|
| **Codex side** | stdin/stdout via `Bash`. Input = `task --delegate-mode <prompt>` (or `--resume-last "..."`). Output = stderr `[codex] ...` event lines + final stdout response shaped per `prompts/delegate.md` (TASK / MUST DO / VERIFICATION / NOTES / STATUS). |
| **Team side** | `SendMessage(to: "<member-name>", message: "...")` for outbound. Inbox auto-delivers inbound messages from teammates on your next turn. `Agent` / `TeamCreate` / `TeamDelete` for lifecycle. |

This skill defines the standard procedure. Agents that load this skill should follow it without re-deriving.

## When this skill applies

Load this skill when:

- An agent is spawned via `Agent({ team_name, name, subagent_type })` to wrap codex-companion calls (Pattern A from `docs/agent-teams-poc.md`).
- An agent is processing a multi-turn delegate that may produce `STATUS: NEEDS_FOLLOW_UP`.
- A custom team-aware agent (not just codex-delegate) is wrapping `task --delegate-mode`.

Do NOT load this skill when:

- The user runs `/codex:delegate` foreground without `--pane` (no team involved; no SendMessage path).
- An agent is wrapping codex-companion `task --write` (not delegate; codex applies directly; no NEEDS_FOLLOW_UP loop expected).
- An agent only needs codex output verbatim with no team context (use `codex:codex-rescue` thin forwarder instead).

## Two paths: schema-driven (Path 2, default) vs prose-extraction (Path 1, fallback)

Since SUP-383 the bridge has two delivery modes, parallel not exclusive:

- **Path 2 (default, codex-driven):** codex emits a single fenced `\`\`\`json codex-tool-calls\`\`\`` block in its response. The codex-companion runtime parses + validates + dispatches that block automatically — `team_send`, `edit_file`, `write_file`, `run_bash`, `ask_lead`, `push_notification`, `todo_write`. Nothing for the bridge agent (you) to do for those calls. Schema lives at `schemas/codex-tool-calls.schema.json`.
- **Path 1 (bridge-driven, fallback):** if codex didn't emit a tool-call block, or the block was schema-rejected, **you** apply the procedure below — parse STATUS marker, SendMessage on NEEDS_FOLLOW_UP, etc.

In practice you'll see both: codex emits `team_send` markers via JSON for routine phase updates, and you handle `STATUS: NEEDS_FOLLOW_UP` semantics for the agent-level pause/resume contract. The two layers compose.

The procedure below describes Path 1 (your responsibility). For Path 2 details see `prompts/delegate.md`'s "Tool calls — schema-validated bridge" section and the schema file.

## Procedure

### 1. Initial run

After receiving the task from your spawn prompt or via `SendMessage` from team-lead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --delegate-mode \
  [--model <model>] [--effort <effort>] \
  "<auto-context block>\n\n<user task>"
```

Capture stdout (the codex response) and stderr (the `[codex]` event stream). The first turn always opens a fresh thread; subsequent turns inside the same loop must use `--resume-last`.

### 2. Surface one phase update to team-lead

While codex runs, stderr emits `[codex] ...` lines. Pick exactly **one** representative event per turn and SendMessage it. Pick the most informative line — typically the most recent `[codex] Running command:`, `[codex] Reviewer started:`, `[codex] Applying:`, or the equivalent. Don't spam phase updates; one per turn keeps the team channel readable.

Phrase the update as a one-liner:

```
SendMessage({
  to: "team-lead",
  message: "Codex turn 1 — running: rg -n 'broker|idle' CHANGELOG.md"
})
```

### 3. Parse the trailing STATUS marker

The final line of the codex response is `STATUS: <DONE|NEEDS_FOLLOW_UP>`. If neither marker appears (treat as Branch 3 below), stop and SendMessage team-lead about the malformed response. Don't apply anything.

### 4. Branch on STATUS

#### Branch 1 — `STATUS: DONE`

1. Apply the final `MUST DO` block (Pattern A: forward to team-lead via SendMessage including the diff and let them apply via `Edit` / `Write`; foreground: apply yourself).
2. SendMessage team-lead with one summary line:
   ```
   "Done. Codex applied N file changes. Verification passed/failed: <result>."
   ```
3. Return your final agent message (a 2–4 line summary plus the codex response verbatim if useful).

#### Branch 2 — `STATUS: NEEDS_FOLLOW_UP` (the ping-pong path)

1. Extract the actual question from the codex response. Look in `NOTES` first; if absent, use the last paragraph before the STATUS marker.
2. SendMessage team-lead with three pieces:
   - The question itself.
   - One line of context (where in the task this came up).
   - Any options codex listed (if it framed the choice as a/b/c).

   Example:
   ```
   SendMessage({
     to: "team-lead",
     message: "Codex needs a decision: should the comment be a JSDoc block or an inline trailing comment? Context: codex started analyzing scripts/codex-companion.mjs MODEL_ALIASES and wants to confirm style. Options it listed: (a) JSDoc, (b) inline."
   })
   ```
3. **Go idle.** Your inbox automatically wakes you when team-lead replies. Do not poll. Do not start a new Bash call. Idle is a normal state, not a failure.
4. When team-lead replies, parse the answer (or paraphrase if free-form).
5. Run codex `--resume-last` with the answer:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --delegate-mode --resume-last \
     "team-lead chose: <answer>. Continue from where you stopped."
   ```
6. Loop back to step 2 (one phase update) → step 3 (parse STATUS) → branch.

#### Branch 3 — STATUS marker missing or unrecognized

The codex response did not follow the prompts/delegate.md format. Don't guess or apply.

```
SendMessage({
  to: "team-lead",
  message: "Codex returned a malformed response — no STATUS marker. The last 200 chars: <excerpt>. Should I (a) re-prompt with a stricter format reminder via --resume-last, or (b) abort the thread?"
})
```

Then go idle and wait for team-lead's choice.

## Hard cap

Five round trips total per task. Counter starts at the first `STATUS: NEEDS_FOLLOW_UP`; each subsequent NEEDS_FOLLOW_UP increments it.

When the counter hits 5, do NOT send the answer to codex automatically. Instead:

```
SendMessage({
  to: "team-lead",
  message: "Codex hit the 5-turn ping-pong cap on this task. Either the requirement is too ambiguous, or codex is looping. Should I (a) abort the thread, (b) pass an explicit summary back to codex with --resume-last and try once more, or (c) hand the diff so far to you for manual continuation?"
})
```

Idle and wait.

## Translation cheat-sheet

| Codex says (in response) | You do (toward team-lead) |
|--------------------------|---------------------------|
| `STATUS: DONE` + final `MUST DO` | Apply or forward diff; SendMessage 1-line summary; return |
| `STATUS: NEEDS_FOLLOW_UP` + question in NOTES | SendMessage question + context + options; idle |
| `STATUS: NEEDS_FOLLOW_UP` + verification command request | SendMessage "Codex wants to verify with `<cmd>`. Run it?" if non-trivial; idle |
| Raw stderr `[codex] error:` | SendMessage error excerpt; idle for team-lead's call |
| Empty / truncated response | Branch 3 — malformed |

| team-lead says (inbound SendMessage) | You do (toward codex) |
|--------------------------------------|------------------------|
| Decisive answer ("use option a", "yes apply") | `--resume-last "team-lead chose: <answer>. Continue."` |
| Free-form clarification | `--resume-last "team-lead clarified: <paraphrase>. Continue."` |
| Abort instruction | Don't resume. SendMessage final "Aborted by team-lead." Return. |
| Request for current diff | SendMessage current MUST DO block. Idle for further direction. |

## What this skill does NOT do

- It does not decide content. The codex thread is the brain; team-lead is the source of intent. The bridge agent never invents answers, never edits diffs, never alters codex's STATUS marker.
- It does not handle the foreground `--wait` flow. That's `agents/codex-delegate.md` direct loop, no team SendMessage involved.
- It does not handle Pattern B (Monitor). Pattern B is non-team; this skill is team-only.

## Refs

- Linear SUP-381 (this skill)
- `agents/codex-delegate.md` (primary consumer; loads this skill)
- `prompts/delegate.md` (defines the STATUS / TASK / MUST DO / VERIFICATION / NOTES contract this skill parses)
- `docs/agent-teams-poc.md` Pattern A (the architectural decision this skill operationalizes)
- `docs/supalead-team-integration.md` (handles "join existing team" before this skill applies)
