# Changelog

All notable changes vs upstream `openai/codex-plugin-cc` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Linear Project: [codex-plugin-cc-plus fork](https://linear.app/supalead/project/codex-plugin-cc-plus-fork-codex-안정성-a-delegate-990176b8d08b)

## [Unreleased]

### Fixed — adversarial review follow-ups (W1 hardening)

`/codex:adversarial-review` against the W1 stability fixes turned up three real edge cases. All addressed in the same commit; no new public API.

- **Fix #1 (high) — `sendBrokerShutdown` socket leak on timeout** — `lib/broker-lifecycle.mjs`
  - Previously, the 5 s timeout resolved the promise but did NOT close the underlying `net.Socket`. A referenced open socket could keep the SessionEnd hook process alive — defeating the timeout in the exact case it was meant to fix (broker accepts but never replies).
  - Now `socket.destroy()` runs in the `finish()` path before resolving, plus the resolution carries a `{ timedOut }` payload for callers that want to record telemetry.
- **Fix #2 (high) — `crashed` transition is now persisted** — `lib/job-control.mjs`
  - Previously `enrichJob` set `status: "crashed"` only on the in-memory copy. Stored jobs stayed `running`, so `resolveResultJob` refused to fetch them via `/codex:result`, and `resolveCancelableJob` could still target a dead PID (false-positive kill risk under PID reuse).
  - Now the transition writes back to both `state.json` (via `upsertJob`) and the per-job `<id>.json` file. `resolveResultJob` accepts `crashed` as a finished state. `resolveCancelableJob` runs an enrichment pass first, then filters out jobs whose PID is gone — preventing stale-PID kills.
- **Fix #3 (medium) — broker idle shutdown clears `broker.json`** — `app-server-broker.mjs`
  - Previously the idle-timeout shutdown removed only the unix socket and pid file; the persisted `broker.json` session was left behind. A subsequent `/codex:setup` or status would try to reuse the dead endpoint.
  - Now `clearBrokerSession(cwd)` runs in `shutdown(server)` for both signal-driven and idle-timeout paths.

### Added — schema-validated tool calls (SUP-383) — codex emits, companion dispatches

User feedback after the live `--pane` demo: "translate it via a schema (sh/yaml/json) so codex can't freelance and Claude/Codex updates only touch the schema." Path 2 from the agent-teams-poc spike, fully implemented.

- New `plugins/codex/schemas/codex-tool-calls.schema.json` — JSON Schema (draft 2020-12) defining 7 tool calls codex is allowed to emit. Schema is THE contract; updates to Claude Code or Codex change only this file.
- New `plugins/codex/scripts/lib/codex-tool-calls.mjs` (~340 LoC, zero deps): fence regex `\`\`\`json codex-tool-calls\`\`\``, JSON.parse + manual schema validator (Ajv-free, cc-upstream policy), dispatcher with per-tool handler.
- 7 tools: `team_send` (inbox direct write — SendMessage equivalent), `edit_file` / `write_file` / `run_bash` (file ops), `ask_lead` (decision request → team_send), `push_notification` (stderr + team_send fallback), `todo_write` (formatted team_send for team-lead's TodoWrite tool).
- `scripts/codex-companion.mjs` `executeTaskRun` integrates: when `delegateMode` is set and the codex response contains a fenced tool-calls block, parse → validate → dispatch → report results to stderr (`[codex-tool-calls] ...`) + payload (`payload.toolCalls`). All other paths bypass.
- `prompts/delegate.md` adds a "Tool calls — schema-validated bridge" section with the table of 7 tools, an example block, and hard rules (one block per turn, schema is contract, don't quote in NOTES).
- `skills/codex-team-bridge/SKILL.md` (SUP-381) now distinguishes Path 2 (codex-driven, automatic) from Path 1 (bridge-driven, fallback). Bridge agent's responsibility shrinks to STATUS marker / NEEDS_FOLLOW_UP semantics; routine phase updates are codex-emitted JSON.

Why JSON not YAML: cc-upstream stays npm-clean (no js-yaml), `JSON.parse` handles nested arrays/objects, codex is fluent in JSON output. Mini-YAML parser was attempted and abandoned after `todo_write.items` (nested array of objects) broke it.

Verified end-to-end via isolated test: 7-tool sample block parses, validates with 0 errors, dispatches the file/bash/notification calls cleanly; team-bound calls correctly fail-fast on `CLAUDE_TEAM_NAME` unset; bare `\`\`\`json` blocks (no `codex-tool-calls` tag) are ignored.

Refs SUP-381 (codex-team-bridge skill), SUP-382 (inbox spike). Sources surveyed for tool selection: [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts), [zep-us/claude-system-prompt](https://github.com/zep-us/claude-system-prompt), [Yuyz0112/claude-code-reverse](https://github.com/Yuyz0112/claude-code-reverse), [Kir Shatrov's Reverse engineering Claude Code](https://kirshatrov.com/posts/claude-code-internals), [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

### Added — codex-team-bridge skill (SUP-381) — translation layer

User feedback during the live `--pane` demo: ping-pong rules belong in a skill, not inlined in agent prompts. Reasons: progressive disclosure, reuse across team-aware agents, clearer responsibility boundary. The skill IS the translate layer between Codex (which knows nothing about Agent Teams) and Claude Code's SendMessage / Agent / TeamCreate primitives.

- New `plugins/codex/skills/codex-team-bridge/SKILL.md` (~140 lines): full procedure for an agent that wraps `codex-companion task --delegate-mode` inside a team — initial run, phase update to team-lead, parse STATUS, three branches (DONE / NEEDS_FOLLOW_UP / malformed), 5-turn hard cap, plus a translation cheat-sheet of "Codex says X → bridge does Y" and "team-lead says X → bridge does Y".
- `agents/codex-delegate.md` frontmatter `skills` extended with `codex-team-bridge`. The "Bridging Codex ↔ team-lead" section in the agent now points to the skill instead of inlining the full procedure (~30 lines moved out, ~15 left as quick summary).
- Reusable: any future team-aware agent that wraps codex-companion can pull the same skill (e.g. a `codex-rescue` variant that joins a supalead team).

### Fixed — fork-original docs reference gpt-5.5 (default era for this fork)

- `commands/delegate.md` and `commands/consult.md` example invocations updated from `--model gpt-5.4` to `--model gpt-5.5` to match the current codex CLI default era. Fork-original files only; cc-upstream files (`agents/codex-rescue.md`, `README.md`, `tests/*`, `skills/gpt-5-4-prompting/SKILL.md`) keep upstream's wording to stay rebase-clean. The `gpt-5-4-prompting` skill name is upstream's helper name (5.4-era); it applies equally to 5.5 and renaming would diverge from cc.

### Documented — Agent Teams spike (SUP-377) + W5 follow-ups (SUP-378/379/380)

SUP-377 spike done as research + docs only. The three deferred follow-ups landed together so the multitasking story is complete instead of in pieces.

- **SUP-377** — `docs/agent-teams-poc.md` captures Pattern A (Agent Teams) vs Pattern B (Monitor tool) decision matrix.
- **SUP-378** — `commands/delegate.md` gains `--pane` flag (argument-hint only — runtime stays in `agents/codex-delegate.md`). When `--pane` is set the orchestrator opts into Pattern A: TeamCreate (or join existing), Agent spawn, SendMessage on phase events, TeamDelete on STATUS: DONE if it created the team.
- **SUP-379** — `docs/monitor-filters.md` ships four pre-canned grep packs (`progress` / `verbose` / `terminal-only` / `errors-only`) for the Pattern B `Monitor` invocation. `agents/codex-delegate.md` references the `progress` pack as the canonical default. Patterns matched against the live transcript captured during testing.
- **SUP-380** — `docs/supalead-team-integration.md` defines the rule for joining an existing supalead team (`Lead` + `pm` + `member-N`) instead of spawning a parallel codex-session team. Runtime code stays generic; supalead-specific behavior lives entirely in agent prompt rules.
- `agents/codex-delegate.md` allowed-tools extended to include `Agent`, `SendMessage`, `TeamCreate`, `TeamDelete`, `Monitor` so the new flows actually work.

The decision flow is now:

- neither `--pane` nor `--background` → foreground turn-by-turn (default)
- `--background` → Pattern B (Monitor with `progress` pack)
- `--pane` → Pattern A (Agent Teams; reuse existing team if any)

## [1.0.4-supa.1] — 2026-05-09 (MVP complete)

All twelve MVP sub-issues from the Linear Project are now merged to `main`. The fork delivers stability fixes that upstream has been sitting on for 1.5+ months, plus the A+ delegate / consult / stateful-thread workflow on top.

### Wave 1 — P0 stability (commit `2b576cf`)

- **SUP-366** [P1.1] Broker idle timeout — `app-server-broker.mjs` self-shuts down after 10 min idle (env override `CODEX_BROKER_IDLE_MS`). Defense-in-depth alongside SessionEnd hook. (cc#108)
- **SUP-367** [P1.2] PID liveness check + `crashed` auto-transition — `lib/job-control.mjs` `enrichJob` runs `kill -0 <pid>` on running/queued jobs and surfaces last 3 log lines on death. (cc#264/#164/#202/#222)
- **SUP-368** [P1.3] `sendBrokerShutdown` 5 s timeout — `lib/broker-lifecycle.mjs` no longer hangs when the broker is unresponsive. (cc#245/#288, mirrors PR#293)

### Wave 2 — A+ delegate pattern (commits `d55c527`, `c1a2354`)

- **SUP-369** [P2.1+2.2] `/codex:delegate` command + prompt — `commands/delegate.md` + `prompts/delegate.md`. Codex stays read-only and proposes diffs; Claude applies them. STATUS marker terminates the loop.
- **SUP-370** [P2.3] `codex-delegate` agent — `agents/codex-delegate.md`. Multi-turn orchestrator: parse → apply (`Edit`/`Write` or `git apply`) → verify → follow-up → repeat. 5-turn safety cap.
- **SUP-371** [P2.4] `codex-companion.mjs` `--delegate-mode` option — read-only sandbox enforced; `prompts/delegate.md` prepended automatically. Mutually exclusive with `--write`.

### Wave 3 — Stateful thread (commits `d2726b4`, `258df9d`)

- **SUP-372** [P3.1] `ephemeral: false` default — `lib/codex.mjs` `buildThreadParams`. Threads now persist to Codex storage by default; pass `ephemeral: true` to opt back into upstream behavior. (cc#7, cc#230)
- **SUP-373** [P3.2] `/codex:consult` command — `commands/consult.md` + `prompts/consult.md` + `state.mjs` `consultThreads` map + `codex-companion.mjs` `consult` subcommand. Workspace-scoped thread; `--fresh` to reset. (cc#7 — stale 1.5 months at upstream)
- **SUP-374** [P3.3] `--resume-id <threadId>` flag — `codex-companion.mjs` `handleTask`. Mutually exclusive with `--resume-last` and `--fresh`. (cc#230)

### Wave 4 — Auto-Context (commit `9666c49`)

- **SUP-375** [P4.1] Auto-Context prefix rule — `agents/codex-rescue.md` (matches the rule already in `agents/codex-delegate.md` from SUP-370). Caller injects cwd / branch / git status / recent commits / modified files into the prompt. `--no-auto-context` opts out. Zero runtime code change.
- **SUP-376** [P4.2] `--context <text>` flag — `codex-companion.mjs` `handleTask`. Composes naturally with Auto-Context (Codex sees both, with a clear separator). (cc#284, mirrors PR#293)

### Out of scope for MVP

Per Linear Project Out-of-scope section, deliberately not implemented:

- Worktree isolation (cc#135) — Claude=parent / Codex=child, same-cwd race rare in single-user fork
- Auto-decide `wait`/`background` (cc#221) — minor QoL
- Natural-language router (`~/.claude/CLAUDE.md` import block) — would conflict with supalead's domain skills
- Codex Desktop history feed isolation (cc#282) — maintainer doesn't use Desktop
- Native macOS keychain rotation for the orphaned PATs documented in this change set — out of band cleanup

### Upstream contribution candidates

W1 (SUP-366/367/368) is contained, well-tested, and addresses confirmed upstream bugs. Eligible for upstream PR submission once OAuth scope friction is resolved on the maintainer's local PAT.

## [1.0.4-supa.0] — 2026-05-09

### Added

- Fork notice in `README.md`
- Fork metadata in `.claude-plugin/marketplace.json` (name → `doubledrake-codex-supa`, version → `1.0.4-supa.0`, fork purpose + upstream link)
- This CHANGELOG

### Notes

Initial fork of upstream `openai/codex-plugin-cc@v1.0.4` (commit `807e03a`). **No code changes yet — meta-only.** All Linear Wave 1–4 sub-issues blocked until this Wave 0 PR merges.

**Upstream sync policy**: rebase on `upstream/main` for new releases. Conflict minimization through:

- Patch-only modifications to existing files (minimum diff in `scripts/codex-companion.mjs`, `scripts/lib/*.mjs`)
- New files in separate paths (`commands/delegate.md`, `commands/consult.md`, `prompts/delegate.md`, `agents/codex-delegate.md`)

**Out of scope** (per Linear Project Out-of-scope section):

- Worktree isolation (cc#135) — Claude=parent / Codex=child relationship makes same-cwd race rare
- Auto-decide `wait`/`background` (cc#221)
- Natural-language router (`~/.claude/CLAUDE.md` import block) — conflicts with supalead's domain skills (linear-workflow, pr-review, etc.)
- Codex Desktop history feed isolation (cc#282) — not used by maintainer
