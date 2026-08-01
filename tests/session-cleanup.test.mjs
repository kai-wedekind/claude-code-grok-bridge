import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  listJobs,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "grok-build", "scripts", "session-lifecycle-hook.mjs");

function seedJob(workspace, id, sessionId, status, extra = {}) {
  const job = {
    id,
    sessionId,
    status,
    jobClass: "task",
    title: `job ${id}`,
    workspaceRoot: workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logFile: null,
    ...extra
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
  return job;
}

function runSessionEnd(workspace, sessionId, env) {
  return run(process.execPath, [HOOK, "SessionEnd"], {
    cwd: workspace,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: workspace, session_id: sessionId })
  });
}

test("session end keeps other sessions' jobs and this session's finished results", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    seedJob(workspace, "job-mine-done", "session-A", "completed");
    seedJob(workspace, "job-mine-live", "session-A", "running");
    seedJob(workspace, "job-other-live", "session-B", "running");
    seedJob(workspace, "job-other-done", "session-B", "completed");

    // Pin: another session's job keeps its status AND its log file, not only its record.
    const otherLiveLog = resolveJobLogFile(workspace, "job-other-live");
    fs.writeFileSync(otherLiveLog, "other-session still running log\n", "utf8");
    const otherLive = loadState(workspace).jobs.find((job) => job.id === "job-other-live");
    writeJobFile(workspace, "job-other-live", { ...otherLive, logFile: otherLiveLog, status: "running" });
    upsertJob(workspace, { id: "job-other-live", logFile: otherLiveLog, status: "running" });

    const otherDoneLog = resolveJobLogFile(workspace, "job-other-done");
    fs.writeFileSync(otherDoneLog, "other-session finished log\n", "utf8");
    const otherDone = loadState(workspace).jobs.find((job) => job.id === "job-other-done");
    writeJobFile(workspace, "job-other-done", {
      ...otherDone,
      logFile: otherDoneLog,
      status: "completed"
    });
    upsertJob(workspace, { id: "job-other-done", logFile: otherDoneLog, status: "completed" });

    const result = runSessionEnd(workspace, "session-A", {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    });
    assert.equal(result.status, 0, result.stderr);

    const ids = new Set(loadState(workspace).jobs.map((job) => job.id));
    // Another session's runs must survive untouched — their files too.
    assert.equal(ids.has("job-other-live"), true, "another session's running job must survive");
    assert.equal(ids.has("job-other-done"), true, "another session's finished job must survive");
    assert.equal(fs.existsSync(resolveJobFile(workspace, "job-other-live")), true, "its job file must survive");
    assert.equal(fs.existsSync(resolveJobFile(workspace, "job-other-done")), true, "its job file must survive");

    const otherLiveAfter = loadState(workspace).jobs.find((job) => job.id === "job-other-live");
    assert.equal(otherLiveAfter.status, "running", "another session's job must keep its status");
    assert.equal(fs.existsSync(otherLiveLog), true, "another session's log file must survive");
    assert.match(fs.readFileSync(otherLiveLog, "utf8"), /other-session still running log/);

    const otherDoneAfter = loadState(workspace).jobs.find((job) => job.id === "job-other-done");
    assert.equal(otherDoneAfter.status, "completed", "another session's finished job keeps status");
    assert.equal(fs.existsSync(otherDoneLog), true, "another session's finished log must survive");
    assert.match(fs.readFileSync(otherDoneLog, "utf8"), /other-session finished log/);

    // This session's finished result is history the user may still want to read.
    assert.equal(ids.has("job-mine-done"), true, "own finished job must be kept as history");

    // Its own active job is cancelled, but the record survives so the user can see it.
    const mineLive = loadState(workspace).jobs.find((job) => job.id === "job-mine-live");
    assert.ok(mineLive, "own active job must remain visible after session end");
    assert.equal(mineLive.status, "cancelled", "own active job must be marked cancelled");

    assert.equal(listJobs(workspace).length, 4, "no job record may be destroyed by session end");
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("session end reaps this session's jobs across every workspace under the state root", () => {
  const pluginDataDir = makeTempDir();
  const workspaceA = makeTempDir();
  const workspaceB = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    // Session A started a run in workspace A and another with --cwd workspace B.
    seedJob(workspaceA, "job-a-live", "session-A", "running");
    seedJob(workspaceB, "job-b-live", "session-A", "running");
    seedJob(workspaceB, "job-b-other", "session-B", "running");

    // Distinct state dirs under the same root.
    assert.notEqual(resolveStateDir(workspaceA), resolveStateDir(workspaceB));

    const result = runSessionEnd(workspaceA, "session-A", {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    });
    assert.equal(result.status, 0, result.stderr);

    const aLive = loadState(workspaceA).jobs.find((job) => job.id === "job-a-live");
    assert.equal(aLive?.status, "cancelled", "primary workspace job must be cancelled");

    const bLive = loadState(workspaceB).jobs.find((job) => job.id === "job-b-live");
    assert.equal(
      bLive?.status,
      "cancelled",
      "same session job in another workspace (--cwd) must be cancelled"
    );

    const bOther = loadState(workspaceB).jobs.find((job) => job.id === "job-b-other");
    assert.equal(bOther?.status, "running", "other session's job in foreign workspace must stay running");
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
