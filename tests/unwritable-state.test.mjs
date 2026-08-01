import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { runTrackedJob } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { resolveResultJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

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

test("asking to show an active run says it is still running, not that it does not exist", () => {
  return withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "run-active-show";
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      kind: "task",
      kindLabel: "Run",
      title: "Active",
      jobClass: "task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    assert.throws(
      () => resolveResultJob(workspace, jobId),
      /still (queued|running)/i,
      "the run exists — the message has to say it is not finished yet"
    );
  });
});

test("a finished result is handed back even when it cannot be recorded", async () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    const workspace = makeTempDir();
    const jobId = "run-unwritable-state";
    const job = {
      id: jobId,
      workspaceRoot: workspace,
      status: "queued",
      kind: "task",
      kindLabel: "Run",
      title: "Work that outlives its record",
      jobClass: "task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    // The agent finished. Only writing the outcome fails — a full or read-only volume.
    // Losing the answer at that point would be the worst possible response.
    const execution = await runTrackedJob(
      job,
      async () => ({
        exitStatus: 0,
        threadId: "thread-1",
        turnId: null,
        payload: { delivered: true, rawOutput: "THE ANSWER" },
        rendered: "THE ANSWER\n",
        summary: "done"
      }),
      { claimTerminalImpl: () => { throw new Error("ENOSPC: no space left on device"); } }
    );

    assert.equal(execution.payload.rawOutput, "THE ANSWER", "the result must survive");
    // It has to reach the surfaces a caller reads — the JSON payload and the printed
    // text. A flag on the internal return value alone tells nobody anything, and the job
    // log sits on the volume that just failed.
    assert.equal(execution.payload.persisted, false, "the JSON payload must say it is unrecorded");
    assert.match(execution.payload.persistError ?? "", /ENOSPC/);
    assert.match(execution.rendered, /THE ANSWER/, "the printed text keeps the answer");
    assert.match(execution.rendered, /could not be recorded/i, "and states that it was not stored");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
