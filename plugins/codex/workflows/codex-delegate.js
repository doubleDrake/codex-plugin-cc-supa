// codex-delegate.js — Workflow-native A+ delegate orchestration (Phase 3).
//
// This is the Workflow-native replacement for the hand-rolled team-bridge
// ping-pong (skills/codex-team-bridge) and the --pane lifecycle helper
// (skills/codex-pane-helper) when the goal is *orchestration* (not an
// interactive live teammate).
//
// WHY a Workflow:
//   The team-bridge skill expresses the Codex STATUS ping-pong as a manual
//   SendMessage / idle / --resume-last procedure that a Claude agent has to
//   re-derive every run. A Workflow expresses that exact loop as a plain,
//   deterministic JS `while` loop:
//
//       while (status !== "DONE" && turn <= MAX_TURNS) {
//         const r = await agent({ agentType: "codex:codex-delegate", ... });
//         status = r.status;
//         turn += 1;
//       }
//
//   Multiple task descriptions run isolated + concurrently via pipeline() /
//   parallel(), each agent gets its own auto-created / auto-cleaned git
//   worktree via isolation: "worktree" (so there is no need for a plugin-level
//   per-job worktree in the orchestrated case), and the harness notifies on
//   completion. That makes the bridge / pane-helper redundant for the
//   orchestration use case — they remain only for the interactive `--pane`
//   live-teammate case, which a Workflow can't do (no human-in-the-loop
//   SendMessage mid-run).
//
// NOTE the agentType `codex:codex-delegate` is the SAME subagent registered
// for the Agent tool (plugins/codex/agents/codex-delegate.md). The Workflow
// reuses it, so each isolated agent already knows the STATUS protocol and the
// "Codex thinks (read-only), Claude applies" contract.
//
// WORKFLOW RUNTIME CONSTRAINTS (deterministic JS only):
//   - `export const meta` must be a PURE literal (no computed values).
//   - Date.now(), Math.random(), and argless `new Date()` are NOT available.
//     This file uses none of them; the per-turn cap is a plain counter.
//   - Loops / conditionals are allowed and used for the STATUS loop.
//
// Refs: SUP-370 (codex-delegate orchestrator), SUP-381 (codex-team-bridge —
// superseded for orchestration), SUP-386 (codex-pane-helper — superseded for
// orchestration), prompts/delegate.md (STATUS / MUST DO contract this loop
// drives).

export const meta = {
  name: "codex-delegate",
  description:
    "Workflow-native A+ delegate: for each task description, run a Codex STATUS loop (codex thinks read-only, the agent applies + verifies) in its own git worktree, until STATUS: DONE or a 5-turn cap. Multiple tasks run isolated and concurrently. Replaces the team-bridge ping-pong for orchestration; --pane stays for an interactive live teammate.",
  phases: ["plan", "delegate", "report"],
};

// Hard cap on STATUS ping-pong turns per task, mirroring the team-bridge
// skill's 5-round-trip rule. After this the loop stops and the result is
// reported as not-done rather than looping forever.
const MAX_TURNS = 5;

// JSON Schema for the structured result we ask each delegate agent to return.
// `status` is the loop control signal (the trailing STATUS marker from the
// Codex delegate contract in prompts/delegate.md). `summary` and
// `filesChanged` are for the final report. Passing this as opts.schema makes
// the agent return structured output instead of free prose, so the `while`
// loop can branch deterministically on `r.status`.
const DELEGATE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: {
      type: "string",
      enum: ["DONE", "NEEDS_FOLLOW_UP", "BLOCKED"],
      description:
        "Trailing STATUS marker from the Codex delegate turn. DONE closes the loop; NEEDS_FOLLOW_UP continues it; BLOCKED stops it and surfaces the blocker.",
    },
    summary: {
      type: "string",
      description: "One-line summary of what happened on this turn.",
    },
    filesChanged: {
      type: "array",
      items: { type: "string" },
      description: "Repo-relative paths the agent applied + verified this turn.",
    },
    followUp: {
      type: "string",
      description:
        "On NEEDS_FOLLOW_UP: the next-step question or context to feed back into the loop. Empty on DONE.",
    },
  },
};

// Normalize the incoming args into a clean list of task descriptions.
// `args` may arrive as an array (one entry per task) or as a single string
// (the whole command line). A single string with newlines is split into one
// task per non-empty line so a here-doc of tasks works; otherwise it's one
// task. Empty entries are dropped.
function parseTasks(args) {
  let raw;
  if (Array.isArray(args)) {
    raw = args;
  } else if (typeof args === "string") {
    raw = args.includes("\n") ? args.split("\n") : [args];
  } else if (args == null) {
    raw = [];
  } else {
    raw = [String(args)];
  }
  return raw
    .map((t) => (typeof t === "string" ? t.trim() : String(t).trim()))
    .filter((t) => t.length > 0);
}

// Build the per-turn prompt fed to the codex:codex-delegate agent.
// Turn 1 carries the raw task; follow-up turns carry the prior turn's
// follow-up context so the agent resumes where it stopped (the agent itself
// uses --resume-last against its own persistent Codex thread).
function buildPrompt(task, turn, prevFollowUp) {
  if (turn === 1) {
    return (
      `A+ delegate task (Workflow-native, isolated worktree). ` +
      `Codex thinks read-only; you apply + verify. Drive one delegate turn, ` +
      `then return the structured result.\n\n` +
      `Task:\n${task}`
    );
  }
  return (
    `Continue the A+ delegate loop (turn ${turn} of up to ${MAX_TURNS}). ` +
    `Resume your Codex thread with --resume-last, apply + verify the next step, ` +
    `then return the structured result.\n\n` +
    `Original task:\n${task}\n\n` +
    `Follow-up from the previous turn:\n${prevFollowUp || "(none provided)"}`
  );
}

// Run the STATUS loop for a single task in its own worktree. Returns a plain
// object describing the outcome — collected by the report phase.
async function delegateOne(task, index) {
  let turn = 1;
  let status = "NEEDS_FOLLOW_UP";
  let lastSummary = "";
  let followUp = "";
  const filesChanged = [];

  log(`task #${index + 1}: starting — ${task.slice(0, 80)}`);

  while (status !== "DONE" && status !== "BLOCKED" && turn <= MAX_TURNS) {
    const result = await agent({
      agentType: "codex:codex-delegate",
      isolation: "worktree",
      schema: DELEGATE_RESULT_SCHEMA,
      label: `delegate #${index + 1} turn ${turn}`,
      phase: "delegate",
      prompt: buildPrompt(task, turn, followUp),
    });

    // Defensive: a malformed / schema-less result is treated as a follow-up
    // (mirrors the team-bridge "STATUS missing → NEEDS_FOLLOW_UP" rule) so the
    // loop neither crashes nor silently claims DONE.
    status = (result && result.status) || "NEEDS_FOLLOW_UP";
    lastSummary = (result && result.summary) || lastSummary;
    followUp = (result && result.followUp) || "";
    if (result && Array.isArray(result.filesChanged)) {
      for (const f of result.filesChanged) filesChanged.push(f);
    }

    log(`task #${index + 1} turn ${turn}: STATUS ${status} — ${lastSummary}`);
    turn += 1;
  }

  const done = status === "DONE";
  const cappedOut = !done && status !== "BLOCKED" && turn > MAX_TURNS;

  return {
    task,
    status,
    done,
    cappedOut,
    blocked: status === "BLOCKED",
    turns: turn - 1,
    summary: lastSummary,
    filesChanged,
  };
}

export default async function run({ args } = {}) {
  const tasks = parseTasks(args);

  phase("plan");
  if (tasks.length === 0) {
    log("no task descriptions provided — nothing to delegate.");
    return { tasks: [], note: "no tasks" };
  }
  log(
    `planning ${tasks.length} delegate task(s); each runs in an isolated ` +
      `worktree, STATUS loop capped at ${MAX_TURNS} turns.`
  );

  phase("delegate");
  // pipeline() runs the tasks through the delegate stage; each task's loop is
  // independent, so parallel() fans them out concurrently. Worktree isolation
  // keeps their working trees from colliding.
  const results = await pipeline(
    tasks,
    (taskList) =>
      parallel(taskList.map((task, i) => () => delegateOne(task, i)))
  );

  phase("report");
  const doneCount = results.filter((r) => r.done).length;
  const blockedCount = results.filter((r) => r.blocked).length;
  const cappedCount = results.filter((r) => r.cappedOut).length;
  log(
    `delegate complete: ${doneCount}/${results.length} DONE, ` +
      `${blockedCount} BLOCKED, ${cappedCount} hit the ${MAX_TURNS}-turn cap.`
  );
  for (const r of results) {
    log(
      `- [${r.done ? "DONE" : r.status}] (${r.turns} turn${r.turns === 1 ? "" : "s"}) ` +
        `${r.summary || r.task.slice(0, 60)}`
    );
  }

  return {
    total: results.length,
    done: doneCount,
    blocked: blockedCount,
    cappedOut: cappedCount,
    results,
  };
}
