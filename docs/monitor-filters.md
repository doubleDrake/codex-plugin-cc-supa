# Monitor pre-canned grep filter pack (SUP-379)

Reusable `grep` patterns for tailing codex-companion per-job logs through Claude Code's `Monitor` tool. Use these instead of writing the regex from scratch.

## Where the log lives

After `node codex-companion.mjs task --background ...`:

```
~/.claude/plugins/data/codex-*/state/<workspace-slug>-<hash>/jobs/<jobId>.log
```

The exact directory is in the `logFile` field of the JSON returned by `task --background --json`, or in `jobs/<jobId>.json`.

## Phase signatures

`codex-companion` writes one tagged line per significant event. The tag schemes:

| Phase | Pattern (grep -E) | Sample line |
|---|---|---|
| **turn-start** | `\\[codex\\] Turn started` | `[codex] Turn started (019e0...).` |
| **thread-ready** | `\\[codex\\] (Starting Codex|Thread ready|Resuming thread)` | `[codex] Thread ready (019e0...).` |
| **tool-call** | `\\[codex\\] (Running command|Calling [a-z_-]+/)` | `[codex] Running command: /bin/zsh -lc 'rg -n ...'` |
| **review-step** | `\\[codex\\] Reviewer (started|finished)` | `[codex] Reviewer started: changes against 'HEAD^'` |
| **file-change** | `\\[codex\\] (Applying|File changes)` | `[codex] Applying 1 file change(s).` |
| **assistant-msg** | `\\[codex\\] Assistant message captured` | `[codex] Assistant message captured: ...` |
| **reasoning** | `\\[codex\\] (Reasoning summary|Subagent .+ reasoning)` | `[codex] Reasoning summary captured: ...` |
| **turn-end** | `\\[codex\\] Turn (completed|failed|cancelled)` | `[codex] Turn completed.` |
| **error** | `\\[codex\\] (Codex error|error)` | `[codex] Codex error: ...` |

## Recommended filter packs

Pick the pack that matches what you care about. Wider packs are noisier.

### Pack `progress` (default for Pattern B in agents/codex-delegate.md)

Surface only the events users actually act on — phase transitions, file edits, and terminal states.

```bash
grep --line-buffered -E '\[codex\] (Turn started|Running command|Reviewer (started|finished)|Applying|File changes|Codex error|Turn (completed|failed|cancelled))'
```

### Pack `verbose`

Adds tool calls, assistant messages, and reasoning. Use when you suspect codex is silently looping.

```bash
grep --line-buffered -E '\[codex\] (Turn|Thread (ready|started)|Resuming thread|Running command|Calling [a-z_-]+/|Reviewer (started|finished)|Applying|File changes|Assistant message|Reasoning summary|error|Codex error)'
```

### Pack `terminal-only`

Just the start and the end. Use when codex is doing a long single turn and you only want to know when it finishes.

```bash
grep --line-buffered -E '\[codex\] (Turn started|Turn (completed|failed|cancelled)|Codex error)'
```

### Pack `errors-only`

Quiet path. Notification only on actual problems — useful when running multiple delegates and you only want exceptions.

```bash
grep --line-buffered -E '\[codex\] (Codex error|Turn failed|Turn cancelled|error:)'
```

## Wrapping with `Monitor`

```text
Monitor(
  description: "Codex delegate <jobId>",
  command: "tail -F <logFile> | <pack-from-above>",
  timeout_ms: 1800000,         // 30 min — match codex hard timeout
  persistent: false             // ends when timeout fires or session ends
)
```

`tail -F` (capital F) follows the file even if it gets rotated/recreated. `--line-buffered` on `grep` is required so that pipe buffering doesn't delay events by minutes — this is the most common gotcha.

## Stopping cleanly

When codex emits `Turn completed`, `Turn failed`, or `Turn cancelled`, stop polling — the job is terminal. The `progress` and `terminal-only` packs above already match those, so the next notification you see after `Turn started` will be a terminal one. You can then move on to the apply step (Pattern B) or hand control back to the runner agent (Pattern A).

## Checking against real output

The transcript captured during fork testing (commits `258df9d`, `7808c92`) provides ground truth — every pattern in this doc was matched against actual codex output, including:

- `[codex] Starting Codex review thread.`
- `[codex] Running command: /bin/zsh -lc 'rg -n "broker|idle|timeout" CHANGELOG.md'`
- `[codex] Applying 1 file change(s).`
- `[codex] Turn completion inferred after the main thread finished and subagent work drained.` (this one is the unusual case — it's an inference, not a real `Turn completed`; the `progress` pack does NOT match it on purpose to avoid false-DONE signals)

If you find an event in the wild that no pack matches, add it here in a follow-up commit. Don't widen the existing packs — make a new one.

## Refs

- Linear SUP-379 (this pack)
- `agents/codex-delegate.md` (consumer for Pattern B)
- `docs/agent-teams-poc.md` (parent decision matrix)
- `scripts/codex-companion.mjs` (event source — see `lib/codex.mjs` `applyTurnNotification` for the canonical event names)
