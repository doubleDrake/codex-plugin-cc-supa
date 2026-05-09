# supalead team pattern integration (SUP-380)

How `/codex:delegate --pane` interacts with the existing supalead team workflow (Lead + pm + member-N + linear-workflow + pr-review skills).

This doc is fork-internal but **codex-plugin-cc-supa stays generic** — runtime code does not depend on supalead. Behavior described here is implemented entirely in `agents/codex-delegate.md` prompt rules, so other downstream forks can replace this doc with their own team conventions without touching code.

## The setup we're integrating with

In a supalead Claude session you commonly have:

- **`Lead`** — the main session you're in. Drives architecture decisions, reviews PRs, runs Linear updates.
- **`pm`** — a planning/issue-tracking agent spawned for multi-step work.
- **`member-1` ... `member-N`** — implementation agents spawned per task / per worktree.
- **Skills**: `linear-workflow`, `pr-review`, `pre-merge`, `pr-create`, `ml-analysis-workspace`, etc. — each can spawn its own subagents.

The team primitive is shared: `TeamCreate / TeamDelete`, `Agent(team_name, name)`, `SendMessage(to)`. A single Claude session can have one team active at a time (with multiple members in it), or no team (single Claude doing everything).

## Two integration cases

### Case 1 — Codex delegate inside an existing team

You're already running a supalead team session (e.g. mid-Wave PR rollout with `Lead` + `pm` + `member-1`). You hit a refactor that's better delegated to Codex. User runs `/codex:delegate --pane <task>`.

**Wrong**: spawn a new team `codex-session-...`. That creates an orphan team dir alongside the one already in use; `SendMessage` calls cross-team don't work the way the user expects, and the supalead team's task list is in a different `~/.claude/teams/<existing>/` than the codex session's.

**Right**: reuse the existing team. The runner agent joins under the same `team_name`:

```
1. Read ~/.claude/teams/<existing-team-name>/config.json to get the active team.
2. Agent({
     team_name: "<existing-team-name>",  // NOT a new team
     name: "codex-runner-<n>",            // unique name within the team
     subagent_type: "general-purpose",
     prompt: <delegate prompt>
   })
3. The runner SendMessage's to the team Lead (whoever spawned this session)
   on phase changes; finishes; main moves on. No TeamDelete from this side
   because we didn't create the team.
```

The `agents/codex-delegate.md` rule for `--pane` already says *"reuse existing team if any"* — this doc is the why.

### Case 2 — Codex delegate with no active team

User is in a single-Claude session (no `pm`, no `member-N`). Hits `/codex:delegate --pane <task>`. There's no existing team to join.

**Right**: create a fresh team scoped to the codex session:

```
1. TeamCreate({
     team_name: "codex-session-<short-ts>",
     description: "Codex delegate: <task one-liner>"
   })
2. Agent(...) into that team as before.
3. On STATUS: DONE, TeamDelete the codex-session team.
```

This is the Pattern A flow from `docs/agent-teams-poc.md` verbatim. No special-casing.

## Conflict scenarios and how the rule resolves them

| Situation | What `--pane` does |
|---|---|
| supalead team active, member-1 currently running unrelated work | Codex runner joins same team as `codex-runner-<n>`. Lead can see both panes. |
| supalead team active, no other members busy | Same as above. |
| No team at all | Create dedicated `codex-session-<ts>` team, delete on done. |
| linear-workflow currently in middle of a multi-step grooming | Codex runner joins linear-workflow's team if it spawned one; otherwise a fresh team. linear-workflow already idle-cycles its own members, so no resource conflict. |
| Two `--pane` calls in quick succession | Each gets its own `codex-runner-<n>` (different `name`) inside whichever team is active. Both run in parallel; SendMessage routes by `name`. |

## What this means for the user

- Default behavior is invisible — no flag, single pane, foreground.
- `--background` opts into Pattern B (Monitor + main pane notifications).
- `--pane` opts into Pattern A. If a supalead team is already running, the codex runner shows up alongside `pm` / `member-N` etc. without setup ceremony.
- `TeamDelete` is the runner's responsibility only when the runner created the team. Existing teams are never auto-deleted by the codex flow.

## Non-goals

- The codex plugin does not register itself as a supalead team member proactively. Users explicitly choose `--pane` per delegate.
- The codex plugin does not modify supalead's `~/.claude/teams/<name>/config.json` schema or read fields outside `name` / `members`.
- The fork makes no assumption about which supalead skills are loaded. If the user uninstalls supalead's domain skills, `--pane` still works — just creates a fresh `codex-session-<ts>` team every time.

## Refs

- Linear SUP-380 (this doc)
- `agents/codex-delegate.md` `--pane` flow (consumer)
- `docs/agent-teams-poc.md` (parent decision matrix)
- supalead `linear-workflow` skill (independent — uses its own team_name conventions; no integration code from this fork)
