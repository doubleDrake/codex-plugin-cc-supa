# Agent Teams integration — PoC notes (SUP-377)

> Status: **Spike complete (2026-05-09)**. Findings captured here; no runtime code added beyond agent prompt guidance. Re-evaluate after a few weeks of real usage.

## Question

Is it worth wiring `/codex:delegate` (or any long-running codex command) into Claude Code's Agent Teams API to get a separate pane for live progress visibility, the way the user originally proposed?

## TL;DR — recommendation

**Use Pattern B (Monitor tool) for the common case. Reserve Pattern A (Agent Teams) for sessions that run codex side-by-side with other long jobs.**

The Monitor tool already gets us 90% of what we wanted (live notifications when codex phase changes) at near-zero overhead. Agent Teams adds the genuine multi-pane experience but at meaningful token cost — the wrapper subagent has to read codex output and re-emit via SendMessage every time something changes.

The current `agents/codex-delegate.md` does NOT spawn a team. If you want the team experience, opt in explicitly per call.

## Context

`/codex:delegate <task>` runs in the foreground today. The user sees one line per turn ("Codex turn N — applied 3 files") but the actual codex inference can take 1–5 min. During that, the main thread is **blocked**: you can't ask Claude something else while Codex thinks.

Two ways to break that block:

| Pattern | Visibility | Main thread blocked? | Token overhead |
|---|---|---|---|
| **B — Monitor tool** | Notifications in main pane | No | Negligible (Bash + jq, no LLM) |
| **A — Agent Teams** | Separate pane per session | No | Wrapper agent reads + SendMessages |

## Pattern B — Monitor tool (recommended default)

Claude Code's `Monitor` tool watches a file or stdout stream and sends a notification every time a new line matches. We already write per-job progress to `~/.claude/plugins/data/codex-*/state/<workspace>/jobs/<id>.json` and an append-only log next to it.

Hooking those into Monitor:

```bash
# 1. spawn codex in background
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --delegate-mode "<prompt>"
# captures jobId from stdout

# 2. tail the per-job log (or poll progress.json) via Monitor
#    main thread keeps working; notifications arrive when phase changes
Monitor(
  description: "Codex delegate progress for jobId",
  command: "tail -F /path/to/jobs/<id>.log | grep --line-buffered -E '\\[codex\\] (Turn|Running command|Reviewer|Applying|File changes)'",
  timeout_ms: 1800000  // 30 min cap
)
```

Notifications surface inline in the main pane:

```
Codex turn started.
Codex: Running command: npm test
Codex: File changes completed.
```

### Pros

- Zero new agent / skill files
- No token cost — `tail` + `grep` is the entire pipeline
- Crashes are visible immediately (Monitor surfaces stderr; W1.2 PID liveness will catch worker death anyway)
- Composes naturally with `--background` already in `codex-companion.mjs`

### Cons

- Same pane as the main conversation — if the user wants visual separation between "main work" and "codex side-task," this doesn't deliver
- Notifications are line-by-line and can be noisy; the grep filter has to be tight

### When Pattern B falls short

- You're running 2+ delegate sessions in parallel and want to glance at each one independently
- You want a sticky "Codex is still working" indicator while you do other things
- You're orchestrating a multi-agent workflow where Codex is one of several actors (then full Agent Teams makes sense for the team primitive itself, not just visibility)

## Pattern A — Agent Teams wrapper (opt-in for parallel sessions)

Claude Code's `TeamCreate` + `Agent({ team_name, name })` give us a real subagent that occupies its own pane. To use it as a codex orchestrator:

```text
Main Claude
  └─ TeamCreate(team_name: "codex-session-2026-05-09")
  └─ Agent(
       team_name: "codex-session-2026-05-09",
       name: "codex-runner-1",
       subagent_type: "general-purpose",
       prompt: "Run codex-companion task --delegate-mode '<task>'.
                Tail the per-job log. Every time a new [codex] line appears,
                SendMessage({ to: 'main-lead', message: '<paraphrase>' }).
                When STATUS: DONE arrives, SendMessage final result and exit."
     )
```

The subagent runs in its own pane, talks to codex via Bash, and pings the main lead with `SendMessage` for every meaningful event.

### Pros

- Genuine multi-pane experience; main thread can do anything else
- Multiple delegate sessions visible side by side (each its own pane)
- Composes with `TaskCreate` for cross-team progress tracking

### Cons

- The wrapper subagent is a Claude — every time it reads a new codex log line and decides whether to SendMessage, that's Claude inference. Token cost adds up over a long codex run.
- Two layers of indirection (main → wrapper agent → bash → codex) — debugging is harder
- The progress.json file already has the data; the wrapper is rephrasing it for SendMessage. Some redundancy.
- Setup cost per session (TeamCreate, Agent spawn) is non-trivial vs. just running `Monitor`

### When Pattern A is worth the cost

- Multi-codex-session workflows (e.g., applying 5 different refactors in parallel for comparison)
- Long-running A/B tests where Codex runs over hours
- supalead-style team patterns where Codex is genuinely "another team member" alongside `Lead` + `pm` + `member-N`

## Decision matrix

| Use case | Recommended | Rationale |
|---|---|---|
| Single delegate, want live updates | **B (Monitor)** | Cheapest |
| Long codex run, want to multitask | **B (Monitor)** | Main pane stays usable |
| 2+ codex sessions in parallel | **A (Agent Teams)** | Per-pane visibility |
| Codex inside larger team workflow (Lead/pm/codex/member) | **A (Agent Teams)** | Native team primitive |
| One-shot quick task | **Neither — foreground `/codex:rescue`** | Overhead not worth it |

## What lands in this commit

- This doc.
- A short paragraph in `agents/codex-delegate.md` pointing readers here when they want to multitask. The agent does NOT auto-spawn a team — opt in by user request.
- No new commands, no new agents, no runtime code.

## Followups (deferred)

- A `/codex:delegate --pane` flag that auto-spawns the wrapper agent (Pattern A) — defer until we see real demand for parallel sessions.
- Monitor pre-canned grep filters per delegate phase (`turn-start`, `tool-call`, `file-change`, `status-done`) — defer until we observe noise patterns in actual usage.
- supalead team pattern integration — out of scope for this fork; supalead's `linear-workflow` and other domain skills already use TeamCreate independently.

## Refs

- Linear SUP-377 (this issue)
- [Claude Code Agent Teams docs](https://code.claude.com/docs/en/agent-teams)
- `agents/codex-delegate.md` (W2.3 / SUP-370) — the orchestrator that benefits from this
- `scripts/codex-companion.mjs` `task --background` (existing) — already gives us the unblock primitive
