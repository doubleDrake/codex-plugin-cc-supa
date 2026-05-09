// codex-tool-calls — schema-validated tool call dispatcher (SUP-383 + W6.A SUP-384).
//
// Codex emits a single fenced JSON block in its final response:
//
//   ```json codex-tool-calls
//   [
//     { "tool": "team_send", "to": "team-lead", "text": "phase 1 complete" },
//     { "tool": "edit_file", "path": "...", "old_string": "...", "new_string": "..." },
//     { "tool": "write_file", "path": "/tmp/x", "content": "line 1\nline 2" }
//   ]
//   ```
//
// This module:
// 1. Extracts the block from a response string.
// 2. JSON.parse → array of tool call objects.
// 3. Validates against schemas/codex-tool-calls.schema.json (manual validator
//    to avoid an Ajv dependency).
// 4. Dispatches each call sequentially with sandbox containment.
//
// Side-effect ordering matches block order. Errors in one call do NOT halt
// subsequent calls — that's the caller's policy (we just report).
//
// Security model (SUP-384, adversarial-review follow-up):
//
// - "Communication" tools — team_send / ask_lead / push_notification /
//   todo_write — touch only this team's inbox artifacts (CLAUDE_HOME/teams/...).
//   They do NOT touch workspace files. Default: ALLOWED.
//
// - "Side-effect" tools — edit_file / write_file / run_bash — touch the
//   workspace and can run arbitrary commands. Default: REJECTED. Caller must
//   opt-in via env var CODEX_DELEGATE_WRITES=enabled (or "1" / "true"). Even
//   when opted-in:
//     * edit_file / write_file paths are realpath-resolved and rejected if
//       outside workspace root (no absolute paths, no `..`, no symlink-out).
//     * run_bash command is split on whitespace; the first token must be in
//       the allowlist, and shell metachars (;|&$<>`()) are rejected outright.
//       Override allowlist with CODEX_BASH_ALLOWLIST=git,node,npm,...
//
// - team_send writes go through a link()-based atomic lock (cross-platform,
//   no native deps) so concurrent senders don't lose messages. Corrupt inbox
//   files are preserved as <member>.broken.<ts>.json before being replaced.
//
// Why JSON (not YAML):
// - JSON.parse is a JS built-in — zero dependencies, predictable, handles
//   nested arrays/objects automatically. cc-upstream stays npm-clean.
// - YAML's human friendliness loses to JSON's parser robustness for
//   machine-emitted content (codex is fluent in JSON).
//
// Why a fenced block, not free regex:
// - Quoted examples in other code blocks would otherwise fire false-positives.
// - Schema is the contract. Codex / Claude updates change schemas/*.json
//   only; parser code stays stable.
//
// Refs: SUP-383 (origin), SUP-384 (this hardening), SUP-382 (inbox spike).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "..", "..", "schemas", "codex-tool-calls.schema.json");

function resolveClaudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}
function resolveTeamsDir(env = process.env) {
  return path.join(resolveClaudeHome(env), "teams");
}

// Match the canonical fence with the "codex-tool-calls" tag. Tag is mandatory
// — bare ```json blocks are NOT treated as tool calls (avoids snapshots /
// quoted examples in docs from firing).
const FENCE_REGEX = /```json\s+codex-tool-calls\s*\n([\s\S]*?)\n```/m;

// Default bash allowlist for run_bash. First whitespace-token must be one of
// these. Override via CODEX_BASH_ALLOWLIST=tok1,tok2,... (comma-separated).
const DEFAULT_BASH_ALLOWLIST = [
  "git",
  "node", "tsc",
  "npm", "yarn", "pnpm",
  "rg", "grep", "ls", "cat", "find", "head", "tail",
  "jq", "wc", "sort", "uniq", "diff", "stat",
  "echo", "true", "false", "which", "pwd",
  "test", "[" // POSIX test
];

// Shell metacharacters that enable arbitrary command chaining / substitution.
// We forbid them outright in run_bash command strings.
const SHELL_METACHARS = /[`$();&|<>]|\$\(/;

/**
 * Parse the JSON body of a fenced codex-tool-calls block.
 * Returns an array of raw tool-call objects (validation is a separate step).
 */
export function parseToolCallsJson(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("codex-tool-calls block must be a JSON array");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Schema validation (manual — covers the constraints in our schema file).
// ---------------------------------------------------------------------------

const TOOL_VALIDATORS = {
  team_send(call) {
    const errs = [];
    if (typeof call.to !== "string" || !/^[A-Za-z0-9._-]+$/.test(call.to)) errs.push("invalid `to`");
    if (typeof call.text !== "string" || call.text.length === 0 || call.text.length > 4000) errs.push("`text` 1..4000 chars");
    if (call.summary != null && (typeof call.summary !== "string" || call.summary.length > 200)) errs.push("`summary` ≤200 chars");
    return errs;
  },
  edit_file(call) {
    const errs = [];
    if (typeof call.path !== "string" || call.path.length === 0) errs.push("invalid `path`");
    if (typeof call.old_string !== "string" || call.old_string.length === 0) errs.push("`old_string` required");
    if (typeof call.new_string !== "string") errs.push("`new_string` required");
    if (call.replace_all != null && typeof call.replace_all !== "boolean") errs.push("`replace_all` must be boolean");
    return errs;
  },
  write_file(call) {
    const errs = [];
    if (typeof call.path !== "string" || call.path.length === 0) errs.push("invalid `path`");
    if (typeof call.content !== "string") errs.push("`content` required");
    return errs;
  },
  run_bash(call) {
    const errs = [];
    if (typeof call.command !== "string" || call.command.length === 0 || call.command.length > 8000) errs.push("`command` 1..8000 chars");
    if (call.timeout_ms != null && (typeof call.timeout_ms !== "number" || call.timeout_ms < 100 || call.timeout_ms > 600000)) errs.push("`timeout_ms` 100..600000");
    if (call.cwd != null && typeof call.cwd !== "string") errs.push("`cwd` must be string");
    return errs;
  },
  ask_lead(call) {
    const errs = [];
    if (typeof call.question !== "string" || call.question.length === 0 || call.question.length > 2000) errs.push("`question` 1..2000 chars");
    if (call.context != null && (typeof call.context !== "string" || call.context.length > 1000)) errs.push("`context` ≤1000 chars");
    if (call.options != null) {
      if (!Array.isArray(call.options) || call.options.length > 8) errs.push("`options` array ≤8");
      else for (const o of call.options) if (typeof o !== "string" || o.length === 0 || o.length > 200) { errs.push("each option 1..200 chars"); break; }
    }
    return errs;
  },
  push_notification(call) {
    const errs = [];
    if (typeof call.message !== "string" || call.message.length === 0 || call.message.length > 200) errs.push("`message` 1..200 chars");
    return errs;
  },
  todo_write(call) {
    const errs = [];
    if (!Array.isArray(call.items) || call.items.length === 0 || call.items.length > 30) errs.push("`items` array 1..30");
    else {
      for (const item of call.items) {
        if (item == null || typeof item !== "object") { errs.push("each item must be object"); break; }
        if (typeof item.subject !== "string" || item.subject.length === 0 || item.subject.length > 200) { errs.push("each item.subject 1..200 chars"); break; }
        if (item.description != null && (typeof item.description !== "string" || item.description.length > 1000)) { errs.push("item.description ≤1000 chars"); break; }
        if (item.activeForm != null && (typeof item.activeForm !== "string" || item.activeForm.length > 200)) { errs.push("item.activeForm ≤200 chars"); break; }
        if (item.status != null && !["pending", "in_progress", "completed"].includes(item.status)) { errs.push("item.status must be pending|in_progress|completed"); break; }
      }
    }
    return errs;
  }
};

export function validateToolCalls(calls) {
  if (!Array.isArray(calls)) return [{ index: -1, errors: ["top-level must be array"] }];
  const errors = [];
  calls.forEach((call, i) => {
    if (call == null || typeof call !== "object") {
      errors.push({ index: i, errors: ["item must be object"] });
      return;
    }
    const tool = call.tool;
    if (typeof tool !== "string" || !TOOL_VALIDATORS[tool]) {
      errors.push({ index: i, errors: [`unknown tool: ${tool ?? "(none)"}`] });
      return;
    }
    const errs = TOOL_VALIDATORS[tool](call);
    if (errs.length > 0) errors.push({ index: i, tool, errors: errs });
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Sandbox helpers (SUP-384).
// ---------------------------------------------------------------------------

/**
 * Resolve `targetPath` against `workspaceRoot` and confirm the result stays
 * inside the workspace, even after symlink resolution. Returns the realpath
 * of the target. Throws on absolute paths, parent-traversal, or symlink-out.
 */
export function safeResolveInWorkspace(targetPath, workspaceRoot) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (path.isAbsolute(targetPath)) {
    throw new Error(`absolute path not allowed: ${targetPath}`);
  }
  // Guard against `..` segments BEFORE resolve (lexical check).
  const segs = targetPath.split(/[\\/]/);
  if (segs.includes("..")) {
    throw new Error(`parent-traversal not allowed: ${targetPath}`);
  }
  const resolved = path.resolve(workspaceRoot, targetPath);

  // Realpath the deepest existing ancestor; the rest of the path is appended.
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  const tail = path.relative(probe, resolved);
  const realTarget = tail ? path.join(realProbe, tail) : realProbe;

  let realRoot;
  try { realRoot = fs.realpathSync(workspaceRoot); }
  catch { realRoot = path.resolve(workspaceRoot); }

  if (realTarget !== realRoot &&
      !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`path outside workspace: ${targetPath}`);
  }
  return realTarget;
}

function isWriteAllowed(env) {
  const flag = env.CODEX_DELEGATE_WRITES;
  return flag === "enabled" || flag === "1" || flag === "true";
}

function getBashAllowlist(env) {
  const override = env.CODEX_BASH_ALLOWLIST;
  if (typeof override === "string" && override.length > 0) {
    return override.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_BASH_ALLOWLIST;
}

/**
 * Decide whether `command` is safe to run via run_bash. Pure function — the
 * actual exec happens in dispatchRunBash. Returns { allowed, reason?, argv? }.
 */
export function inspectBashCommand(command, env = process.env) {
  if (typeof command !== "string" || command.length === 0) {
    return { allowed: false, reason: "empty command" };
  }
  if (SHELL_METACHARS.test(command)) {
    return { allowed: false, reason: "shell metacharacters (;|&$<>`()) not allowed" };
  }
  // Whitespace-split — no quote handling, deliberately. Codex emits simple
  // commands; quoted args with embedded whitespace should use `--flag=value`
  // form or be rejected.
  const argv = command.trim().split(/\s+/);
  const head = argv[0];
  const allowlist = getBashAllowlist(env);
  if (!allowlist.includes(head)) {
    return {
      allowed: false,
      reason: `command '${head}' not in allowlist (env CODEX_BASH_ALLOWLIST to override): ${allowlist.join(",")}`
    };
  }
  return { allowed: true, argv };
}

// ---------------------------------------------------------------------------
// Inbox lock (link()-based atomic CAS, cross-platform, no deps).
// ---------------------------------------------------------------------------

function withInboxLock(target, fn, opts = {}) {
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  const lockPath = `${target}.lock`;
  const dummyPath = `${target}.lock.dummy.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(dummyPath, "", "utf8");
  const start = Date.now();
  try {
    while (true) {
      try {
        fs.linkSync(dummyPath, lockPath);
        try { return fn(); }
        finally { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } }
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (Date.now() - start >= maxWaitMs) {
          throw new Error(`inbox lock timeout (${maxWaitMs}ms): ${target}`);
        }
        // small randomized backoff
        const sleepUntil = Date.now() + Math.floor(Math.random() * 30) + 5;
        while (Date.now() < sleepUntil) { /* spin */ }
      }
    }
  } finally {
    try { fs.unlinkSync(dummyPath); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher — runs each validated call. Errors don't halt subsequent calls.
// ---------------------------------------------------------------------------

function teamConfigPath(ctx) {
  return path.join(ctx.teamsDir, ctx.teamName, "config.json");
}

function inboxPath(ctx, memberName) {
  return path.join(ctx.teamsDir, ctx.teamName, "inboxes", `${memberName}.json`);
}

function resolveTeamContext(env) {
  const teamName = env.CLAUDE_TEAM_NAME;
  if (!teamName) return null;
  return {
    teamName,
    agentName: env.CLAUDE_AGENT_NAME ?? "codex-runner",
    teamsDir: resolveTeamsDir(env)
  };
}

function dispatchTeamSend(call, ctx) {
  if (!ctx) return { ok: false, error: "no team context (CLAUDE_TEAM_NAME unset)" };
  const cfgPath = teamConfigPath(ctx);
  if (!fs.existsSync(cfgPath)) return { ok: false, error: `team config missing: ${cfgPath}` };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch (e) { return { ok: false, error: `team config unreadable: ${e.message}` }; }
  const found = (cfg.members || []).find((m) => m && m.name === call.to);
  if (!found) return { ok: false, error: `recipient '${call.to}' not in team '${ctx.teamName}'` };

  const target = inboxPath(ctx, call.to);
  const entry = {
    from: ctx.agentName,
    text: call.text,
    timestamp: new Date().toISOString(),
    color: "cyan",
    read: false
  };
  if (call.summary) entry.summary = call.summary;

  try {
    return withInboxLock(target, () => {
      let current = [];
      if (fs.existsSync(target)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
          if (Array.isArray(parsed)) current = parsed;
          else throw new Error("inbox not an array");
        } catch (e) {
          // Preserve corrupt file for forensic recovery before overwriting.
          const broken = `${target}.broken.${Date.now()}.json`;
          try { fs.copyFileSync(target, broken); } catch { /* best-effort */ }
          current = [];
        }
      }
      current.push(entry);
      const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
      fs.renameSync(tmp, target);
      return { ok: true, recipient: call.to };
    });
  } catch (e) {
    return { ok: false, error: `inbox write failed: ${e.message}` };
  }
}

function dispatchEditFile(call, opts) {
  const env = opts.env ?? process.env;
  if (!isWriteAllowed(env)) {
    return { ok: false, error: "edit_file blocked: set CODEX_DELEGATE_WRITES=enabled to opt in" };
  }
  let target;
  try { target = safeResolveInWorkspace(call.path, opts.cwd); }
  catch (e) { return { ok: false, error: e.message }; }

  if (!fs.existsSync(target)) return { ok: false, error: `path not found: ${call.path}` };
  let content;
  try { content = fs.readFileSync(target, "utf8"); }
  catch (e) { return { ok: false, error: `read failed: ${e.message}` }; }
  if (!content.includes(call.old_string)) return { ok: false, error: "old_string not found in file" };
  let next;
  if (call.replace_all) {
    next = content.split(call.old_string).join(call.new_string);
  } else {
    const idx = content.indexOf(call.old_string);
    const lastIdx = content.lastIndexOf(call.old_string);
    if (idx !== lastIdx) return { ok: false, error: "old_string not unique; use replace_all or extend old_string for context" };
    next = content.slice(0, idx) + call.new_string + content.slice(idx + call.old_string.length);
  }
  fs.writeFileSync(target, next, "utf8");
  return { ok: true, path: call.path };
}

function dispatchWriteFile(call, opts) {
  const env = opts.env ?? process.env;
  if (!isWriteAllowed(env)) {
    return { ok: false, error: "write_file blocked: set CODEX_DELEGATE_WRITES=enabled to opt in" };
  }
  let target;
  try { target = safeResolveInWorkspace(call.path, opts.cwd); }
  catch (e) { return { ok: false, error: e.message }; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, call.content, "utf8");
  return { ok: true, path: call.path };
}

function dispatchRunBash(call, opts) {
  const env = opts.env ?? process.env;
  if (!isWriteAllowed(env)) {
    return { ok: false, error: "run_bash blocked: set CODEX_DELEGATE_WRITES=enabled to opt in" };
  }
  const inspect = inspectBashCommand(call.command, env);
  if (!inspect.allowed) return { ok: false, error: `run_bash blocked: ${inspect.reason}` };

  // Resolve cwd inside workspace if specified.
  let runCwd = opts.cwd;
  if (call.cwd) {
    try { runCwd = safeResolveInWorkspace(call.cwd, opts.cwd); }
    catch (e) { return { ok: false, error: `run_bash cwd: ${e.message}` }; }
  }

  // execFileSync — no shell. argv[0] is the program, argv[1..] are args.
  const [program, ...args] = inspect.argv;
  try {
    const out = execFileSync(program, args, {
      cwd: runCwd,
      timeout: call.timeout_ms ?? 30000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      env
    });
    return { ok: true, stdout: out, stderr: "" };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? ""
    };
  }
}

function dispatchAskLead(call, ctx) {
  if (!ctx) return { ok: false, error: "no team context (CLAUDE_TEAM_NAME unset)" };
  const optionsBlock = (call.options && call.options.length > 0)
    ? `\nOptions: ${call.options.map((o, i) => `(${String.fromCharCode(97 + i)}) ${o}`).join(" / ")}`
    : "";
  const contextBlock = call.context ? `\nContext: ${call.context}` : "";
  const composed = `Codex needs a decision: ${call.question}${contextBlock}${optionsBlock}`;
  return dispatchTeamSend(
    { tool: "team_send", to: "team-lead", text: composed, summary: "decision request" },
    ctx
  );
}

function dispatchPushNotification(call, ctx) {
  // Claude Code's PushNotification is internal; we can't invoke it from a
  // plugin subprocess. Fallback strategy: write to stderr (visible in
  // codex-companion log + per-job log) and forward to team-lead inbox if
  // we're in a team. Both paths surface to the user.
  process.stderr.write(`[codex-push] ${call.message}\n`);
  if (ctx) {
    return dispatchTeamSend(
      { tool: "team_send", to: "team-lead", text: `[push] ${call.message}`, summary: "push notification" },
      ctx
    );
  }
  return { ok: true, fallback: "stderr-only (no team context)" };
}

function dispatchTodoWrite(call, ctx) {
  // TodoWrite is an internal Claude Code tool — no external entry point.
  // Forward as a formatted team_send so team-lead can decide whether to
  // mirror via its own TodoWrite tool. Codex gets ack via the team channel.
  if (!ctx) return { ok: false, error: "no team context (CLAUDE_TEAM_NAME unset)" };
  const lines = call.items.map((item, i) => {
    const status = item.status ?? "pending";
    const checkbox = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
    let line = `${i + 1}. ${checkbox} ${item.subject}`;
    if (item.activeForm) line += ` — active form: "${item.activeForm}"`;
    if (item.description) line += `\n     ${item.description.replace(/\n/g, "\n     ")}`;
    return line;
  }).join("\n");
  const composed = `Codex proposes a todo list (please mirror via your TodoWrite tool if useful):\n\n${lines}`;
  return dispatchTeamSend(
    { tool: "team_send", to: "team-lead", text: composed, summary: `todo list (${call.items.length} item${call.items.length === 1 ? "" : "s"})` },
    ctx
  );
}

/**
 * Dispatch all validated tool calls. Returns array of per-call results.
 * Caller is expected to surface the report (e.g., append to the codex
 * runtime log + stderr) so the user can audit what fired.
 */
export function dispatchToolCalls(calls, opts = {}) {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const ctx = resolveTeamContext(env);
  const results = [];
  for (const call of calls) {
    let res;
    try {
      switch (call.tool) {
        case "team_send": res = dispatchTeamSend(call, ctx); break;
        case "edit_file": res = dispatchEditFile(call, { cwd, env }); break;
        case "write_file": res = dispatchWriteFile(call, { cwd, env }); break;
        case "run_bash": res = dispatchRunBash(call, { cwd, env }); break;
        case "ask_lead": res = dispatchAskLead(call, ctx); break;
        case "push_notification": res = dispatchPushNotification(call, ctx); break;
        case "todo_write": res = dispatchTodoWrite(call, ctx); break;
        default: res = { ok: false, error: `unknown tool: ${call.tool}` };
      }
    } catch (e) {
      res = { ok: false, error: `dispatcher exception: ${e.message}` };
    }
    results.push({ tool: call.tool, ...res });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Top-level orchestration: extract block → parse → validate → dispatch.
// ---------------------------------------------------------------------------

export function processCodexResponse(responseText, opts = {}) {
  if (typeof responseText !== "string") return { found: false, error: "response is not a string" };
  const m = responseText.match(FENCE_REGEX);
  if (!m) return { found: false };

  const jsonBody = m[1];
  let parsed;
  try { parsed = parseToolCallsJson(jsonBody); }
  catch (e) { return { found: true, error: `json parse failed: ${e.message}`, calls: [], results: [] }; }

  const validationErrors = validateToolCalls(parsed);
  if (validationErrors.length > 0) {
    return {
      found: true,
      error: "schema validation failed",
      calls: parsed,
      validationErrors,
      results: []
    };
  }

  const results = dispatchToolCalls(parsed, opts);
  return { found: true, calls: parsed, results };
}

export const SCHEMA_FILE = SCHEMA_PATH;
