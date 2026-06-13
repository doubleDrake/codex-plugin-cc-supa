import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  runTrackedJob,
  writeCompletionSignalFile
} from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import {
  resolveJobSignalFile,
  resolveJobFile,
  resolveJobLogFile
} from "../plugins/codex/scripts/lib/state.mjs";

// node --test runs each test file in its own process, so setting
// CLAUDE_PLUGIN_DATA here does not leak into other suites.
function freshWorkspace() {
  const workspace = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  return workspace;
}

test("writeCompletionSignalFile writes <jobId>.done with a normalized status", () => {
  const ws = freshWorkspace();

  writeCompletionSignalFile(ws, "task-ok", "completed", "all good");
  assert.match(fs.readFileSync(resolveJobSignalFile(ws, "task-ok"), "utf8"), /completed task-ok all good/);

  // Unknown status collapses to "failed".
  writeCompletionSignalFile(ws, "task-weird", "something-else", null);
  assert.match(fs.readFileSync(resolveJobSignalFile(ws, "task-weird"), "utf8"), /failed task-weird/);

  // "crashed" is preserved (fork-specific terminal state).
  writeCompletionSignalFile(ws, "task-crash", "crashed", "pid gone");
  assert.match(fs.readFileSync(resolveJobSignalFile(ws, "task-crash"), "utf8"), /crashed task-crash pid gone/);
});

test("resolveJobSignalFile sits beside the job json and log", () => {
  const ws = freshWorkspace();
  const signal = resolveJobSignalFile(ws, "job-x");
  assert.equal(signal, resolveJobFile(ws, "job-x").replace(/\.json$/, ".done"));
  assert.equal(signal, resolveJobLogFile(ws, "job-x").replace(/\.log$/, ".done"));
});

test("runTrackedJob writes a completed signal on success", async () => {
  const ws = freshWorkspace();
  await runTrackedJob(
    { workspaceRoot: ws, id: "run-ok", logFile: null },
    async () => ({ exitStatus: 0, summary: "done", payload: {}, rendered: "x", threadId: null, turnId: null })
  );
  assert.match(fs.readFileSync(resolveJobSignalFile(ws, "run-ok"), "utf8"), /completed run-ok/);
});

test("runTrackedJob writes a failed signal on a non-zero exit", async () => {
  const ws = freshWorkspace();
  await runTrackedJob(
    { workspaceRoot: ws, id: "run-nz", logFile: null },
    async () => ({ exitStatus: 1, summary: "nope", payload: {}, rendered: "x", threadId: null, turnId: null })
  );
  assert.match(fs.readFileSync(resolveJobSignalFile(ws, "run-nz"), "utf8"), /failed run-nz/);
});

test("runTrackedJob writes a failed signal when the runner throws", async () => {
  const ws = freshWorkspace();
  await assert.rejects(
    runTrackedJob({ workspaceRoot: ws, id: "run-throw", logFile: null }, async () => {
      throw new Error("boom");
    })
  );
  assert.match(fs.readFileSync(resolveJobSignalFile(ws, "run-throw"), "utf8"), /failed run-throw boom/);
});
