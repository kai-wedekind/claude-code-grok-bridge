import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  ensureStateDir,
  loadState,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "grok-build", "scripts", "session-lifecycle-hook.mjs");

// The host kills SessionEnd after 30 seconds. Anything close to that is a failure even
// if the assertions pass, so the test asserts the wall clock too.
const HOST_HOOK_BUDGET_MS = 30000;

function spawnLongLivedChild() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {
    stdio: "ignore",
    detached: false
  });
  return child;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIsAlive(pid);
}

/**
 * Hold the workspace's state lock with a token naming a process that is provably alive
 * (this test runner) and a fresh mtime. Neither reclaim path applies: the holder is not
 * gone, and the age backstop is three minutes away. Any waiter is stuck for its full
 * deadline — which is exactly the condition this test exists for.
 */
function wedgeStateLock(workspace) {
  ensureStateDir(workspace);
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, `${process.pid}:wedged-by-test`, "utf8");
  return lockPath;
}

// Regression for the ordering the hook had until 2026-07-28: claim the job terminal
// first, kill second. claimJobTerminal takes the state lock, whose own deadline (210s)
// is seven times the hook's entire host budget — so a single wedged lock meant the kill
// line was never reached and the agent outlived the session for good. Reclaim's opposite
// order is right for reclaim (a failed write is the signal that "abandoned" was a guess
// not worth acting on); here nothing is guessed, the job belongs to the ending session.
test("session end kills a live job even when the state lock is wedged", async (t) => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  const child = spawnLongLivedChild();
  const childPid = child.pid;
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
    }
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  });

  const now = new Date().toISOString();
  const job = {
    id: "job-wedged",
    sessionId: "session-ending",
    status: "running",
    phase: "running",
    jobClass: "task",
    title: "a run that must not survive its session",
    workspaceRoot: workspace,
    agentPid: childPid,
    agentImage: path.basename(process.execPath),
    createdAt: now,
    updatedAt: now,
    logFile: null
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  const lockPath = wedgeStateLock(workspace);
  assert.ok(processIsAlive(childPid), "the job's process must be running before the hook");

  const startedAt = Date.now();
  const result = run(process.execPath, [HOOK, "SessionEnd"], {
    cwd: workspace,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: workspace,
      session_id: "session-ending"
    })
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 0, `hook must not fail on a wedged lock: ${result.stderr}`);
  assert.ok(
    await waitForExit(childPid, 5000),
    "the agent must be killed even though its record could not be updated"
  );
  assert.ok(
    elapsed < HOST_HOOK_BUDGET_MS,
    `hook took ${elapsed}ms; the host kills it at ${HOST_HOOK_BUDGET_MS}ms`
  );

  // The lock was never ours to release, and stealing it would break whoever holds it.
  assert.equal(
    fs.readFileSync(lockPath, "utf8").trim(),
    `${process.pid}:wedged-by-test`,
    "a blocked hook must not steal a live holder's lock"
  );

  // The record stays "running" because the write genuinely could not happen. That is
  // honest — and reclaim will correct it later, with the pids still on the record.
  const stored = loadState(workspace).jobs.find((entry) => entry.id === "job-wedged");
  assert.ok(stored, "the job record must survive");
  assert.equal(stored.agentPid, childPid, "kill targets stay on the record for reclaim");
});

// The ordering must not have cost the normal path anything: with a free lock the job
// still ends up cancelled, not merely killed.
test("session end still records the cancellation when the lock is free", async (t) => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  const child = spawnLongLivedChild();
  const childPid = child.pid;
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
    }
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  });

  const now = new Date().toISOString();
  const job = {
    id: "job-free-lock",
    sessionId: "session-ending",
    status: "running",
    phase: "running",
    jobClass: "task",
    title: "a run cancelled the ordinary way",
    workspaceRoot: workspace,
    agentPid: childPid,
    agentImage: path.basename(process.execPath),
    createdAt: now,
    updatedAt: now,
    logFile: null
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  const result = run(process.execPath, [HOOK, "SessionEnd"], {
    cwd: workspace,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: workspace,
      session_id: "session-ending"
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(await waitForExit(childPid, 5000), "the agent must be killed");

  const stored = loadState(workspace).jobs.find((entry) => entry.id === "job-free-lock");
  assert.equal(stored.status, "cancelled", "an uncontended lock must still record the outcome");
  assert.match(stored.errorMessage || "", /session end/i);
});
