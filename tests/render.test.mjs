import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderStatusReport } from "../plugins/codex/scripts/lib/render.mjs";

function baseStatusReport(overrides = {}) {
  return {
    sessionRuntime: { label: "ready" },
    config: { stopReviewGate: false },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: false,
    ...overrides
  };
}

test("renderStatusReport surfaces per-turn telemetry stats when present", () => {
  const output = renderStatusReport(
    baseStatusReport({
      stats: {
        total: 3,
        durationP50: 2000,
        durationP95: 3000,
        durationMax: 3000,
        stallRate: 0,
        restartRate: 0,
        restartRateSource: "interrupted",
        recommendation: "Timeouts look well-matched to observed turn durations; no change recommended."
      }
    })
  );
  assert.match(output, /Turn stats/);
  assert.match(output, /turns 3 \| p50 2000ms \| p95 3000ms \| max 3000ms/);
  assert.match(output, /stall rate 0\.0% \| restart rate 0\.0% \(source: interrupted\)/);
  assert.match(output, /well-matched/);
});

test("renderStatusReport omits the stats section when there is no telemetry", () => {
  const output = renderStatusReport(baseStatusReport());
  assert.doesNotMatch(output, /Turn stats/);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
