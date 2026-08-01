import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { renderReviewResult } from "../plugins/grok-build/scripts/lib/render.mjs";
import { reclaimOrphanedJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("a cleared review result names the real failure, not a JSON parse problem", () => {
  const cases = [
    ["timeout", /time limit/i],
    ["cli-error", /CLI failed/i],
    ["output-truncated", /capture limit|cut off/i],
    ["no-deliverable", /no output/i]
  ];

  for (const [failureCode, expected] of cases) {
    const rendered = renderReviewResult(
      { parsed: null, parseError: "Grok did not return valid structured JSON.", rawOutput: "" },
      { reviewLabel: "Critique", targetLabel: "worktree", failureCode, failureMessage: `synthetic ${failureCode}` }
    );

    assert.match(rendered, expected, `${failureCode} must be named in the rendered text`);
    assert.doesNotMatch(
      rendered,
      /did not return valid structured JSON/i,
      `${failureCode} must not be blamed on the model's JSON`
    );
  }
});

test("a genuine schema failure still reads as one", () => {
  const rendered = renderReviewResult(
    { parsed: null, parseError: "Unexpected token }", rawOutput: "" },
    { reviewLabel: "Critique", targetLabel: "worktree", failureCode: "schema-parse" }
  );

  assert.match(rendered, /did not return valid structured JSON/i);
  assert.match(rendered, /Unexpected token/);
});

test("orphan reclaim of a dead process survives an unwritable state volume", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-gone-unwritable";
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Bridge died",
      bridgePid: 727101,
      pid: 727101,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    // runs, stop and show --wait all walk the job list through this function. If a
    // failed write escapes here, every one of them dies instead of listing what it can.
    let reclaimed;
    assert.doesNotThrow(() => {
      reclaimed = reclaimOrphanedJob(workspace, job, {
        isGoneImpl: () => true,
        claimTerminalImpl: () => {
          throw new Error("EROFS: read-only file system");
        }
      });
    }, "a failed terminal claim must not propagate out of reclaim");

    assert.equal(reclaimed.status, "running", "the job stays as it was when it cannot be updated");
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
    assert.equal(stored.status, "running");
  });
});
