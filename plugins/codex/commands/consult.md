---
description: Multi-turn consultation with Codex — for design discussions, exploration, follow-up Q&A. Thread persists per-workspace; same workspace = same thread until --fresh
argument-hint: "[--fresh] [--background|--wait] [--model <model|spark>] <topic or follow-up question>"
allowed-tools: Bash(node:*), AskUserQuestion
---

Open or continue a Codex consultation thread. Each workspace gets its own thread mapping — calling `/codex:consult` again from the same repo automatically resumes the prior conversation, so you can have a continuous design discussion across multiple invocations.

Use this when:
- You want to think through a design decision out loud and get a second opinion.
- You want to explore unfamiliar code with a knowledgeable companion ("how does the auth middleware actually work?").
- You're iterating on an approach: ask, get feedback, refine, ask again.

Don't use this when:
- You want code applied — switch to `/codex:delegate`.
- You want a code review — switch to `/codex:review` / `/codex:adversarial-review`.
- The question is one-shot and you don't need a persistent thread — `/codex:rescue` is fine.

Forwarding rules:

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" consult ...`.
- Default to **foreground** (this is interactive — turn-by-turn back-and-forth is the point). Honor `--background` only if the user explicitly asks.
- Strip routing flags (`--fresh`, `--background`, `--wait`, `--model`) from the question text. They go to `codex-companion`, not into the question.
- If the user passes `--fresh`, forward it; the companion will clear the workspace's thread mapping and start a new thread.
- If the user did not pass `--fresh` and there's an existing thread for this workspace, the companion resumes it automatically.
- Leave `--model` unset by default. Only forward `--model <name>` if the user explicitly asks.
- If the user asks for `spark`, map to `--model gpt-5.3-codex-spark`.
- Return the Codex output verbatim — don't paraphrase, don't summarize. The user is having a conversation; let Codex's voice come through.
- If the helper reports Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.

Raw user request:

$ARGUMENTS

Examples:

```
/codex:consult how does the auth middleware actually work in this repo?
/codex:consult what would break if we replaced session tokens with JWT?
/codex:consult --fresh I want to explore caching strategies — different topic
/codex:consult --model gpt-5.4 dig deeper on the JWT migration cost
```

Refs Linear SUP-373 (W3.2). Implements cc#7 (stale at upstream for 1.5 months).
