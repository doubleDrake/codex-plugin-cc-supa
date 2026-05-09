# Changelog

All notable changes vs upstream `openai/codex-plugin-cc` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Linear Project: [codex-plugin-cc-plus fork](https://linear.app/supalead/project/codex-plugin-cc-plus-fork-codex-안정성-a-delegate-990176b8d08b)

## [Unreleased]

### Planned (per Linear sub-issues)

#### Wave 1 — P0 stability (cc#108/#264/#245/#288 direct)

- **SUP-366** [P1.1] Broker idle timeout — `app-server-broker.mjs` self-shutdown after 10 min idle (cc#108)
- **SUP-367** [P1.2] PID liveness check + `crashed` status auto-transition — `lib/job-control.mjs` (cc#264/#164/#202/#222)
- **SUP-368** [P1.3] `sendBrokerShutdown` 5 s timeout — `lib/broker-lifecycle.mjs` (cc#245/#288, PR#293 reference)

#### Wave 2 — A+ delegate pattern (Codex=brain, Claude=hand)

- **SUP-369** [P2.1+2.2] `/codex:delegate` command + prompt — `commands/delegate.md` + `prompts/delegate.md`
- **SUP-370** [P2.3] `codex-delegate` agent — multi-turn orchestrator (`agents/codex-delegate.md`)
- **SUP-371** [P2.4] `codex-companion.mjs` `delegateMode` option — `read-only` sandbox + `persistThread` enforced

#### Wave 3 — Stateful thread

- **SUP-372** [P3.1] `ephemeral: false` default — `lib/codex.mjs:55-66` (1-line change)
- **SUP-373** [P3.2] `/codex:consult` command — `commands/consult.md` + `prompts/consult.md` (cc#7)
- **SUP-374** [P3.3] `--resume-id <threadId>` flag — `codex-companion.mjs` `handleTask` (cc#230)

#### Wave 4 — Auto-Context

- **SUP-375** [P4.1] Auto-Context prefix rule — agent prompt only (no code change)
- **SUP-376** [P4.2] `--context <text>` flag — `codex-companion.mjs` (PR#293 reference)

### Future (MVP-out)

- **SUP-377** [P5] Agent Teams integration PoC — see Linear issue

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
