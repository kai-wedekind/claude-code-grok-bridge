import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";
import {
  buildSingleJobSnapshot,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/grok-build/scripts/lib/job-control.mjs";

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

function seed(workspace, id, extra = {}) {
  const now = new Date().toISOString();
  const job = {
    id,
    sessionId: "s",
    status: "completed",
    phase: "done",
    jobClass: "task",
    title: "a relocated run",
    workspaceRoot: workspace,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    logFile: null,
    ...extra
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
}

// The recovery for a run whose workspace key drifted was first added to
// buildSingleJobSnapshot only. `runs <id>` then found the run while `show <id>` and
// `stop <id>` still insisted it did not exist — a worse state than before, because the
// run was now visibly present and still not actionable. Caught by a review pass
// within half an hour of the change, after the same inconsistency had already appeared
// in a manual check and been read past.
test("a relocated run is reachable from every surface, not just runs", () => {
  withPluginData(() => {
    // A workspace that no reader will resolve to from an unrelated cwd.
    const home = makeTempDir();
    seed(home, "run-elsewhere");

    const other = makeTempDir();

    const snapshot = buildSingleJobSnapshot(other, "run-elsewhere");
    assert.equal(snapshot.job.id, "run-elsewhere", "runs <id> must find it");

    const result = resolveResultJob(other, "run-elsewhere");
    assert.equal(result.job.id, "run-elsewhere", "show <id> must open it too");
    assert.equal(result.workspaceRoot, home, "and report where it actually lives");
  });
});

test("a relocated run that is still stoppable can still be stopped", () => {
  withPluginData(() => {
    const home = makeTempDir();
    seed(home, "run-live-elsewhere", {
      status: "running",
      phase: "running",
      completedAt: null,
      // A pid that is certainly not ours keeps reclaim from turning this terminal
      // mid-test; the point here is reachability, not the reclaim decision.
      agentPid: null,
      bridgePid: null
    });

    const other = makeTempDir();
    const cancelable = resolveCancelableJob(other, "run-live-elsewhere");
    assert.equal(cancelable.job.id, "run-live-elsewhere", "stop <id> must reach it");
    assert.equal(cancelable.workspaceRoot, home);
  });
});

test("an id that exists nowhere still reports plainly that it does not exist", () => {
  withPluginData(() => {
    const other = makeTempDir();
    assert.throws(() => buildSingleJobSnapshot(other, "run-does-not-exist"), /No run found/);
    assert.throws(() => resolveResultJob(other, "run-does-not-exist"), /No finished run found/);
    assert.throws(() => resolveCancelableJob(other, "run-does-not-exist"), /No active run found/);
  });
});
