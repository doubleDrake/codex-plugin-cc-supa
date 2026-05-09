// codex-tool-calls.test.mjs — SUP-384 hardening regressions.
//
// Coverage targets (adversarial-review findings):
//   [Critical] sandbox bypass via edit_file / write_file / run_bash
//   [High] team_send concurrent write race
//
// We exercise the dispatcher / sandbox helpers directly. End-to-end fence
// extraction is exercised via processCodexResponse in a few smoke tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  safeResolveInWorkspace,
  inspectBashCommand,
  validateToolCalls,
  dispatchToolCalls,
  processCodexResponse
} from "../plugins/codex/scripts/lib/codex-tool-calls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function makeWorkspace(suffix = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-tc-${suffix}-`));
  return root;
}

function makeTeam(claudeHome, teamName, members) {
  const teamDir = path.join(claudeHome, "teams", teamName);
  const inboxDir = path.join(teamDir, "inboxes");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "config.json"),
    JSON.stringify({ teamName, members: members.map((name) => ({ name, agentId: name })) }, null, 2)
  );
  return teamDir;
}

// ---------------------------------------------------------------------------
// safeResolveInWorkspace
// ---------------------------------------------------------------------------

test("safeResolveInWorkspace: relative path inside workspace returns realpath", () => {
  const ws = makeWorkspace("safe-rel");
  fs.writeFileSync(path.join(ws, "file.txt"), "x", "utf8");
  const out = safeResolveInWorkspace("file.txt", ws);
  assert.equal(out, fs.realpathSync(path.join(ws, "file.txt")));
});

test("safeResolveInWorkspace: nested non-existent file resolves under workspace", () => {
  const ws = makeWorkspace("safe-nested");
  fs.mkdirSync(path.join(ws, "a", "b"), { recursive: true });
  // file does not exist yet — write_file may create it
  const out = safeResolveInWorkspace("a/b/new.txt", ws);
  assert.equal(out, path.join(fs.realpathSync(path.join(ws, "a", "b")), "new.txt"));
});

test("safeResolveInWorkspace: rejects absolute path", () => {
  const ws = makeWorkspace("safe-abs");
  assert.throws(() => safeResolveInWorkspace("/etc/passwd", ws), /absolute path/);
});

test("safeResolveInWorkspace: rejects parent traversal", () => {
  const ws = makeWorkspace("safe-trav");
  assert.throws(() => safeResolveInWorkspace("../escape", ws), /parent-traversal/);
  assert.throws(() => safeResolveInWorkspace("a/../../escape", ws), /parent-traversal/);
});

test("safeResolveInWorkspace: rejects symlink-out", () => {
  const ws = makeWorkspace("safe-symlink");
  const outsideDir = makeWorkspace("safe-symlink-outside");
  fs.symlinkSync(outsideDir, path.join(ws, "link-out"));
  // Symlink itself is inside ws but resolves outside — must be rejected.
  assert.throws(
    () => safeResolveInWorkspace("link-out/file.txt", ws),
    /outside workspace/
  );
});

// ---------------------------------------------------------------------------
// inspectBashCommand
// ---------------------------------------------------------------------------

test("inspectBashCommand: allows simple allowlisted command", () => {
  const r = inspectBashCommand("git status --short", { CODEX_BASH_ALLOWLIST: "git" });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.argv, ["git", "status", "--short"]);
});

test("inspectBashCommand: rejects command not in allowlist", () => {
  const r = inspectBashCommand("rm -rf /", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not in allowlist/);
});

test("inspectBashCommand: rejects shell metachars (semicolon)", () => {
  const r = inspectBashCommand("git status; rm -rf /", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /metacharacters/);
});

test("inspectBashCommand: rejects shell metachars (pipe)", () => {
  const r = inspectBashCommand("git log | xargs rm", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /metacharacters/);
});

test("inspectBashCommand: rejects command substitution", () => {
  const r = inspectBashCommand("echo $(rm -rf /)", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /metacharacters/);
});

test("inspectBashCommand: rejects backtick substitution", () => {
  const r = inspectBashCommand("echo `whoami`", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /metacharacters/);
});

test("inspectBashCommand: rejects redirection", () => {
  const r = inspectBashCommand("cat /etc/passwd > /tmp/leak", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /metacharacters/);
});

test("inspectBashCommand: rejects empty command", () => {
  assert.equal(inspectBashCommand("", {}).allowed, false);
});

test("inspectBashCommand: env CODEX_BASH_ALLOWLIST overrides default", () => {
  const r = inspectBashCommand("custom-tool --x", { CODEX_BASH_ALLOWLIST: "custom-tool,foo" });
  assert.equal(r.allowed, true);
});

// ---------------------------------------------------------------------------
// SUP-391 W6.D — sub-flag deny
// ---------------------------------------------------------------------------

test("inspectBashCommand: rejects node -e (inline script)", () => {
  // Test the sub-flag deny path specifically, w/o parens that would trip
  // the metachar check first.
  const r = inspectBashCommand("node -e fs.writeFileSync", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sub-flag.*node/);
});

test("inspectBashCommand: rejects node --eval", () => {
  const r = inspectBashCommand("node --eval foo", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sub-flag.*node/);
});

test("inspectBashCommand: rejects git -c (config injection)", () => {
  const r = inspectBashCommand("git -c core.editor=/tmp/evil rebase HEAD~1", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sub-flag.*git/);
});

test("inspectBashCommand: rejects git -C (cwd injection)", () => {
  const r = inspectBashCommand("git -C /tmp/evil status", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sub-flag.*git/);
});

test("inspectBashCommand: rejects git --exec-path", () => {
  const r = inspectBashCommand("git --exec-path=/tmp status", {});
  assert.equal(r.allowed, false);
});

test("inspectBashCommand: rejects npm exec", () => {
  const r = inspectBashCommand("npm exec arbitrary-pkg", {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sub-flag.*npm/);
});

test("inspectBashCommand: rejects find -exec", () => {
  const r = inspectBashCommand("find . -exec rm -rf {} ;", { CODEX_BASH_ALLOWLIST: "find" });
  assert.equal(r.allowed, false);
  // -exec rejected by sub-flag, plus we'd also catch metachar (;)
  assert.ok(/sub-flag/.test(r.reason) || /metacharacters/.test(r.reason));
});

test("inspectBashCommand: rejects npx unconditionally", () => {
  const r = inspectBashCommand("npx anything", { CODEX_BASH_ALLOWLIST: "npx" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /unconditionally rejected/);
});

test("inspectBashCommand: allows node script.js (no sub-flag)", () => {
  const r = inspectBashCommand("node ./scripts/foo.js", {});
  assert.equal(r.allowed, true);
});

test("inspectBashCommand: allows git status (no sub-flag)", () => {
  const r = inspectBashCommand("git status --short", {});
  assert.equal(r.allowed, true);
});

test("inspectBashCommand: allows git log (no sub-flag)", () => {
  const r = inspectBashCommand("git log --oneline -5", {});
  assert.equal(r.allowed, true);
});

test("inspectBashCommand: allows tsc --noEmit (not in deny list)", () => {
  const r = inspectBashCommand("tsc --noEmit", {});
  assert.equal(r.allowed, true);
});

test("inspectBashCommand: rejects tsc -p /tmp/evil (project flag)", () => {
  const r = inspectBashCommand("tsc -p /tmp/evil/tsconfig.json", {});
  assert.equal(r.allowed, false);
});

// ---------------------------------------------------------------------------
// dispatchToolCalls — opt-in gating for write/exec tools
// ---------------------------------------------------------------------------

test("dispatch: edit_file blocked by default (no opt-in)", () => {
  const ws = makeWorkspace("dispatch-edit-block");
  fs.writeFileSync(path.join(ws, "f.txt"), "hello", "utf8");
  const [res] = dispatchToolCalls(
    [{ tool: "edit_file", path: "f.txt", old_string: "hello", new_string: "world" }],
    { cwd: ws, env: {} }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /CODEX_DELEGATE_WRITES/);
  assert.equal(fs.readFileSync(path.join(ws, "f.txt"), "utf8"), "hello");
});

test("dispatch: edit_file works with opt-in", () => {
  const ws = makeWorkspace("dispatch-edit-ok");
  fs.writeFileSync(path.join(ws, "f.txt"), "hello", "utf8");
  const [res] = dispatchToolCalls(
    [{ tool: "edit_file", path: "f.txt", old_string: "hello", new_string: "world" }],
    { cwd: ws, env: { CODEX_DELEGATE_WRITES: "enabled" } }
  );
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, "f.txt"), "utf8"), "world");
});

test("dispatch: edit_file with opt-in still rejects path traversal", () => {
  const ws = makeWorkspace("dispatch-edit-trav");
  const [res] = dispatchToolCalls(
    [{ tool: "edit_file", path: "../escape", old_string: "x", new_string: "y" }],
    { cwd: ws, env: { CODEX_DELEGATE_WRITES: "enabled" } }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /parent-traversal/);
});

test("dispatch: edit_file with opt-in still rejects absolute path", () => {
  const ws = makeWorkspace("dispatch-edit-abs");
  const [res] = dispatchToolCalls(
    [{ tool: "edit_file", path: "/etc/passwd", old_string: "x", new_string: "y" }],
    { cwd: ws, env: { CODEX_DELEGATE_WRITES: "enabled" } }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /absolute path/);
});

test("dispatch: write_file blocked by default", () => {
  const ws = makeWorkspace("dispatch-write-block");
  const [res] = dispatchToolCalls(
    [{ tool: "write_file", path: "new.txt", content: "data" }],
    { cwd: ws, env: {} }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /CODEX_DELEGATE_WRITES/);
  assert.equal(fs.existsSync(path.join(ws, "new.txt")), false);
});

test("dispatch: write_file works with opt-in", () => {
  const ws = makeWorkspace("dispatch-write-ok");
  const [res] = dispatchToolCalls(
    [{ tool: "write_file", path: "new.txt", content: "data" }],
    { cwd: ws, env: { CODEX_DELEGATE_WRITES: "enabled" } }
  );
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, "new.txt"), "utf8"), "data");
});

test("dispatch: run_bash blocked by default", () => {
  const ws = makeWorkspace("dispatch-bash-block");
  const [res] = dispatchToolCalls(
    [{ tool: "run_bash", command: "echo hi" }],
    { cwd: ws, env: {} }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /CODEX_DELEGATE_WRITES/);
});

test("dispatch: run_bash with opt-in still rejects metachars", () => {
  const ws = makeWorkspace("dispatch-bash-meta");
  const [res] = dispatchToolCalls(
    [{ tool: "run_bash", command: "echo hi; rm -rf /" }],
    { cwd: ws, env: { CODEX_DELEGATE_WRITES: "enabled" } }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /metacharacters/);
});

test("dispatch: run_bash with opt-in runs allowlisted command via execFile (no shell)", () => {
  const ws = makeWorkspace("dispatch-bash-ok");
  const [res] = dispatchToolCalls(
    [{ tool: "run_bash", command: "echo hello-world", timeout_ms: 5000 }],
    { cwd: ws, env: { CODEX_DELEGATE_WRITES: "enabled", CODEX_BASH_ALLOWLIST: "echo", PATH: process.env.PATH } }
  );
  assert.equal(res.ok, true, res.error);
  assert.match(res.stdout, /hello-world/);
});

// ---------------------------------------------------------------------------
// team_send concurrent write race (High finding)
// ---------------------------------------------------------------------------

test("team_send: 10 concurrent senders deliver ALL messages (no drops)", async () => {
  const claudeHome = makeWorkspace("team-concurrent");
  const teamName = "concurrent-team";
  const memberName = "team-lead";
  makeTeam(claudeHome, teamName, [memberName, "sender-x"]);
  const inbox = path.join(claudeHome, "teams", teamName, "inboxes", `${memberName}.json`);

  const senderScript = path.join(REPO_ROOT, "tests", "fixtures", "tool-calls-concurrent-sender.mjs");
  // Inline writer script so we don't pollute the repo with a fixture file.
  const driverScript = `
import { dispatchToolCalls } from "${pathToImport(path.join(REPO_ROOT, "plugins/codex/scripts/lib/codex-tool-calls.mjs"))}";
const idx = process.argv[2];
const r = dispatchToolCalls(
  [{ tool: "team_send", to: "${memberName}", text: "msg-" + idx, summary: "n" }],
  { env: process.env }
);
process.stdout.write(JSON.stringify(r));
`;
  const driverPath = path.join(claudeHome, "driver.mjs");
  fs.writeFileSync(driverPath, driverScript, "utf8");

  const N = 10;
  const procs = [];
  for (let i = 0; i < N; i++) {
    procs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [driverPath, String(i)], {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: claudeHome,
          CLAUDE_TEAM_NAME: teamName,
          CLAUDE_AGENT_NAME: "sender-x"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`sender ${i} exit ${code}: ${err}`));
        else resolve(JSON.parse(out));
      });
    }));
  }
  const results = await Promise.all(procs);
  // All senders should have ok:true
  for (const [i, r] of results.entries()) {
    assert.equal(r[0].ok, true, `sender ${i} failed: ${JSON.stringify(r[0])}`);
  }
  // Inbox should contain all N messages
  const inboxContent = JSON.parse(fs.readFileSync(inbox, "utf8"));
  assert.equal(inboxContent.length, N);
  const texts = inboxContent.map((e) => e.text).sort();
  const expected = Array.from({ length: N }, (_, i) => `msg-${i}`).sort();
  assert.deepEqual(texts, expected);
});

test("team_send: corrupt inbox is preserved as .broken before overwrite", () => {
  const claudeHome = makeWorkspace("team-corrupt");
  const teamName = "corrupt-team";
  makeTeam(claudeHome, teamName, ["team-lead", "sender"]);
  const inbox = path.join(claudeHome, "teams", teamName, "inboxes", "team-lead.json");
  fs.writeFileSync(inbox, "{ this is not valid json", "utf8");

  const [res] = dispatchToolCalls(
    [{ tool: "team_send", to: "team-lead", text: "fresh" }],
    { env: { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_TEAM_NAME: teamName, CLAUDE_AGENT_NAME: "sender" } }
  );
  assert.equal(res.ok, true);

  const inboxContent = JSON.parse(fs.readFileSync(inbox, "utf8"));
  assert.equal(inboxContent.length, 1);
  assert.equal(inboxContent[0].text, "fresh");

  // Broken file should be preserved
  const dir = path.dirname(inbox);
  const brokenFiles = fs.readdirSync(dir).filter((f) => f.startsWith("team-lead.json.broken."));
  assert.equal(brokenFiles.length, 1);
});

// ---------------------------------------------------------------------------
// processCodexResponse — fence + opt-in interplay
// ---------------------------------------------------------------------------

test("processCodexResponse: fence with edit_file blocked when CODEX_DELEGATE_WRITES unset", () => {
  const ws = makeWorkspace("ptcr-block");
  fs.writeFileSync(path.join(ws, "x.txt"), "abc", "utf8");
  const response = `Here is my response.

\`\`\`json codex-tool-calls
[
  { "tool": "edit_file", "path": "x.txt", "old_string": "abc", "new_string": "xyz" }
]
\`\`\`

STATUS: DONE`;
  const r = processCodexResponse(response, { cwd: ws, env: {} });
  assert.equal(r.found, true);
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /CODEX_DELEGATE_WRITES/);
  // file unchanged
  assert.equal(fs.readFileSync(path.join(ws, "x.txt"), "utf8"), "abc");
});

test("processCodexResponse: rejects bare ```json without codex-tool-calls tag", () => {
  const response = `Here is some quoted JSON example:

\`\`\`json
[ { "tool": "edit_file", "path": "/etc/passwd", "old_string": "x", "new_string": "y" } ]
\`\`\``;
  const r = processCodexResponse(response, { cwd: "/tmp", env: { CODEX_DELEGATE_WRITES: "enabled" } });
  assert.equal(r.found, false);
});

test("processCodexResponse: schema validation rejects unknown tool", () => {
  const response = `\`\`\`json codex-tool-calls
[ { "tool": "delete_db", "what": "everything" } ]
\`\`\``;
  const r = processCodexResponse(response, { cwd: "/tmp", env: {} });
  assert.equal(r.found, true);
  assert.match(r.error, /schema validation failed/);
  assert.equal(r.validationErrors[0].errors[0], "unknown tool: delete_db");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathToImport(p) {
  return new URL(`file://${p}`).href;
}
