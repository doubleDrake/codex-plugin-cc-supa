---
description: Single natural-language entry for Codex — Claude classifies the request and dispatches to the right sub-action (rescue / delegate / consult / review / adversarial-review / status / result / cancel / setup). All nine commands remain available as direct aliases.
argument-hint: "[--as <action>] [--pane] [--background|--wait] [--model <model|spark>] [--effort <effort>] [--no-auto-context] <natural-language request>"
allowed-tools: Bash(node:*), Agent, AskUserQuestion, Read, Grep, Glob
---

A single natural-language entry point for everything Codex can do. Read the user's text, decide which sub-action it is, then dispatch. The user keeps direct access to all nine specific commands (`/codex:rescue`, `/codex:delegate`, …) — `/codex` is for "I just want to ask Codex something, work out the routing for me."

Raw user request:

$ARGUMENTS

## Step 1 — explicit override

If `--as <action>` appears in `$ARGUMENTS`, **skip classification** and dispatch to that action immediately. Recognized actions:

- `rescue`, `delegate`, `consult`, `review`, `adversarial`, `adversarial-review`, `status`, `result`, `cancel`, `setup`

`adversarial` is a shorthand for `adversarial-review`. Strip `--as <action>` from the forwarded text before passing to the sub-command.

## Step 2 — classification rules

Read the user's natural-language text and pick exactly one action. Use these signals (Korean + English; both are first-class):

### `delegate` — multi-step write work

Multi-file refactors / implementations / migrations / large fixes that benefit from turn-by-turn progress with explicit Claude-applies-the-diffs handoff.

- KO: "리팩터", "구현", "마이그레이션", "추가해", "수정해", "재구성", "전체 ~", "여러 파일에서 ~"
- EN: "refactor", "implement", "build", "migrate", "add support for", "fix the X system", "rewrite"
- Signals: spans multiple files, requires verification (`npm test` / type-check), would take more than one turn

### `rescue` — single-shot write or investigation

Small / contained: one file, one bug, one chore. Codex can do it in a single `--write` turn or one read-only investigation turn.

- KO: "빠르게", "한 줄", "오타", "이것만", "여기 뭐 잘못됐어"
- EN: "quick fix", "typo", "single-line", "what's wrong here", "just this"
- Default fallback: when intent is "do something" but it's clearly small, prefer `rescue` over `delegate`.

### `consult` — discussion / exploration / Q&A (no writes)

Design discussions, code-base exploration, "explain to me how X works", iterative follow-up Q&A. Multi-turn with persistent thread per workspace.

- KO: "어떻게 생각해", "디자인", "방향", "조언", "의견", "탐색", "이해", "왜 이렇게 ~", "이게 뭐야"
- EN: "what do you think", "design", "approach", "explore", "understand", "explain", "why does X", "talk through"
- No write intent — user wants Codex's thinking, not a patch.

### `review` — code review (no writes, no design challenge)

Targeted review of working tree / branch / base diff. Returns findings; does not propose redesign.

- KO: "리뷰", "검토", "봐줘", "확인해줘", "PR 봐줘", "이 코드 어때"
- EN: "review", "check", "look at", "PR feedback", "code review"
- Default scope: working tree (auto). User can append `--base <ref>` / `--scope ...`.

### `adversarial-review` — challenge the approach itself

Goes beyond defect-spotting to question whether the implementation choice / design / tradeoffs are right.

- KO: "비판", "반박", "단점", "약점", "허점", "문제점", "왜 이 방식이 안 좋을까", "approach 비판"
- EN: "criticize", "challenge", "adversarial", "what could go wrong", "tear it apart", "design critique"
- Signal: user wants pushback, not validation.

### `status` / `result` / `cancel` — job operations

Operate on existing background Codex jobs in this repo.

- `status`: "잡 어떻게 됐어?", "상태", "진행상황", "running", "is it done", "show jobs"
- `result`: "결과 보여줘", "result", "show output", "fetch the result"
- `cancel`: "취소해", "cancel", "stop the job", "kill it"

If the user mentions a specific job ID, preserve it (e.g. `byst7yw6l`).

### `setup` — install / configure check

- KO: "설치", "설정", "세팅"
- EN: "setup", "install", "configure", "is codex ready"

## Step 3 — handle ambiguity

When the prompt sits between two actions and the difference matters, **call AskUserQuestion exactly once** before dispatching. Common ambiguity pairs:

- "review해줘" — could be `review` (read-only feedback) or `delegate` (review then fix). Ask: "Just review, or review-and-fix?"
- "이 코드 좀 봐줘" — could be `review` or `consult` (design discussion). Ask: "Code review or design discussion?"
- "고쳐줘" with no scope — could be `rescue` (small) or `delegate` (large). Ask: "Quick single-file fix or multi-step refactor?"
- Missing scope on review-class actions when multiple changes are staged: ask whether to scope to working tree, base diff, or specific files.

Do **not** call AskUserQuestion for every prompt — only when the action choice would meaningfully change the result. If you're 90%+ confident, dispatch directly.

## Step 4 — dispatch

After classification (and any clarification), execute the chosen sub-action directly. Don't print "I would invoke /codex:X" and stop — actually do it. Use the same execution path the dedicated alias would use:

| action | how to dispatch |
|---|---|
| `delegate` | `Agent({ subagent_type: "codex:codex-delegate", prompt: "<cleaned text + preserved flags>" })` — multi-turn orchestrator. Foreground unless `--background` was set. |
| `rescue` | `Agent({ subagent_type: "codex:codex-rescue", prompt: "<cleaned text + preserved flags>" })` |
| `consult` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" consult <args>` (preserve `--fresh`, `--background`, `--wait`, `--model`) |
| `review` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review <args>` (preserve `--base`, `--scope`, `--background`, `--wait`) — return stdout verbatim |
| `adversarial-review` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review <args>` — return stdout verbatim |
| `status` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status [<job-id>] [--all]` |
| `result` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result [<job-id>]` |
| `cancel` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel [<job-id>]` |
| `setup` | `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup [--enable-review-gate|--disable-review-gate]` |

Strip `--as <action>` from the forwarded text before dispatching. Preserve all other flags exactly as the user typed them.

If the user passed a flag the chosen sub-action doesn't support (e.g. `--pane` only applies to `delegate`; `--base` doesn't apply to `delegate`), drop it silently and call out in your reply: "ignored `--pane` (review-class actions don't use it)."

Tell the user once at the top of your reply which action you classified to ("Routing to `review` — working tree scope"), then execute. If ambiguity required AskUserQuestion, the answer becomes part of the routing log.

## Examples

```
/codex 인증 미들웨어 JWT로 리팩터해줘
  → delegate (multi-file refactor)

/codex 이 PR 리뷰해줘
  → review (working tree default)

/codex --as adversarial 이 design 어디서 깨질 수 있어?
  → adversarial-review (explicit)

/codex 좀비 잡 있어?
  → status

/codex 이거 디자인 어떻게 생각해? 두 가지 옵션이 있는데
  → consult

/codex --pane 이 큰 마이그레이션 백그라운드로 진행하고 별도 pane으로 보여줘
  → delegate (with --pane preserved)

/codex review해줘
  → ambiguous: AskUserQuestion (review vs review-then-fix)

/codex byst7yw6l 결과 보여줘
  → result (preserves job ID)

/codex codex 설치됐는지 확인
  → setup
```

## What this command does NOT do

- It does not invent new behavior — every action it dispatches to is a sub-command that already exists.
- It does not auto-import natural-language hooks from `~/.claude/CLAUDE.md` marker blocks (INV-4 — that pattern conflicts with supalead workflows).
- It does not bypass `/codex:rescue --write` opt-in semantics — if the chosen action has its own safety gate (e.g. `--write`, `CODEX_DELEGATE_WRITES`), respect it as if the user had typed the sub-command directly.

Refs Linear SUP-385 (W6.B). The nine direct commands (`/codex:rescue`, `/codex:delegate`, `/codex:consult`, `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`) remain available unchanged (INV-1).
