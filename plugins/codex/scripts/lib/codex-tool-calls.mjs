// codex-tool-calls — schema-validated tool call dispatcher (SUP-383).
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
// 4. Dispatches each call sequentially, returning a per-call result list.
//
// Side-effect ordering matches block order. Errors in one call do NOT halt
// subsequent calls — that's the caller's policy (we just report).
//
// Why JSON (not YAML):
// - JSON.parse is a JS built-in — zero dependencies, predictable, handles
//   nested arrays/objects automatically. cc-upstream stays npm-clean.
// - YAML's human friendliness loses to JSON's parser robustness for
//   machine-emitted content (codex is fluent in JSON).
// - Multi-line file content survives via escape sequences (\n, \") which
//   codex emits cleanly.
//
// Why a fenced block, not free regex:
// - Quoted examples in other code blocks would otherwise fire false-positives.
// - Schema is the contract. Codex / Claude updates change schemas/*.json
//   only; parser code stays stable.
//
// Refs: SUP-383 (this file), SUP-382 (inbox spike that proved direct write
// works), docs/agent-teams-poc.md Pattern A.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "..", "..", "schemas", "codex-tool-calls.schema.json");

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const TEAMS_DIR = path.join(CLAUDE_HOME, "teams");

// Match the canonical fence with the "codex-tool-calls" tag. Tag is mandatory
// — bare ```json blocks are NOT treated as tool calls (avoids snapshots /
// quoted examples in docs from firing).
const FENCE_REGEX = /```json\s+codex-tool-calls\s*\n([\s\S]*?)\n```/m;

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
// Dispatcher — runs each validated call. Errors don't halt subsequent calls.
// ---------------------------------------------------------------------------

function teamConfigPath(teamName) {
  return path.join(TEAMS_DIR, teamName, "config.json");
}

function inboxPath(teamName, memberName) {
  return path.join(TEAMS_DIR, teamName, "inboxes", `${memberName}.json`);
}

function resolveTeamContext(env) {
  const teamName = env.CLAUDE_TEAM_NAME;
  if (!teamName) return null;
  return {
    teamName,
    agentName: env.CLAUDE_AGENT_NAME ?? "codex-runner"
  };
}

function dispatchTeamSend(call, ctx) {
  if (!ctx) return { ok: false, error: "no team context (CLAUDE_TEAM_NAME unset)" };
  const cfgPath = teamConfigPath(ctx.teamName);
  if (!fs.existsSync(cfgPath)) return { ok: false, error: `team config missing: ${cfgPath}` };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch (e) { return { ok: false, error: `team config unreadable: ${e.message}` }; }
  const found = (cfg.members || []).find((m) => m && m.name === call.to);
  if (!found) return { ok: false, error: `recipient '${call.to}' not in team '${ctx.teamName}'` };

  const target = inboxPath(ctx.teamName, call.to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let current = [];
  if (fs.existsSync(target)) {
    try { const parsed = JSON.parse(fs.readFileSync(target, "utf8")); if (Array.isArray(parsed)) current = parsed; }
    catch { /* corrupt — start fresh rather than block this message */ }
  }
  const entry = {
    from: ctx.agentName,
    text: call.text,
    timestamp: new Date().toISOString(),
    color: "cyan",
    read: false
  };
  if (call.summary) entry.summary = call.summary;
  current.push(entry);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
  fs.renameSync(tmp, target);
  return { ok: true, recipient: call.to };
}

function dispatchEditFile(call, opts) {
  const target = path.resolve(opts.cwd, call.path);
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
  const target = path.resolve(opts.cwd, call.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, call.content, "utf8");
  return { ok: true, path: call.path };
}

function dispatchRunBash(call, opts) {
  try {
    const out = execSync(call.command, {
      cwd: call.cwd ? path.resolve(opts.cwd, call.cwd) : opts.cwd,
      timeout: call.timeout_ms ?? 30000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024
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
        case "edit_file": res = dispatchEditFile(call, { cwd }); break;
        case "write_file": res = dispatchWriteFile(call, { cwd }); break;
        case "run_bash": res = dispatchRunBash(call, { cwd }); break;
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
