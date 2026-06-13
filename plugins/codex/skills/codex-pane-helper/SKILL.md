---
name: codex-pane-helper
description: Spawn a separate tmux pane for a Codex delegate run via Claude Code's Agent Teams primitive. Use when the user invokes /codex:do --pane or /codex:delegate --pane, or when the orchestrator decides background isolation would benefit from a dedicated pane. Handles the full TeamCreate → Agent spawn → SendMessage routing → cleanup lifecycle so each caller doesn't have to re-derive the procedure.
---

# codex-pane-helper — `--pane` automation

> **Deprecated (Workflow-native delegate supersedes this).**
> Workflow's `isolation: "worktree"` plus the `agent({ agentType: "codex:codex-delegate", ... })` lifecycle in `workflows/codex-delegate.js` replace **steps 2–5** below (spawn runner → initial dispatch → message monitoring → cleanup): the harness auto-creates and auto-cleans a per-agent git worktree and notifies on completion, so there is no TeamCreate/Agent/SendMessage/TeamDelete lifecycle to hand-roll for orchestration.
> Only **step 1 (reuse-vs-create team detection)** stays relevant, and only for the **`--pane` interactive case** — a live teammate the user can SendMessage mid-run, which a Workflow can't do. This skill **will be removed in a future release**. Do not delete it yet. The body below is unchanged for the `--pane` case.

This skill packages the five-step Pattern A flow (originally inlined in `agents/codex-delegate.md` per W5 SUP-378) so any team-aware agent can drop into a separate-pane Codex run without re-deriving the procedure. The skill IS the procedure; the caller just needs to follow the steps in order.

Refs:
- Pattern A vs Pattern B decision matrix: `docs/agent-teams-poc.md`
- Supalead team handoff rules: `docs/supalead-team-integration.md`
- Translation layer for the codex stdin/stdout side: `codex-team-bridge` skill (loaded automatically by codex-delegate)

## When to load this skill

Load when **any** of these holds:

- The user passed `--pane` to `/codex:do` or `/codex:delegate`.
- An orchestrator agent decided isolation in a separate pane is the right cost/benefit (long-running task, parallel work, user wants real-time visibility without polluting the main thread).
- A new team-aware agent (not just codex-delegate) wants the same lifecycle.

Do **not** load when:

- The user passed `--background` without `--pane` — that's Pattern B (Monitor), no team needed.
- The user passed `--wait` (or no flag) — that's foreground, no team needed.
- You're already inside a different team-spawned session that owns the pane lifecycle.

## Procedure (the five steps)

### Step 1 — decide reuse vs create

Reuse an existing team if it makes sense; otherwise create.

- **Reuse**: if `process.env.CLAUDE_TEAM_NAME` is set (you're already in a team) OR a supalead-style team is in scope (read `~/.claude/teams/<team-name>/config.json` and look for an active Lead). In that case, **skip TeamCreate** and add the runner as a member of the existing team. Mid-session orphan teams are a real failure mode — see `docs/supalead-team-integration.md`.
- **Create**: otherwise, mint a new team scoped to this codex run.

```js
TeamCreate({
  team_name: `codex-session-${Date.now().toString(36).slice(-6)}`,  // short, collision-resistant
  description: `Codex delegate: ${shortTaskSummary}`,
  // No icon — TeamCreate rejects emoji icons (verified in W5).
})
```

Track `teamWasCreatedHere` (boolean) so step 5 knows whether to clean up.

### Step 2 — spawn the runner

```js
Agent({
  team_name: "<team-name>",
  name: `codex-runner-${shortId}`,
  subagent_type: "codex:codex-delegate",   // not "general-purpose" — codex-delegate has the loop logic
  prompt: `team_name="${teamName}", agent_name="codex-runner-${shortId}".
When invoking codex-companion, prepend:
  CLAUDE_TEAM_NAME="${teamName}" CLAUDE_AGENT_NAME="codex-runner-${shortId}" \\
    node ...
This is required for codex-tool-calls JSON blocks (team_send / ask_lead /
push_notification / todo_write) emitted by codex to dispatch successfully.

${autoContextBlock}

${userTaskText}`
})
```

- `subagent_type: "codex:codex-delegate"` is critical — it loads `codex-team-bridge` skill automatically and knows the STATUS protocol. Don't downgrade to `general-purpose` and re-implement the loop.
- **Env injection is NOT automatic** (verified W6 codex-native-test, 2026-05-10): Claude Code Agent Teams runtime does not auto-inject `CLAUDE_TEAM_NAME` into the runner's process env. The spawn prompt must tell the runner to prepend these vars when calling codex-companion. Without them, codex-tool-calls block dispatch hits `no team context (CLAUDE_TEAM_NAME unset)` and team-bound tools are skipped.
- `prompt` should already include the Auto-Context block; the runner does not re-collect it.

### Step 3 — initial dispatch

After spawn, send the user task message:

```js
SendMessage({
  to: `codex-runner-${shortId}`,
  text: userTaskText,
  summary: "Initial delegation"
})
```

Often this is unnecessary because the spawn `prompt` already contains the task; if so, **skip step 3**. Send a SendMessage only when you need to add context the spawn prompt didn't carry (e.g. the runner needs a follow-up clarification before starting).

### Step 4 — bidirectional message monitoring

The runner reports back via `SendMessage(to: "team-lead", ...)` (or whatever `CLAUDE_AGENT_NAME` the orchestrator runs as). Inbox messages auto-deliver — you do NOT need to poll.

While the runner works, you can:

- Continue with whatever the user asked you to do alongside (Pattern A's whole point is multitasking).
- Idle is normal; the runner sends meaningful updates as `[codex]` events fire (1 phase update per turn, plus STATUS marker on completion).
- When you receive a `STATUS: DONE` SendMessage from the runner, proceed to step 5.
- When you receive `STATUS: NEEDS_FOLLOW_UP`, parse the question, decide the answer (or escalate to user via `AskUserQuestion`), and reply via SendMessage; the runner resumes.
- When 5+ NEEDS_FOLLOW_UP rounds happen, the runner will surface a hard-cap escalation per `codex-team-bridge` skill — at that point ask the user what to do.

### Step 5 — cleanup

When the runner emits `STATUS: DONE` and you've applied / verified everything:

- If `teamWasCreatedHere` is true: `TeamDelete()` (removes team dir + inboxes).
- If false (team was reused): just remove the runner via the agent's natural shutdown — do **not** TeamDelete; you'd kill the supalead team's other members.

Either way, don't leave the runner agent dangling — confirm it's shut down before reporting completion to the user.

## Error handling

| Failure | Action |
|---|---|
| `TeamCreate` rejected (e.g. icon, name collision) | Retry once with a different team_name suffix. If still failing, fall back to Pattern B (Monitor) and tell the user. |
| `Agent` spawn returned but the runner never sends a turn-1 phase update within 60 s | Check the per-job log under `~/.claude/plugins/data/codex-*/state/<workspace>/jobs/`. If the codex-companion process is stuck, send the runner a SendMessage asking for status; if no reply, kill the runner agent and TeamDelete (if `teamWasCreatedHere`). |
| `SendMessage` to runner returns "recipient not found" | The runner died unexpectedly. Check logs, surface to user. |
| Runner emits a malformed STATUS-less message | Per `codex-team-bridge` skill: SendMessage runner asking for the contract, do not apply anything. |
| User asked to abort mid-run | SendMessage runner "aborted by user", wait for it to acknowledge, then proceed to step 5. |

## What this skill does NOT do

- It does not write to files itself — that's the codex-delegate runner's job.
- It does not forward `--write` semantics — Pattern A is about pane isolation, not write authority.
- It does not handle Pattern B (Monitor + tail). Pattern B is non-team — use `Monitor` directly per `agents/codex-delegate.md`.
- It does not loop forever — the 5-turn hard cap from `codex-team-bridge` applies; this skill just packages the lifecycle.

## Quick reference

```
caller (codex-delegate or other agent)
   │
   ├─ load this skill
   │
   ├─ Step 1: reuse-or-create team   ─→  team_name, teamWasCreatedHere
   │
   ├─ Step 2: Agent({ subagent_type: "codex:codex-delegate", ... })
   │
   ├─ Step 3: (optional) initial SendMessage
   │
   ├─ Step 4: handle inbound SendMessage from runner
   │             │
   │             ├─ STATUS: DONE       → step 5
   │             ├─ STATUS: NEEDS_FOLLOW_UP → reply, loop
   │             └─ malformed / hardcap → escalate
   │
   └─ Step 5: TeamDelete() if teamWasCreatedHere
```

Refs Linear SUP-386 (W6.C). Sister skills: `codex-team-bridge` (the codex stdin/stdout side, loaded by codex-delegate). Sister docs: `docs/agent-teams-poc.md` (when to pick Pattern A), `docs/supalead-team-integration.md` (handoff with existing team).
