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

### Documented — Agent Teams spike (SUP-377)

- New `docs/agent-teams-poc.md` captures the Pattern A (Agent Teams) vs Pattern B (Monitor tool) comparison and the decision matrix for when each is worth the overhead.
- `agents/codex-delegate.md` gets a "Multitasking" section pointing to the docs. The agent does NOT auto-spawn a team — opt in per call.
- Spike conclusion: Pattern B (Monitor + per-job log) is the default; Pattern A is reserved for parallel sessions or larger team workflows.

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
