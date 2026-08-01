import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  createJobProgressUpdater,
  runTrackedJob
} from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

// await, not return: a non-awaiting version restores the environment in its finally while
// the async body is still running, so every state write lands somewhere else and the
// assertions look at an empty workspace. Cost three red tests to notice.
async function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return await fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function seedRunning(workspace, id, extra = {}) {
  const now = new Date().toISOString();
  const job = {
    id,
    sessionId: "s",
    status: "running",
    phase: "running",
    jobClass: "task",
    title: "a run",
    workspaceRoot: workspace,
    createdAt: now,
    updatedAt: now,
    logFile: null,
    ...extra
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
  return job;
}

// From the field report: a record that stops being updated while the log keeps growing is
// the shape of a run nobody can account for afterwards, and the bare catch around the
// progress write made that silence look like nothing had happened.
test("a failing progress write is said out loud, once", () => {
  const logFile = path.join(makeTempDir(), "job.log");
  fs.writeFileSync(logFile, "");

  // Point the state root at a FILE. Creating the state directory beneath it then fails
  // with ENOTDIR — the same class as an unwritable or full volume, and reliable on every
  // platform, unlike an exotic path that some systems happily create.
  const blocker = path.join(makeTempDir(), "not-a-directory");
  fs.writeFileSync(blocker, "x");

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = blocker;
  try {
    const update = createJobProgressUpdater(makeTempDir(), "run-x", { logFile });
    update({ phase: "running", message: "first" });
    update({ phase: "finalizing", message: "second" });
    update({ phase: "done", message: "third" });
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  const written = fs.readFileSync(logFile, "utf8");
  const hits = written.split("\n").filter((l) => l.includes("Progress could not be recorded"));
  assert.equal(hits.length, 1, "exactly once — silent is wrong, and flooding the log is worse");
  assert.match(written, /further failures are not repeated/);
});

// The backstop. Every ordinary path claims terminal, but "every path I thought of" is how
// a record ends up stuck on running, which stranded three finished runs and made a caller
// poll for 25 minutes. A hard kill still cannot be caught here — reclaim remains the
// answer for that — but anything that returns from this function leaves a terminal record.
test("an ordinary run still ends terminal", async () => {
  await withPluginData(async () => {
    const workspace = makeTempDir();
    seedRunning(workspace, "run-ok");

    await runTrackedJob(
      { id: "run-ok", workspaceRoot: workspace, title: "a run" },
      async () => ({ exitStatus: 0, payload: {}, rendered: "fertig", summary: "done" }),
      { logFile: path.join(makeTempDir(), "x.log") }
    );

    const job = listJobs(workspace).find((j) => j.id === "run-ok");
    assert.ok(job, "the job must still exist");
    assert.notEqual(job.status, "running", "a returned run must never stay running");
  });
});

test("a throwing runner leaves a terminal record and keeps the kill targets", async () => {
  await withPluginData(async () => {
    const workspace = makeTempDir();
    seedRunning(workspace, "run-throws", { agentPid: 424242 });

    await assert.rejects(
      runTrackedJob(
        { id: "run-throws", workspaceRoot: workspace, title: "a run", agentPid: 424242 },
        async () => {
          throw new Error("the runner blew up");
        },
        { logFile: path.join(makeTempDir(), "y.log") }
      ),
      /blew up/
    );

    const job = listJobs(workspace).find((j) => j.id === "run-throws");
    assert.equal(job.status, "failed");
    assert.equal(
      job.agentPid,
      424242,
      "an exception mid-run is exactly when an agent may be orphaned — stop must still reach it"
    );
  });
});
