import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  acquireThreadLock,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { reclaimOrphanedJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { renderStoredJobResult } from "../plugins/grok-build/scripts/lib/render.mjs";
import { runHeadlessAgent } from "../plugins/grok-build/scripts/lib/grok.mjs";
import * as stateLib from "../plugins/grok-build/scripts/lib/state.mjs";

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

// ---------------------------------------------------------------------------
// DEFECT 1 — thread lock stolen from live runs (mtime never refreshed)
// ---------------------------------------------------------------------------

test("DEFECT1: live thread lock is not reclaimable after age when mtime is heartbeated", () => {
  withPluginData(() => {
    assert.equal(
      typeof stateLib.touchThreadLock,
      "function",
      "touchThreadLock must be exported so holders can refresh lock mtime"
    );

    const workspace = makeTempDir();
    const lock = acquireThreadLock(workspace, "longrun");
    assert.ok(lock, "first acquisition must succeed");

    const lockPath = path.join(resolveStateDir(workspace), "thread-longrun.lock");
    assert.equal(fs.existsSync(lockPath), true);

    // Simulate a multi-minute hold without process death: age the lock past the
    // 180s live-max backstop. Before the fix this made the lock stealable.
    const ancient = new Date(Date.now() - 200_000);
    fs.utimesSync(lockPath, ancient, ancient);
    assert.ok(Date.now() - fs.statSync(lockPath).mtimeMs > 180_000);

    // Holder refreshes mtime (heartbeat / touch). After the fix a second run must
    // still see the lock as live.
    assert.equal(stateLib.touchThreadLock(workspace, "longrun"), true);
    assert.ok(
      Date.now() - fs.statSync(lockPath).mtimeMs < 5_000,
      "touchThreadLock must refresh the lock file mtime"
    );

    const stolen = acquireThreadLock(workspace, "longrun");
    assert.equal(
      stolen,
      null,
      "a live holder that heartbeats must not lose the thread lock to age reclaim"
    );

    lock.release();
  });
});

test("DEFECT1: the heartbeat timer actually runs and refreshes mtime on its own", async () => {
  // withPluginData restores synchronously, so an async body has to manage the env itself.
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    const workspace = makeTempDir();
    const lock = acquireThreadLock(workspace, "beating", { heartbeatMs: 40 });
    assert.ok(lock, "first acquisition must succeed");

    const lockPath = path.join(resolveStateDir(workspace), "thread-beating.lock");
    const ancient = new Date(Date.now() - 200_000);
    fs.utimesSync(lockPath, ancient, ancient);

    // Nothing touches the lock here. If the interval were never started, mtime would
    // stay ancient and the fix would be inert while every other test still passed.
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.ok(
      Date.now() - fs.statSync(lockPath).mtimeMs < 5_000,
      "the heartbeat must refresh the lock file without the caller touching it"
    );

    lock.release();
    assert.equal(fs.existsSync(lockPath), false, "release must remove the lock file");

    // The interval must be cleared on release: otherwise it would keep touching a path
    // a successor now owns.
    const successor = acquireThreadLock(workspace, "beating");
    assert.ok(successor, "successor must be able to take the released thread");
    const successorMtime = fs.statSync(lockPath).mtimeMs;
    fs.utimesSync(lockPath, ancient, ancient);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(
      Date.now() - fs.statSync(lockPath).mtimeMs > 100_000,
      "a released holder's heartbeat must not keep refreshing the successor's lock"
    );
    assert.ok(Number.isFinite(successorMtime));
    successor.release();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("DEFECT1: aged thread lock without refresh remains reclaimable (backstop preserved)", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "thread-stale.lock");
    // Live pid (this process) but ancient mtime and no heartbeat — the recycled-PID
    // backstop must still allow reclaim when the holder is not refreshing.
    fs.writeFileSync(lockPath, `${process.pid}:stale-no-heartbeat`, "utf8");
    const ancient = new Date(Date.now() - 200_000);
    fs.utimesSync(lockPath, ancient, ancient);

    const reclaimed = acquireThreadLock(workspace, "stale");
    assert.ok(reclaimed, "age backstop must still reclaim a non-heartbeating lock");
    reclaimed.release();
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — MAX_JOBS prune deletes active jobs
// ---------------------------------------------------------------------------

test("DEFECT2: prune never drops queued/running jobs even when over the cap", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    // 49 terminal jobs (newest) + 2 older active jobs = 51 total.
    // Pre-fix prune sorts by updatedAt and keeps the newest 50, dropping the
    // oldest active job and deleting its job/log files.
    const jobs = [];
    for (let index = 0; index < 49; index += 1) {
      const jobId = `done-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 2, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
      jobs.push({
        id: jobId,
        status: "completed",
        logFile,
        updatedAt,
        createdAt: updatedAt
      });
    }

    for (const [jobId, status, minute] of [
      ["active-running", "running", 0],
      ["active-queued", "queued", 1]
    ]) {
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, minute, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status }, null, 2), "utf8");
      jobs.push({
        id: jobId,
        status,
        logFile,
        updatedAt,
        createdAt: updatedAt
      });
    }

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`,
      "utf8"
    );

    saveState(workspace, { version: 1, config: {}, jobs });

    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const ids = new Set(saved.jobs.map((job) => job.id));
    assert.equal(ids.has("active-running"), true, "running job must survive prune");
    assert.equal(ids.has("active-queued"), true, "queued job must survive prune");
    assert.equal(fs.existsSync(resolveJobFile(workspace, "active-running")), true);
    assert.equal(fs.existsSync(resolveJobLogFile(workspace, "active-running")), true);
    assert.equal(fs.existsSync(resolveJobFile(workspace, "active-queued")), true);
    assert.equal(fs.existsSync(resolveJobLogFile(workspace, "active-queued")), true);

    // Active jobs alone may push the list over 50; that is preferred over destroying them.
    assert.ok(saved.jobs.length <= 51);
    assert.ok(saved.jobs.length >= 2);
  });
});

test("DEFECT2: when active jobs alone exceed the budget, all actives are kept", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    const jobs = Array.from({ length: 55 }, (_, index) => {
      const jobId = `run-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running" }, null, 2), "utf8");
      return {
        id: jobId,
        status: "running",
        logFile,
        updatedAt,
        createdAt: updatedAt
      };
    });

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`,
      "utf8"
    );

    saveState(workspace, { version: 1, config: {}, jobs });

    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(saved.jobs.length, 55, "all in-flight jobs must be retained past MAX_JOBS");
    for (const job of jobs) {
      assert.equal(fs.existsSync(resolveJobFile(workspace, job.id)), true);
      assert.equal(fs.existsSync(resolveJobLogFile(workspace, job.id)), true);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — active jobs with no PIDs never reclaimed
// ---------------------------------------------------------------------------

test("DEFECT3: no-pid active job is left alone during the startup grace period", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const now = new Date().toISOString();
    const job = {
      id: "job-just-enqueued",
      status: "queued",
      phase: "queued",
      title: "Fresh enqueue",
      bridgePid: null,
      agentPid: null,
      pid: null,
      createdAt: now,
      updatedAt: now
    };
    const same = reclaimOrphanedJob(workspace, job);
    assert.equal(same.status, "queued", "fresh no-pid job must not be reclaimed immediately");
  });
});

test("DEFECT3: no-pid active job older than the grace period is reclaimed as orphaned", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    // Well past any reasonable enqueue→pid-patch window.
    const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const job = {
      id: "job-ghost-no-pid",
      status: "running",
      phase: "running",
      title: "Ghost",
      bridgePid: null,
      agentPid: null,
      pid: null,
      createdAt: old,
      updatedAt: old
    };
    const reclaimed = reclaimOrphanedJob(workspace, job);
    assert.equal(reclaimed.status, "failed", "stale no-pid ghost must be reclaimed");
    assert.match(reclaimed.errorMessage || "", /Orphaned/i);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 4 — show presents failed run partial output as success
// ---------------------------------------------------------------------------

test("DEFECT4: failed stored job with rawOutput is framed as failure, not a completed result", () => {
  const partial = "model said something before the wall-clock kill\n";
  const output = renderStoredJobResult(
    {
      id: "job-timeout-1",
      status: "failed",
      title: "Grok Build Delegate",
      failureCode: "timeout",
      errorMessage: "Run timed out."
    },
    {
      status: "failed",
      result: {
        rawOutput: partial,
        failureCode: "timeout",
        delivered: false
      }
    }
  );

  assert.match(output, /fail|did not succeed|timed out|timeout/i, "must state the failure");
  assert.match(output, /partial/i, "must label leftover text as partial");
  assert.match(output, /model said something before the wall-clock kill/);
  // Must not present the partial as a bare successful result (verbatim-only early return).
  assert.notEqual(output.trim(), partial.trim());
});

test("DEFECT4: failureCode with non-empty grok.stdout is not rendered as success", () => {
  const partial = "truncated mid-stream output";
  const output = renderStoredJobResult(
    {
      id: "job-trunc-1",
      status: "failed",
      title: "Grok Build Delegate"
    },
    {
      result: {
        grok: { stdout: partial },
        failureCode: "output-truncated"
      }
    }
  );

  assert.match(output, /fail|did not succeed|truncated|output-truncated/i);
  assert.match(output, /partial/i);
  assert.match(output, /truncated mid-stream output/);
  assert.notEqual(output.trim(), partial.trim());
});

// ---------------------------------------------------------------------------
// DEFECT 5 — prompt hand-over file is world-readable
// ---------------------------------------------------------------------------

test("DEFECT5: long prompt hand-over file is created with mode 0o600", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const writes = [];
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(filePath, data, options) {
    writes.push({ filePath: String(filePath), options });
    return originalWriteFileSync.call(this, filePath, data, options);
  };

  try {
    // Above PROMPT_ARGV_LIMIT (4000) so runHeadlessAgent writes a temp prompt file.
    const longPrompt = `x`.repeat(4500);
    await runHeadlessAgent(cwd, {
      prompt: longPrompt,
      env,
      globalSlot: false
    });

    const promptWrite = writes.find((entry) => entry.filePath.includes("grok-cc-prompt-"));
    assert.ok(promptWrite, "expected a temporary grok-cc-prompt-* hand-over file write");
    assert.equal(
      typeof promptWrite.options,
      "object",
      "writeFileSync must receive an options object (not a bare encoding string) so mode applies at creation"
    );
    assert.equal(
      promptWrite.options.mode,
      0o600,
      "prompt hand-over file must be created 0o600 like job logs"
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});
