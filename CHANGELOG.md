# Changelog

All notable changes vs upstream `openai/codex-plugin-cc` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Linear Project: [codex-plugin-cc-plus fork](https://linear.app/supalead/project/codex-plugin-cc-plus-fork-codex-안정성-a-delegate-990176b8d08b)

## [Unreleased]

### Fixed — W6.E Pattern A env injection (follow-up to SUP-378/386)

`codex-native-test` end-to-end 시연 (2026-05-10 KST 01:07)에서 발견: **Claude Code Agent Teams runtime이 멤버 process에 `CLAUDE_TEAM_NAME` env를 자동 inject 안 함**. 결과적으로 codex-runner agent (subagent_type: codex:codex-delegate)가 codex-companion 호출 시 env가 비어있어 `codex-tool-calls.mjs` `dispatchTeamSend`가 `no team context (CLAUDE_TEAM_NAME unset)` 으로 fail.

- 1차 시연: codex가 codex-tool-calls JSON 블록 정상 emit, companion이 fence parse + validate 통과, dispatch 시도 시 team context 없어서 `team_send` skip.
- env explicit prefix 후 재시도: `[codex-tool-calls] dispatched 1 tool call(s)` → `team_send ok team-lead` ✅. **cyan color로 team-lead inbox 도착** (codex가 native channel로 직접 보낸 첫 message — Pattern A의 의도된 그림 verified).

영구 fix (prompt-only, 코드 0):

- `agents/codex-delegate.md` Turn 1 + Follow-up call: `CLAUDE_TEAM_NAME="<team>" CLAUDE_AGENT_NAME="<self>" \` env prefix 명시 (team 안에서 실행 시 필수). Without these vars, team-bound tools (`team_send` / `ask_lead` / `push_notification` / `todo_write`) silently skip.
- `skills/codex-pane-helper/SKILL.md` Step 2: runner spawn prompt에 env inject 룰 inline. Agent Teams runtime이 auto-inject 안 한다는 사실을 W6 verified로 명문화. 이로써 모든 미래 Pattern A 호출은 자동으로 정상 동작.

Refs SUP-378 (Pattern A `--pane`), SUP-386 (codex-pane-helper skill), SUP-383 (codex-tool-calls bridge). codex-native-test 멤버 `codex-runner`가 직접 시연 + 회신.

### Fixed — W6.D P0 보안 follow-up (SUP-391) — bash sub-flag deny + Auto-Context redaction

W6 team-mode 시연 중 project-reviewer 멤버가 W6.A SUP-384 fix의 잔존 P0 결함 2건 catch. 즉시 fix.

**Finding 1 — bash allowlist 의미적 약함**: W6.A는 첫 토큰 allowlist + shell metachar reject만 구현. 첫 토큰이 통과해도 sub-flag로 임의 코드 실행 가능 — `node -e ...`, `git -c core.editor=/tmp/evil rebase`, `npm exec <pkg>`, `find . -exec rm`, `tsc -p /tmp/evil` 등이 prompt-injected codex-tool-calls 블록으로 들어오면 `CODEX_DELEGATE_WRITES=enabled` 시 그대로 실행됐을 위험.

**Finding 2 — Auto-Context redaction 부재**: agent prompt가 `git log --oneline -5` / `git status --short` / `git diff --name-only HEAD` 출력을 그대로 codex CLI로 prefix → OpenAI로 전송. commit msg / branch / filename에 실수로 들어간 토큰 (`sk-*`, `ghp_*`, `AKIA*`, JWT, PEM, `password=`)이 silent leak.

**Fix**:

- `plugins/codex/scripts/lib/codex-tool-calls.mjs` — `inspectBashCommand`에 `DANGEROUS_SUB_FLAGS` deny map. 8개 tool (node/git/npm/yarn/pnpm/find/tsc/npx)에 대해 위험 sub-flag/sub-command 명시 거부. `npx`는 head 자체가 임의 실행이라 `null`로 unconditional reject. 첫 토큰 allowlist 통과 + sub-flag deny 통과 + metachar reject 통과 = 3-layer defense.
- `plugins/codex/scripts/lib/redact.mjs` (NEW, ~80 LoC) — secret pattern 9종 (sk-token / GitHub PAT 3종 / AWS / Google / Slack / PEM / JWT / kv-style password=) 매처. `redactSecrets(text)` 일괄 치환, `detectSecretShapes(text)` 진단 (어떤 패턴이 매치됐는지 — 매치된 텍스트는 안 노출).
- `plugins/codex/scripts/codex-companion.mjs` — `buildTaskRequest`에서 `rawPrompt` + `--context` 둘 다 `redactSecrets` 통과 후 OpenAI로 전송. `import { redactSecrets } from "./lib/redact.mjs"` 상단에 추가.
- `plugins/codex/agents/codex-rescue.md` + `agents/codex-delegate.md` — Auto-Context 룰에 redact 단계 명시. 한 줄 in-process pipe 예시 포함. defense-in-depth로 agent도 upstream에서 redact, codex-companion이 보강.
- 28 신규 regression test (`tests/codex-tool-calls.test.mjs` 13 cases + `tests/redact.test.mjs` 17 cases): node `-e`/`--eval`, git `-c`/`-C`/`--exec-path`, npm `exec`, find `-exec`, tsc `-p`, npx unconditional reject; 정상 (`node script.js`, `git status`, `git log`) 통과 확인. Redact: 9 secret pattern 모두 catch + clean text 무변조 + multi-secret + key=value 구조 보존 + null/undefined 입력 안전.

전체 test suite: 137 tests / 129 pass / 8 fail (baseline 동일 — 회귀 0).

Refs SUP-391 (W6.D), SUP-384 (W6.A), SUP-383 (W6.A 원본). Catch 출처: codex-supa-team / project-reviewer 멤버 (2026-05-09 시연).

### Added — `codex-pane-helper` skill (W6.C SUP-386) — `--pane` automation packaged

`/codex:delegate --pane` (and `/codex --pane` after W6.B) used to require the orchestrator to re-derive the five-step Pattern A flow (reuse/create team → Agent spawn → SendMessage → monitor → cleanup) every time. New skill encapsulates the procedure so any team-aware agent can opt in without copying the steps.

- New `plugins/codex/skills/codex-pane-helper/SKILL.md` (~120 lines): five-step procedure + error handling table + reuse-vs-create heuristic that reads `CLAUDE_TEAM_NAME` and falls through to `docs/supalead-team-integration.md` when an existing team is in scope. Cleanup is conditional on `teamWasCreatedHere` so supalead Lead/pm sessions are not torn down by accident.
- Two architectural corrections vs the legacy inlined procedure in `agents/codex-delegate.md`:
  - The runner's `subagent_type` is `codex:codex-delegate` (the same agent), not `general-purpose`. Reusing the agent gives the runner the STATUS protocol and `codex-team-bridge` skill automatically.
  - `TeamCreate` does NOT pass an `icon` parameter (W5 verified that emoji icons are rejected).
- `agents/codex-delegate.md` slimmed: Pattern A section now points to the skill and explains the two corrections in 5 lines instead of inlining a 17-line procedure. Frontmatter `skills` list extended with `codex-pane-helper`.

Refs SUP-378 (the `--pane` flag itself), SUP-381 (sister skill `codex-team-bridge` — translation layer for codex stdin/stdout side, loaded automatically by codex-delegate runner).

### Added — `/codex:do` natural-language entry (W6.B SUP-385, hotfix renamed from `/codex:codex`)

User feedback: "현재 `/codex` blah blah 명령어 너무 많은데 사용성 관점에서 단순화하면 좋겠어. 자연어로 처리할수있게하면 더 좋을것같고." Nine specific commands (`/codex:rescue`, `/codex:delegate`, `/codex:consult`, `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`) were friction for casual use. New `/codex:do` command is a single natural-language router.

Note on naming: originally landed as `/codex:codex` (file `commands/codex.md`) so that bare `/codex` would feel like a single entry, but Claude Code's plugin namespace forces `/<plugin>:<command>` invocation form, and the `codex/codex` doubled name caused the runtime to fail dispatch with `Args from unknown skill`. Renamed file to `do.md`; invocation is now `/codex:do <request>`. This is a hot-fix during the same release; no separate SUP issue.

- New `plugins/codex/commands/do.md` (~150 lines): four-step protocol (explicit override via `--as <action>` → classification by signal words in KO+EN → ambiguity guard via single AskUserQuestion when action choice would change the result → direct dispatch to the chosen sub-action via `Agent` for delegate/rescue and `Bash`+`codex-companion` for the rest).
- Classification table covers `delegate` (multi-file refactor / implement / migrate), `rescue` (single-shot small fix), `consult` (design / Q&A / explore), `review` (read-only feedback), `adversarial-review` (challenge the approach), `status` / `result` / `cancel` (job ops), `setup` (install check). Both Korean and English signal words are first-class.
- Runtime flags (`--background`, `--wait`, `--pane`, `--model`, `--effort`, `--no-auto-context`, `--base`, `--scope`, `--fresh`) flow through unchanged. `--as <action>` is the only routing flag and is stripped before forwarding.
- INV-1 preserved: all nine direct aliases continue to work exactly as before. `/codex` is an additive entry, not a replacement.
- INV-4 preserved: `/codex` does NOT auto-import `~/.claude/CLAUDE.md` marker blocks (the rejected pattern from supalead environments). The user explicitly types `/codex <text>`; no implicit hook.
- README "What You Get" + plugin.json description updated to surface the new entry.

### Fixed — adversarial review follow-ups (W6.A SUP-384, post-SUP-383 hardening)

`/codex:adversarial-review --base 7808c92^` against the schema-validated tool calls (W5 SUP-383) and surrounding W2–W5 work surfaced two No-ship findings. Both addressed in `plugins/codex/scripts/lib/codex-tool-calls.mjs`.

- **Fix #1 (critical) — delegate-mode tool-call bridge bypassed read-only sandbox**
  - Before: `dispatchEditFile` / `dispatchWriteFile` resolved paths via `path.resolve(cwd, call.path)` with no workspace containment — absolute paths and `..` traversal opened arbitrary file overwrite. `dispatchRunBash` passed model-supplied strings to `execSync`, allowing arbitrary shell with substitution / chaining / redirection. Prompt-injected `codex-tool-calls` blocks (e.g. via README, issue body) could turn a read-only delegate run into local file/exec compromise.
  - Now (a) write/exec tools (`edit_file` / `write_file` / `run_bash`) are blocked by default — opt in with `CODEX_DELEGATE_WRITES=enabled`; (b) paths go through `safeResolveInWorkspace()` which rejects absolute paths, `..` segments, and symlink-out (deepest existing ancestor + tail trick handles non-existent targets); (c) `run_bash` uses `execFileSync` (no shell), splits on whitespace, requires the first token to be in an allowlist (default 25 read-mostly programs; override via `CODEX_BASH_ALLOWLIST=tok1,tok2`), and rejects shell metacharacters `;|&$<>` `` ` `` `()` outright.
  - Communication tools (`team_send` / `ask_lead` / `push_notification` / `todo_write`) remain default-allowed — they only touch this team's inbox artifacts under `CLAUDE_CONFIG_DIR/teams/...`.
- **Fix #2 (high) — `team_send` concurrent write race / silent corrupt overwrite**
  - Before: read-modify-rename of the recipient inbox JSON. Two concurrent senders read the same array, appended, and the last `renameSync` won — silently dropping the first message. Corrupt inbox files were also silently replaced, losing forensic data.
  - Now `withInboxLock(target, fn)` wraps the read-append-write in a `link()`-based atomic mutex (cross-platform, zero deps; bounded random backoff with 2 s timeout). Corrupt inbox files are copied to `<member>.json.broken.<epoch>.json` before the fresh array is written, so recovery is possible.
- **Fix #3 (low) — `CLAUDE_CONFIG_DIR` was captured at module load**
  - Before: `CLAUDE_HOME` / `TEAMS_DIR` were module-level constants from `process.env`. Tests / multi-team callers passing a different `CLAUDE_CONFIG_DIR` via `opts.env` were ignored.
  - Now `resolveTeamContext(env)` returns a context with the correct `teamsDir`, and `dispatchTeamSend` / friends use `ctx.teamsDir` exclusively. No behavior change for production (single-process default-env case); fixes test isolation.
- **Tests** — `tests/codex-tool-calls.test.mjs` (28 cases): path-traversal / absolute / symlink-out rejection, opt-in flag enforcement on edit/write/bash, bash allowlist + metachar rejection (semicolon, pipe, `$()`, backtick, redirect), 10-process concurrent `team_send` with all-deliver assertion, corrupt inbox `.broken` preservation, fence-tag-vs-bare-`\`\`\`json` discrimination. All pass; full repo suite has zero regressions vs `7808c92^` baseline.
- **Docs** — `prompts/delegate.md` adds a "Sandbox & safety (SUP-384)" section so codex's followup turns understand why a write call may come back blocked and what alternatives are available (prefer unified diff in MUST DO).

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
