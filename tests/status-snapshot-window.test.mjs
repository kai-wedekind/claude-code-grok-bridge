/**
 * `runs` shows the active runs, the latest finished one, and up to eight more finished ones. The
 * cap applies after the active runs are filtered out; applied before, eight active runs fill the
 * window and every older finished run disappears (upstream #70).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";
import { buildStatusSnapshot } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { createProgressReporter } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

const SESSION = "session-window";

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

// Recent timestamps on purpose: an active record with no pid is reclaimed as orphaned only once
// it is older than the no-pid grace, and these have to stay active. Every seed of a test counts
// back from the same instant, so a slow write cannot reorder them.
function seed(workspace, id, status, secondsAgo, now) {
  const at = new Date(now - secondsAgo * 1000).toISOString();
  const job = {
    id,
    sessionId: SESSION,
    status,
    phase: status,
    jobClass: "task",
    title: id,
    createdAt: at,
    updatedAt: at,
    logFile: null
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
}

test("finished runs stay visible when the window is full of active runs", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const now = Date.now();
    for (let i = 0; i < 8; i++) seed(workspace, `run-${i}`, "running", i + 1, now);
    for (let i = 0; i < 5; i++) seed(workspace, `done-${i}`, "completed", 60 + i, now);

    const snapshot = buildStatusSnapshot(workspace, { sessionId: SESSION, maxJobs: 8 });
    assert.equal(snapshot.running.length, 8);
    assert.equal(snapshot.latestFinished?.id, "done-0");
    assert.deepEqual(
      snapshot.recent.map((job) => job.id),
      ["done-1", "done-2", "done-3", "done-4"]
    );
  });
});

// The latest finished run is reported on its own, so it no longer takes one of the capped slots.
test("the cap bounds the finished runs after the latest one", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const now = Date.now();
    for (let i = 0; i < 12; i++) seed(workspace, `done-${i}`, "completed", i + 1, now);

    const snapshot = buildStatusSnapshot(workspace, { sessionId: SESSION, maxJobs: 3 });
    assert.equal(snapshot.latestFinished?.id, "done-0");
    assert.deepEqual(
      snapshot.recent.map((job) => job.id),
      ["done-1", "done-2", "done-3"]
    );
  });
});

test("a progress event without a pid reports null, not pid 0", () => {
  const seen = [];
  const report = createProgressReporter({ onEvent: (event) => seen.push(event) });
  report({ message: "hello", phase: "running" });
  report({ message: "with pid", phase: "running", agentPid: 4242 });
  assert.equal(seen[0].agentPid, null);
  assert.equal(seen[1].agentPid, 4242);
});
