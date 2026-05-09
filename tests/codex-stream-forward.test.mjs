// codex-stream-forward.test.mjs — SUP-392 W6.F regression tests.
//
// Coverage:
//   1. Pattern matching (shouldForward) — meaningful events match, noise doesn't.
//   2. Env gating (isStreamForwardEnabled) — CLAUDE_TEAM_NAME presence + opt-out flag.
//   3. wrapProgressForTeam — original fires + forward fires + throttle.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { wrapProgressForTeam, __test } from "../plugins/codex/scripts/lib/codex-stream-forward.mjs";

const { shouldForward, isStreamForwardEnabled, summarizeForTeam } = __test;

function makeTeam(claudeHome, teamName, members = ["team-lead", "codex-runner"]) {
  const teamDir = path.join(claudeHome, "teams", teamName);
  const inboxDir = path.join(teamDir, "inboxes");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "config.json"),
    JSON.stringify({ teamName, members: members.map((name) => ({ name, agentId: name })) }, null, 2)
  );
  return teamDir;
}

function ws(suffix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-stream-${suffix}-`));
}

// ---------------------------------------------------------------------------
// shouldForward
// ---------------------------------------------------------------------------

test("shouldForward: matches Turn started", () => {
  assert.equal(shouldForward({ message: "Turn started (uuid)", phase: null }), true);
});

test("shouldForward: matches Running command", () => {
  assert.equal(shouldForward({ message: "Running command: git status", phase: null }), true);
});

test("shouldForward: matches Reviewer started", () => {
  assert.equal(shouldForward({ message: "Reviewer started", phase: null }), true);
});

test("shouldForward: matches Codex error", () => {
  assert.equal(shouldForward({ message: "Codex error: timeout" }), true);
});

test("shouldForward: matches STATUS: DONE", () => {
  assert.equal(shouldForward({ message: "STATUS: DONE" }), true);
});

test("shouldForward: matches STATUS: NEEDS_FOLLOW_UP", () => {
  assert.equal(shouldForward({ message: "STATUS: NEEDS_FOLLOW_UP" }), true);
});

test("shouldForward: matches by phase 'starting'", () => {
  assert.equal(shouldForward({ message: "...", phase: "starting" }), true);
});

test("shouldForward: matches by phase 'failed'", () => {
  assert.equal(shouldForward({ message: "...", phase: "failed" }), true);
});

test("shouldForward: rejects empty / unrelated message", () => {
  assert.equal(shouldForward({ message: "thinking", phase: null }), false);
  assert.equal(shouldForward({ message: "", phase: null }), false);
  assert.equal(shouldForward(null), false);
});

test("shouldForward: rejects unknown phase", () => {
  assert.equal(shouldForward({ message: "noise", phase: "unknown-phase-xyz" }), false);
});

test("shouldForward: handles plain string update", () => {
  assert.equal(shouldForward("Running command: foo"), true);
  assert.equal(shouldForward("hello world"), false);
});

// ---------------------------------------------------------------------------
// isStreamForwardEnabled
// ---------------------------------------------------------------------------

test("isStreamForwardEnabled: true when CLAUDE_TEAM_NAME is set", () => {
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x" }), true);
});

test("isStreamForwardEnabled: false when CLAUDE_TEAM_NAME is missing", () => {
  assert.equal(isStreamForwardEnabled({}), false);
});

test("isStreamForwardEnabled: false when CODEX_STREAM_FORWARD=disabled", () => {
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x", CODEX_STREAM_FORWARD: "disabled" }), false);
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x", CODEX_STREAM_FORWARD: "0" }), false);
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x", CODEX_STREAM_FORWARD: "false" }), false);
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x", CODEX_STREAM_FORWARD: "off" }), false);
});

test("isStreamForwardEnabled: true with other CODEX_STREAM_FORWARD values", () => {
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x", CODEX_STREAM_FORWARD: "enabled" }), true);
  assert.equal(isStreamForwardEnabled({ CLAUDE_TEAM_NAME: "x", CODEX_STREAM_FORWARD: "1" }), true);
});

// ---------------------------------------------------------------------------
// summarizeForTeam
// ---------------------------------------------------------------------------

test("summarizeForTeam: includes phase tag + truncates", () => {
  const long = "x".repeat(500);
  const out = summarizeForTeam({ message: long, phase: "running" });
  assert.match(out, /^\[codex stream\] \(running\) /);
  assert.ok(out.length < 450);  // 400 char tail + prefix
});

test("summarizeForTeam: handles plain string", () => {
  const out = summarizeForTeam("Turn started");
  assert.equal(out, "[codex stream] Turn started");
});

// ---------------------------------------------------------------------------
// wrapProgressForTeam — integration
// ---------------------------------------------------------------------------

test("wrapProgressForTeam: returns original callback when no team context", () => {
  const calls = [];
  const original = (u) => calls.push(u);
  const wrapped = wrapProgressForTeam(original, { env: {} });
  // Should be the same function (no wrapping overhead)
  assert.equal(wrapped, original);
  wrapped({ message: "Turn started" });
  assert.equal(calls.length, 1);
});

test("wrapProgressForTeam: original fires + forward dispatches when in team", () => {
  const claudeHome = ws("wpft-team");
  makeTeam(claudeHome, "demo-team", ["team-lead", "codex-runner"]);
  const inbox = path.join(claudeHome, "teams", "demo-team", "inboxes", "team-lead.json");

  const originalCalls = [];
  const original = (u) => originalCalls.push(u);
  const env = {
    CLAUDE_TEAM_NAME: "demo-team",
    CLAUDE_AGENT_NAME: "codex-runner",
    CLAUDE_CONFIG_DIR: claudeHome
  };
  const wrapped = wrapProgressForTeam(original, { env });

  wrapped({ message: "Turn started (uuid)", phase: "starting" });

  // Original should have fired
  assert.equal(originalCalls.length, 1);
  // Inbox should contain the forwarded SendMessage
  assert.ok(fs.existsSync(inbox));
  const messages = JSON.parse(fs.readFileSync(inbox, "utf8"));
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\[codex stream\]/);
  assert.match(messages[0].text, /Turn started/);
  assert.equal(messages[0].summary, "codex stream");
});

test("wrapProgressForTeam: skips forward for non-meaningful events", () => {
  const claudeHome = ws("wpft-skip");
  makeTeam(claudeHome, "demo-team", ["team-lead", "codex-runner"]);
  const inbox = path.join(claudeHome, "teams", "demo-team", "inboxes", "team-lead.json");

  const env = {
    CLAUDE_TEAM_NAME: "demo-team",
    CLAUDE_AGENT_NAME: "codex-runner",
    CLAUDE_CONFIG_DIR: claudeHome
  };
  const wrapped = wrapProgressForTeam(() => {}, { env });

  wrapped({ message: "thinking deeply", phase: "background" });
  wrapped({ message: "..." });

  // Inbox should be empty (no file or empty array)
  if (fs.existsSync(inbox)) {
    const messages = JSON.parse(fs.readFileSync(inbox, "utf8"));
    assert.equal(messages.length, 0);
  }
});

test("wrapProgressForTeam: throttles rapid forwards (1 per 500ms)", () => {
  const claudeHome = ws("wpft-throttle");
  makeTeam(claudeHome, "demo-team", ["team-lead", "codex-runner"]);
  const inbox = path.join(claudeHome, "teams", "demo-team", "inboxes", "team-lead.json");

  const env = {
    CLAUDE_TEAM_NAME: "demo-team",
    CLAUDE_AGENT_NAME: "codex-runner",
    CLAUDE_CONFIG_DIR: claudeHome
  };
  const wrapped = wrapProgressForTeam(() => {}, { env, throttleMs: 100 });

  // 5 meaningful events back-to-back (well under 100ms)
  for (let i = 0; i < 5; i++) {
    wrapped({ message: `Running command: cmd-${i}`, phase: null });
  }

  // Throttle should let only the first through
  const messages = JSON.parse(fs.readFileSync(inbox, "utf8"));
  assert.equal(messages.length, 1, `expected 1 (throttled), got ${messages.length}`);
});

test("wrapProgressForTeam: opt-out via CODEX_STREAM_FORWARD=disabled", () => {
  const claudeHome = ws("wpft-optout");
  makeTeam(claudeHome, "demo-team", ["team-lead", "codex-runner"]);
  const inbox = path.join(claudeHome, "teams", "demo-team", "inboxes", "team-lead.json");

  const original = () => {};
  const env = {
    CLAUDE_TEAM_NAME: "demo-team",
    CLAUDE_AGENT_NAME: "codex-runner",
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_STREAM_FORWARD: "disabled"
  };
  const wrapped = wrapProgressForTeam(original, { env });

  // Should be the same function (no wrapping overhead — opt-out short-circuits)
  assert.equal(wrapped, original);
  wrapped({ message: "Turn started" });
  // Inbox stays empty
  assert.equal(fs.existsSync(inbox), false);
});

test("wrapProgressForTeam: original throwing does not break forward", () => {
  const claudeHome = ws("wpft-throw");
  makeTeam(claudeHome, "demo-team", ["team-lead", "codex-runner"]);
  const inbox = path.join(claudeHome, "teams", "demo-team", "inboxes", "team-lead.json");

  const env = {
    CLAUDE_TEAM_NAME: "demo-team",
    CLAUDE_AGENT_NAME: "codex-runner",
    CLAUDE_CONFIG_DIR: claudeHome
  };
  const wrapped = wrapProgressForTeam(() => { throw new Error("boom"); }, { env });

  // Should not throw to caller
  assert.doesNotThrow(() => wrapped({ message: "Turn started" }));

  // Forward should still have fired
  const messages = JSON.parse(fs.readFileSync(inbox, "utf8"));
  assert.equal(messages.length, 1);
});

test("wrapProgressForTeam: respects CODEX_STREAM_FORWARD_TO override", () => {
  const claudeHome = ws("wpft-recipient");
  makeTeam(claudeHome, "demo-team", ["team-lead", "codex-runner", "pm"]);
  const pmInbox = path.join(claudeHome, "teams", "demo-team", "inboxes", "pm.json");

  const env = {
    CLAUDE_TEAM_NAME: "demo-team",
    CLAUDE_AGENT_NAME: "codex-runner",
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_STREAM_FORWARD_TO: "pm"
  };
  const wrapped = wrapProgressForTeam(() => {}, { env });
  wrapped({ message: "Turn started" });

  const messages = JSON.parse(fs.readFileSync(pmInbox, "utf8"));
  assert.equal(messages.length, 1);
});
