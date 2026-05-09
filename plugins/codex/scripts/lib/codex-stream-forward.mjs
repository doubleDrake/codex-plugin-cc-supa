// codex-stream-forward — codex CLI streaming events → team SendMessage forwarder (SUP-392 W6.F).
//
// Background: codex CLI emits a stream of progress events (Turn started,
// Running command, Reviewer started, Applying, error, Turn completed, ...)
// via the `onProgress` callback path. These events used to surface only via
// stderr or per-job log files, so a team-mode caller (codex-runner) had to
// wait until codex finished before sending a single batched SendMessage to
// team-lead. UX feedback (2026-05-10): "한꺼번에 오는 구조인데 자연스럽게
// 핑퐁되면 좋을것같아."
//
// This module wraps any `onProgress(update)` callback so that, when the
// process is running inside a team (env CLAUDE_TEAM_NAME is set), each
// meaningful progress event also dispatches a `team_send` to team-lead
// (or `CLAUDE_AGENT_NAME`'s peer) via the codex-tool-calls infra (SUP-383).
// The original callback still fires for log / writeJobFile / stderr —
// forwarding is additive, not replacing.
//
// Filtering: only events that change what a watching human would do (turn
// boundaries, command starts, errors). Pure phase-update spam ("running",
// "thinking") is dropped. Throttle: 1 forward / 500 ms minimum gap to avoid
// inbox spam on rapid streams.
//
// Opt-out: env CODEX_STREAM_FORWARD=disabled (or "0", "false") suppresses
// forwarding even when team context is present. Useful for scripted runs
// that don't want to pollute the inbox.
//
// Refs SUP-392 (this file), SUP-383 (team_send dispatch), SUP-379 (Monitor
// grep filter pack — same event signatures), SUP-378 (Pattern A --pane),
// SUP-385 W6.E (env injection — same CLAUDE_TEAM_NAME pathway).

import { dispatchToolCalls } from "./codex-tool-calls.mjs";

const DEFAULT_THROTTLE_MS = 500;

// Phase / message patterns we treat as "meaningful enough to forward."
// Mirrors the canonical Pattern B grep filter (docs/monitor-filters.md):
//   [codex] Turn|Running command|Reviewer|Applying|File changes|error|
//   Codex error|Turn completed|Turn failed
//
// Keys are matched as substrings against the update message; phases are
// matched against the update.phase string. Either match wins.
const FORWARD_MESSAGE_PATTERNS = [
  /\bTurn started\b/i,
  /\bTurn completed\b/i,
  /\bTurn failed\b/i,
  /\bThread ready\b/i,
  /\bRunning command\b/i,
  /\bReviewer started\b/i,
  /\bReviewer (completed|finished)\b/i,
  /\bApplying\b/i,
  /\bFile changes\b/i,
  /\b(?:Codex )?error\b/i,
  /\bSTATUS:\s*(DONE|NEEDS_FOLLOW_UP)\b/i
];

const FORWARD_PHASE_VALUES = new Set([
  "starting", "running", "applying", "verifying",
  "completed", "failed", "crashed",
  "finalizing", "needs-follow-up"
]);

function shouldForward(update) {
  if (update == null) return false;
  // Normalize: update may be string or { message, phase, ... }.
  const message = typeof update === "string" ? update : (update.message ?? "");
  const phase = typeof update === "string" ? null : update.phase;

  if (typeof message === "string" && message.length > 0) {
    for (const re of FORWARD_MESSAGE_PATTERNS) {
      if (re.test(message)) return true;
    }
  }
  if (phase && FORWARD_PHASE_VALUES.has(phase)) return true;
  return false;
}

function isStreamForwardEnabled(env) {
  const teamName = env.CLAUDE_TEAM_NAME;
  if (!teamName) return false;
  const flag = env.CODEX_STREAM_FORWARD;
  if (flag === "disabled" || flag === "0" || flag === "false" || flag === "off") return false;
  return true;
}

function deriveRecipient(env) {
  // codex-runner reports to team-lead by default. Override with
  // CODEX_STREAM_FORWARD_TO=<member-name> if a different orchestrator
  // owns the team.
  return env.CODEX_STREAM_FORWARD_TO ?? "team-lead";
}

function summarizeForTeam(update) {
  const message = typeof update === "string" ? update : (update.message ?? "");
  const phase = typeof update === "string" ? null : update.phase;
  const prefix = "[codex stream]";
  const phaseTag = phase ? ` (${phase})` : "";
  // Keep it tight: a SendMessage line should be one short line.
  const tail = (message ?? "").trim().slice(0, 400);
  return `${prefix}${phaseTag} ${tail}`.trim();
}

/**
 * Wrap an `onProgress(update)` callback so that, when the runtime is
 * inside a team and forwarding is not opted out, meaningful progress
 * events are dispatched as `team_send` calls in addition to the normal
 * callback flow.
 *
 * Returns a new callback function. The original is always invoked first
 * (so writeJobFile / log / stderr behavior is unchanged), then the
 * forwarder runs synchronously after.
 */
export function wrapProgressForTeam(originalCallback, opts = {}) {
  const env = opts.env ?? process.env;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;

  // If we're not in a team or forwarding is disabled, return the original
  // callback untouched — no overhead, no behavior change.
  if (!isStreamForwardEnabled(env)) {
    return originalCallback;
  }

  let lastForwardAt = 0;
  const recipient = deriveRecipient(env);

  return (update) => {
    if (typeof originalCallback === "function") {
      try { originalCallback(update); }
      catch (e) { process.stderr.write(`[codex-stream] original onProgress threw: ${e.message}\n`); }
    }
    if (!shouldForward(update)) return;

    const now = Date.now();
    if (now - lastForwardAt < throttleMs) return;
    lastForwardAt = now;

    const text = summarizeForTeam(update);
    if (!text || text.length === 0) return;

    try {
      dispatchToolCalls(
        [{ tool: "team_send", to: recipient, text, summary: "codex stream" }],
        { env }
      );
    } catch (e) {
      process.stderr.write(`[codex-stream] forward failed: ${e.message}\n`);
    }
  };
}

// Exported helpers for tests
export const __test = {
  shouldForward,
  isStreamForwardEnabled,
  deriveRecipient,
  summarizeForTeam,
  FORWARD_MESSAGE_PATTERNS,
  FORWARD_PHASE_VALUES
};
