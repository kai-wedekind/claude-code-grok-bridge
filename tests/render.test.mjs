import test from "node:test";
import assert from "node:assert/strict";

import {
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult
} from "../plugins/grok-build/scripts/lib/render.mjs";

test("renderReviewResult does not print the headline twice as its own detail", () => {
  // For most failure codes `failureMessage` IS the headline, so printing both handed the reader
  // the identical sentence twice with "- Details:" in front of the second one. The same double
  // was already fixed at three other call sites in render.mjs; this was the one left.
  const headline = "Grok returned no output.";
  const duplicate = renderReviewResult(
    { parsed: null, parseError: "ignored" },
    { reviewLabel: "Review", failureCode: "no-deliverable", failureMessage: headline }
  );
  assert.match(duplicate, /Grok returned no output\./);
  assert.doesNotMatch(duplicate, /Details:/, "a detail identical to the headline must be dropped");

  // The fallback headline, reached when the code is unknown, has to dedupe too.
  const fallback = renderReviewResult(
    { parsed: null, parseError: "Grok did not return valid structured JSON." },
    { reviewLabel: "Review" }
  );
  assert.doesNotMatch(fallback, /Details:/);

  // And a detail that genuinely says something else must survive.
  const informative = renderReviewResult(
    { parsed: null, parseError: "ignored" },
    { reviewLabel: "Review", failureCode: "no-deliverable", failureMessage: "socket hang up after 40s" }
  );
  assert.match(informative, /- Details: socket hang up after 40s/);
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
      reviewLabel: "Critique",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Grok returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("a failed image probe is reported, not just recorded", () => {
  // A06. tracked-jobs wrote agentImageProbe and nothing anywhere read it, so the one thing
  // it was added to make observable stayed invisible. The distinction it carries is real:
  // an ABSENT image is also what a record written before images were captured looks like,
  // and only this field separates "we looked and could not tell" from "nobody looked".
  const base = { id: "run-1", status: "running", title: "t", agentPid: 4242 };

  const probed = renderJobStatusReport({ ...base, agentImageProbe: "unavailable" });
  assert.match(probed, /Process fingerprint unavailable — stop matches on name alone/);

  const identified = renderJobStatusReport({ ...base, agentImage: "grok.exe" });
  assert.doesNotMatch(
    identified,
    /fingerprint unavailable/,
    "a run whose image WAS read must not carry the warning"
  );

  const silent = renderJobStatusReport(base);
  assert.doesNotMatch(
    silent,
    /fingerprint unavailable/,
    "a record that predates image capture must stay silent rather than claim a failed probe"
  );
});

test("renderStoredJobResult surfaces Grok's subagent strands and says when some produced nothing", () => {
  // The whole point of R08. Before this, a fan-out where four of six strands died looked
  // identical to one where all six succeeded: same synthesis, same charge, no signal.
  const job = {
    id: "run-1",
    status: "completed",
    threadId: "thr_1",
    subagents: {
      sessionDir: "C:\\sessions\\thr_1",
      strands: [
        { id: "a", type: "explore", description: "read the issues", status: "completed", outputChars: 5204, toolCalls: 7, output: "FINDINGS-A" },
        { id: "b", type: "general-purpose", description: "audit probes", status: "failed", outputChars: 0, toolCalls: 0, output: null }
      ]
    }
  };
  const output = renderStoredJobResult(job, { rendered: "the synthesis" });

  assert.match(output, /the synthesis/, "the result itself must survive");
  assert.match(output, /Subagents: 2 \(1 completed, 1 failed\)/);
  assert.match(output, /\+ \[explore\] read the issues — 5204 chars, 7 tools/);
  assert.match(output, /! \[general-purpose\] audit probes — no output/);
  assert.match(output, /1 of 2 finished strands produced nothing — this answer rests on 1./);
  assert.doesNotMatch(output, /FINDINGS-A/, "the summary view must not dump every strand");
  assert.match(output, /--strands/, "and must say how to get them");

  const full = renderStoredJobResult(job, { rendered: "the synthesis" }, { showStrandOutput: true });
  assert.match(full, /--- strand: read the issues \[explore\] ---/);
  assert.match(full, /FINDINGS-A/);
});

test("renderStoredJobResult is unchanged for runs that never fanned out", () => {
  // A job with no strands must render byte-for-byte as before, or every existing caller
  // and every doc example silently drifts.
  const job = { id: "run-2", status: "completed", threadId: "thr_2" };
  const storedJob = { rendered: "plain answer" };
  const withoutKey = renderStoredJobResult(job, storedJob);
  const withEmpty = renderStoredJobResult({ ...job, subagents: { strands: [] } }, storedJob);

  // ⚠ Equality alone is not enough and the first version of this test stopped there: two
  // empty strings are equal, so a wrapper that dropped the body entirely would have passed
  // while claiming to prove the opposite. Audit 2026-08-09. Pin the actual content.
  assert.equal(withoutKey, "plain answer\n\nGrok session ID: thr_2\nResume in Grok: grok -r thr_2\n");
  assert.equal(withEmpty, withoutKey, "an empty strand list must render as no strand list");
  assert.doesNotMatch(withoutKey, /Subagents:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Grok Build Critique",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Grok Build Critique\n\nTarget: working tree diff\nVerdict: needs-attention\n",
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

  assert.match(output, /^# Grok Build Critique/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Grok session ID: thr_123/);
  assert.match(output, /Resume in Grok: grok -r thr_123/);
});
