/**
 * Regressions for the stop path's survivor handling and its ledger honesty.
 *
 * The whole complex was one closed loop, found by six independent review passes on
 * 2026-07-28 and repaired on 2026-07-31: stop claims the record and clears its kill
 * targets, kills, and — when the kill did not land — writes the targets back so a later
 * stop can still reach the survivor. Four separate defects made that restore pointless:
 * the second claim nulled the targets again, the aggregate kill reported success as soon
 * as ANY target died, a `cancelled` record was never stoppable no matter what it carried,
 * and the record could be pruned away entirely. A fifth booked the abandoned run as an
 * exact zero in the spend ledger.
 *
 * Not one of the 217 tests that existed at the time went red for any of it.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  claimJobTerminal,
  generateJobId,
  listJobs,
  pruneJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { readStoredJob, resolveCancelableJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import {
  isProcessGone,
  killTargetSettled,
  terminateProcessTree
} from "../plugins/grok-build/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function processAlive(pid) {
  // Through the production predicate, not a bare signal check. On posix a process killed
  // by somebody else stays in the table as a zombie until ITS parent — this test runner —
  // reaps it, and `kill(pid, 0)` answers for a corpse just as it does for a live process.
  // Every assertion here about "the agent really died" would otherwise be answered by the
  // corpse. Found on Linux on 2026-07-31; on Windows the question never arises.
  return !isProcessGone(pid);
}

function waitUntilGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return false;
}

function spawnIdleProcess(cwd) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd,
    stdio: "ignore",
    detached: true
  });
  child.unref();
  return child;
}

function seedJob(repo, overrides) {
  const jobId = generateJobId("run");
  const jobsDir = path.join(resolveStateDir(repo), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, `${jobId}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  const now = new Date().toISOString();
  const job = {
    id: jobId,
    kind: "task",
    kindLabel: "delegate",
    jobClass: "task",
    title: "Grok Build Delegate",
    summary: "seeded",
    workspaceRoot: repo,
    status: "running",
    phase: "running",
    logFile,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  writeJobFile(repo, jobId, job);
  upsertJob(repo, job);
  return job;
}

function withPluginData(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
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
// The `gone` contract the rest of this file rests on.
// ---------------------------------------------------------------------------

test("a target that was never there is settled, not merely undelivered", () => {
  // Windows: taskkill exit 128 means "not killed" on every locale, and liveness decides
  // which kind. `killImpl` must therefore answer, or the verdict would hinge on whether
  // pid 4321 happens to be free on the machine running the suite — which is a coin toss
  // that lands differently in CI than it does on a developer's box.
  const windowsMissing = terminateProcessTree(4321, {
    platform: "win32",
    killImpl: () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    },
    runCommandImpl: () => ({ error: null, status: 128, stdout: "", stderr: "" })
  });
  assert.equal(windowsMissing.delivered, false, "nothing was killed, and that stays true");
  assert.equal(windowsMissing.gone, true);
  assert.equal(killTargetSettled(windowsMissing), true, "but the target is accounted for");

  // Posix: the process is not alive and no signal ever reached anything.
  const posixMissing = terminateProcessTree(4321, {
    platform: "linux",
    killImpl: () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    },
    isAliveImpl: () => false
  });
  assert.equal(posixMissing.delivered, false);
  assert.equal(posixMissing.gone, true, "the posix path used to say nothing at all here");
  assert.equal(killTargetSettled(posixMissing), true);
});

test("a half-walked tree is NOT settled", () => {
  // taskkill hit its bound: one pid was signalled, the tree was not walked. Descendants
  // may well be alive, so this must never let the caller drop the kill targets.
  const timedOut = terminateProcessTree(4321, {
    platform: "win32",
    runCommandImpl: () => ({
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      status: null,
      stdout: "",
      stderr: ""
    }),
    killImpl: () => true
  });
  assert.equal(timedOut.method, "kill-partial");
  assert.equal(killTargetSettled(timedOut), false);

  // The pid belongs to somebody else now: no kill was even attempted. `isGoneImpl` says
  // the pid EXISTS — since 2026-08-01 the image question is skipped for a process that is
  // already gone, and 4321 exists on no test machine.
  const mismatch = terminateProcessTree(4321, {
    platform: "win32",
    isGoneImpl: () => false,
    expectedImage: "grok.exe",
    readImageImpl: () => "notepad.exe"
  });
  assert.equal(mismatch.method, "image-mismatch");
  assert.equal(killTargetSettled(mismatch), false);
});

// ---------------------------------------------------------------------------
// r3 — the aggregate must not be fooled in either direction.
// ---------------------------------------------------------------------------

test("stop still succeeds when one of two targets had already exited", () => {
  // The single most common shape of a stop: the bridge process finished on its own and
  // only the agent is left. A naive every() over `delivered` reports failure here, keeps
  // a corpse pid on the record forever and — once cancelled records became stoppable —
  // makes a bare `stop` refuse to work at all with "Multiple runs are active".
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const agent = spawnIdleProcess(repo);
  const bridge = spawnIdleProcess(repo);
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  process.kill(bridgePid, "SIGKILL");
  assert.ok(waitUntilGone(bridgePid), "the fixture needs the bridge pid to be really gone");

  try {
    const job = withPluginData(pluginDataDir, () =>
      seedJob(repo, { agentPid, bridgePid, pid: bridgePid })
    );

    const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
      cwd: repo,
      env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "cancelled");
    assert.equal(
      payload.killDelivered,
      true,
      "one target killed and one already gone means nothing is left running"
    );
    assert.equal(processAlive(agentPid), false, "and the live one really is dead");

    const stored = withPluginData(pluginDataDir, () => readStoredJob(repo, job.id));
    assert.equal(stored.agentPid, null, "a settled kill clears the targets");
    assert.equal(stored.bridgePid, null);
  } finally {
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
});

test("a surviving target keeps the whole stop undelivered, and stays reachable", () => {
  // The defect in one run: agent survives, bridge dies, `some` calls that delivered, the
  // restore never fires, and the pids are gone for good. Reproduced without any timing
  // luck by pinning an image the agent pid cannot match — the kill is then refused rather
  // than attempted, which is precisely the "not settled" case.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const agent = spawnIdleProcess(repo);
  const bridge = spawnIdleProcess(repo);
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  try {
    const job = withPluginData(pluginDataDir, () =>
      seedJob(repo, {
        agentPid,
        bridgePid,
        pid: bridgePid,
        // Not the image behind that pid, so the kill is refused as image-mismatch.
        agentImage: "grok-that-this-pid-is-not.exe"
      })
    );

    const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
      cwd: repo,
      env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.killDelivered,
      false,
      "one target killed and one untouched is not a delivered kill — `some` said it was"
    );
    assert.equal(processAlive(agentPid), true, "the survivor is the whole point of the case");

    const stored = withPluginData(pluginDataDir, () => readStoredJob(repo, job.id));
    assert.equal(stored.status, "cancelled");
    assert.equal(
      stored.agentPid,
      agentPid,
      "the restored target has to survive the second claim, or nothing can reach the agent"
    );
    assert.equal(
      stored.bridgePid,
      null,
      "and the target that really died must NOT come back, or a bare stop goes ambiguous"
    );

    // And the record has to be reachable again, which is what the restore was for.
    const reachable = withPluginData(pluginDataDir, () =>
      resolveCancelableJob(repo, job.id, { env: {} })
    );
    assert.equal(reachable.job.agentPid, agentPid);
  } finally {
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
});

test("a stop that refuses EVERY target still keeps the pids", () => {
  // The gap the test above cannot see. It seeds two targets — the agent is refused, the
  // bridge really dies — so `attempted` is true and the old gate
  // (`killResult.attempted && !killResult.delivered`) fired anyway. The gate only fails
  // when NOTHING was attempted, and that needs a record whose only target is refused.
  //
  // Then: attempted false, delivered false, and the pre-claim nulls stand unless the
  // restore fires. Which is the whole of condition (2).
  //
  // Added 2026-08-01 after an independent verification pointed out that the red probe for
  // this fix was a source-shaped assertion — it reads the gate's text, so it cannot tell
  // whether the behaviour follows. It was right: the existing CANCELLED test passes
  // with or without this fix, because its kill succeeds.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  // Same fixture as the test above — two live targets, so the record is found the same
  // way — with one difference: BOTH images are pinned to something the pids cannot be, so
  // both kills are refused and the aggregate reports attempted:false.
  const agent = spawnIdleProcess(repo);
  const bridge = spawnIdleProcess(repo);
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  try {
    const job = withPluginData(pluginDataDir, () =>
      seedJob(repo, {
        // Terminal, not running. A RUNNING record whose every image fingerprint matches
        // nothing is legitimately read as abandoned by the reclaim path, and then a bare
        // `stop <id>` reports no active run — measured, twice, before landing here. On a
        // record a first stop already cancelled, r2 keeps it stoppable as long as it
        // carries targets, which is exactly the state this case is about.
        status: "cancelled",
        phase: "cancelled",
        agentPid,
        bridgePid,
        pid: bridgePid,
        killDelivered: false,
        agentImage: "grok-that-this-pid-is-not.exe",
        bridgeImage: "node-that-this-pid-is-not.exe"
      })
    );

    const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
      cwd: repo,
      env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.killAttempted, false, "the point of the case: nothing was signalled");
    assert.equal(payload.killDelivered, false);
    assert.equal(processAlive(agentPid), true, "and both processes are demonstrably still alive");
    assert.equal(processAlive(bridgePid), true);

    const stored = withPluginData(pluginDataDir, () => readStoredJob(repo, job.id));
    assert.equal(
      stored.agentPid,
      agentPid,
      "a refusal is not a kill — dropping the pid here loses the only pointer to a live agent"
    );
    assert.equal(stored.bridgePid, bridgePid, "and the same holds for the bridge target");
  } finally {
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
});

test("a second stop still reaches a CANCELLED record's surviving agent", () => {
  // The case the `failed` test below does not cover, and the one the whole restore machinery
  // was built for: stop clears the targets, kills, finds the kill did not land, and writes
  // the targets back. A later stop then meets a record that is already `cancelled`.
  //
  // That second stop lost the claim in the `cancelled-merge` branch, which is our own write —
  // it had just passed explicit nulls — and the kill source was read from the record that
  // write had emptied. So the second stop aimed at nothing, killed nothing, and left the
  // record with no pids at all; isStoppableJob then stopped offering it, and the agent was
  // permanently out of reach. Every step was individually tested and the chain was not.
  //
  // Found 2026-07-31 by a verification pass over the whole span of related changes at once,
  // after the same reviewer's earlier pass had found the log-path fix incomplete.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const agent = spawnIdleProcess(repo);
  const agentPid = agent.pid;

  try {
    const job = withPluginData(pluginDataDir, () =>
      seedJob(repo, {
        status: "cancelled",
        phase: "cancelled",
        agentPid,
        pid: agentPid,
        killDelivered: false,
        errorMessage: "Stopped by user, but the process could not be confirmed killed."
      })
    );

    const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
      cwd: repo,
      env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.killAttempted, true, "the restored survivor has to be signalled");
    assert.equal(processAlive(agentPid), false, "and actually killed");
  } finally {
    try {
      process.kill(agentPid, "SIGKILL");
    } catch {
    }
  }
});

test("a second stop still reaches a failed record's surviving agent", () => {
  // Stale reclaim marks an abandoned run `failed` and deliberately keeps its pids so a
  // later stop can finish the kill. That stop LOSES the claim — the record is already
  // terminal — so a gate that refuses on a lost claim alone would silently strand exactly
  // the survivor the pids were kept for. The gate asks about targets, not about status.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const agent = spawnIdleProcess(repo);
  const agentPid = agent.pid;

  try {
    const job = withPluginData(pluginDataDir, () =>
      seedJob(repo, {
        status: "failed",
        phase: "failed",
        agentPid,
        pid: agentPid,
        errorMessage: "Reclaimed while its process was still alive."
      })
    );

    const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
      cwd: repo,
      env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.killAttempted, true, "the survivor has to be signalled");
    assert.equal(processAlive(agentPid), false, "and actually killed");
  } finally {
    try {
      process.kill(agentPid, "SIGKILL");
    } catch {
    }
  }
});

test("a lost claim on a record with no targets signals nobody", () => {
  // The other half of the same gate. A run that finished normally has its kill targets
  // cleared, so a stop arriving late has nothing legitimate to signal — and the pre-claim
  // snapshot it is holding describes a run that is over, whose pids the operating system
  // may already have handed to someone else.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const job = withPluginData(pluginDataDir, () =>
    seedJob(repo, {
      status: "failed",
      phase: "failed",
      agentPid: null,
      bridgePid: null,
      pid: null,
      errorMessage: "Run failed."
    })
  );

  const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });

  // No kill targets means the job is not stoppable at all, so stop declines to find it.
  // Either way the contract holds: nothing was signalled.
  if (result.status === 0) {
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.killAttempted, false);
    assert.equal(payload.killDelivered, false);
  } else {
    assert.match(result.stderr, /No active run found/);
  }
});

// ---------------------------------------------------------------------------
// r4 — an abandoned run costs an unknown amount, never zero.
// ---------------------------------------------------------------------------

test("stopping a running job books its spend as unknown, not as zero", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const agent = spawnIdleProcess(repo);
  const agentPid = agent.pid;

  try {
    const job = withPluginData(pluginDataDir, () => seedJob(repo, { agentPid, pid: agentPid }));

    const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
      cwd: repo,
      env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
    });
    assert.equal(result.status, 0, result.stderr);

    const stored = withPluginData(pluginDataDir, () => readStoredJob(repo, job.id));
    assert.equal(stored.status, "cancelled");
    assert.equal(
      stored.usageIncomplete,
      true,
      "the cost envelope never arrives for a killed run; the ledger skips records that " +
        "carry no cost, no usage and no flag, so this is the difference between " +
        "'unknown' and a silent zero"
    );
  } finally {
    try {
      process.kill(agentPid, "SIGKILL");
    } catch {
    }
  }
});

test("stopping a queued job that never started books nothing", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeGrok(binDir);

  const job = withPluginData(pluginDataDir, () =>
    seedJob(repo, { status: "queued", phase: "queued", agentPid: null, pid: null })
  );

  const result = run(process.execPath, [SCRIPT, "stop", job.id, "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });
  assert.equal(result.status, 0, result.stderr);

  const stored = withPluginData(pluginDataDir, () => readStoredJob(repo, job.id));
  assert.equal(stored.status, "cancelled");
  assert.ok(
    !stored.usageIncomplete,
    "no process ever ran, so the spend is an exact zero and must not be muddied"
  );
});

// ---------------------------------------------------------------------------
// r1 — the restore has to survive the second claim.
// ---------------------------------------------------------------------------

test("a restored kill target survives the second cancel claim", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  initGitRepo(repo);

  withPluginData(pluginDataDir, () => {
    const job = seedJob(repo, { agentPid: 7002, bridgePid: 7001, pid: 7001 });

    // 1. stop claims the record and deliberately clears the targets first, so that
    //    nothing else can grab the job while the kill is in flight.
    claimJobTerminal(repo, job.id, "cancelled", {
      errorMessage: "Stopped by user.",
      phase: "cancelled",
      pid: null,
      agentPid: null,
      bridgePid: null
    });

    // 2. the kill did not land, so stop writes the surviving targets back onto the record
    //    (this is what patchStoppedJobKillTargets does).
    const afterClaim = readStoredJob(repo, job.id);
    writeJobFile(repo, job.id, { ...afterClaim, agentPid: 7002, bridgePid: 7001, pid: 7001 });

    // 3. the second claim records the outcome. It passes NO pid keys, and an omitted key
    //    must preserve what is stored. This is the branch that used to null them outright.
    claimJobTerminal(repo, job.id, "cancelled", {
      errorMessage: "Stop claimed but process may still be running (kill not delivered).",
      cancelKill: { attempted: true, delivered: false }
    });

    const stored = readStoredJob(repo, job.id);
    assert.equal(stored.agentPid, 7002, "the agent pid is the only way back to a survivor");
    assert.equal(stored.bridgePid, 7001);

    const indexed = listJobs(repo).find((entry) => entry.id === job.id);
    assert.equal(indexed.agentPid, 7002, "the index has to agree with the file it indexes");
    assert.equal(indexed.bridgePid, 7001);
  });
});

// ---------------------------------------------------------------------------
// r2 — and a cancelled record carrying targets has to be reachable again.
// ---------------------------------------------------------------------------

test("stop can reach a cancelled record that still carries kill targets", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  initGitRepo(repo);

  withPluginData(pluginDataDir, () => {
    const job = seedJob(repo, {
      status: "cancelled",
      phase: "cancelled",
      agentPid: 7002,
      bridgePid: 7001,
      pid: 7001,
      errorMessage: "Stopped by user, but the process could not be confirmed killed."
    });

    // Without this, both the deliberate "keep the pids so a later stop can reach it" in
    // the SessionEnd hook and the restore above were writing to nobody: there was no
    // later stop, because stop declined to see the job at all.
    const resolved = resolveCancelableJob(repo, job.id, { env: {} });
    assert.equal(resolved.job.id, job.id);
    assert.equal(resolved.job.agentPid, 7002);
  });
});

// ---------------------------------------------------------------------------
// r7 — and retention must not throw that record away.
// ---------------------------------------------------------------------------

test("a terminal record with kill targets outlives the retention cap", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  initGitRepo(repo);

  withPluginData(pluginDataDir, () => {
    // Oldest of the lot, so plain newest-50 retention drops it first.
    const survivor = seedJob(repo, {
      status: "cancelled",
      phase: "cancelled",
      agentPid: 7002,
      bridgePid: 7001,
      pid: 7001,
      updatedAt: new Date(Date.parse("2020-01-01T00:00:00.000Z")).toISOString()
    });

    for (let index = 0; index < 60; index += 1) {
      seedJob(repo, {
        status: "completed",
        phase: "done",
        agentPid: null,
        bridgePid: null,
        pid: null,
        updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString()
      });
    }

    const jobs = listJobs(repo);
    assert.ok(
      jobs.some((entry) => entry.id === survivor.id),
      "pruning away the record is pruning away the only pointer to a live agent"
    );
    assert.equal(readStoredJob(repo, survivor.id)?.agentPid, 7002, "and its job file too");
  });
});

test("an ordinary finished run does not squat in the survivor bucket", () => {
  // The completion path writes bridgePid: process.pid onto every terminal record and only
  // clears agentPid and pid. A predicate of "carries any kill target" therefore counted
  // every finished run as a survivor — completed and failed records alike carried exactly
  // that dead bridge pid. The damage is not wasted retention: with
  // a capped bucket, finished runs crowd out the one record that must not be lost.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  initGitRepo(repo);

  withPluginData(pluginDataDir, () => {
    const realSurvivor = seedJob(repo, {
      status: "cancelled",
      phase: "cancelled",
      agentPid: 7002,
      bridgePid: null,
      pid: null,
      updatedAt: new Date(Date.parse("2020-01-01T00:00:00.000Z")).toISOString()
    });

    for (let index = 0; index < 60; index += 1) {
      seedJob(repo, {
        status: "completed",
        phase: "done",
        // Exactly what runTrackedJob leaves behind on a normal, fully accounted run.
        bridgePid: 4000 + index,
        agentPid: null,
        pid: null,
        updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString()
      });
    }

    const jobs = listJobs(repo);
    assert.ok(
      jobs.some((entry) => entry.id === realSurvivor.id),
      "the survivor must not be evicted by sixty finished runs holding a dead bridge pid"
    );
    assert.equal(
      jobs.filter((entry) => entry.status === "completed").length,
      50,
      "and those finished runs stay under the ordinary retention cap"
    );
  });
});

/**
 * The survivor bucket is bounded by liveness, not by age.
 *
 * It used to be bounded by age: keep the newest MAX_JOBS, on the argument that "the oldest
 * pid is least likely to still point anywhere". Likely is not certain, and the record being
 * dropped is by construction the only thing that knows a possibly-live agent's pid — the
 * exact loss the bucket exists to prevent. The cap was really standing in for a question
 * nobody was asking, because at the time nothing swept a dead-but-not-nulled pid.
 *
 * So ask it. When the bucket exceeds the cap, probe: the dead fall through to ordinary
 * retention, the live are kept. Growth is then bounded by the number of agents genuinely
 * still running, which is a real quantity rather than a guess.
 *
 * Driven through the exported pruneJobs with an injected probe. The previous version seeded
 * pids 9000–9069 and went through listJobs, which under this policy is machine-dependent —
 * it failed here because two of those pids were live processes on the machine running it.
 *
 * Replaced 2026-07-31 with the probing policy above. The old assertion was not wrong about what the
 * code did; it was a faithful record of a policy this finding argues against.
 */
test("the survivor bucket keeps the live ones and lets the dead fall through", () => {
  const jobs = [];
  for (let index = 0; index < 70; index += 1) {
    jobs.push({
      id: `run-survivor-${index}`,
      status: "cancelled",
      phase: "cancelled",
      agentPid: 9000 + index,
      bridgePid: null,
      pid: null,
      updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString()
    });
  }

  // Three live agents, scattered so that age alone would have dropped the oldest of them.
  const alive = new Set([9000, 9001, 9035]);
  const kept = pruneJobs(jobs, { isGone: (pid) => !alive.has(pid) });
  const keptIds = new Set(kept.map((entry) => entry.id));

  for (const pid of alive) {
    assert.ok(
      keptIds.has(`run-survivor-${pid - 9000}`),
      `the record naming live agent ${pid} must survive retention — it is the only pointer to it`
    );
  }
  assert.ok(
    keptIds.has("run-survivor-0"),
    "including the oldest, which the age-ordered cap dropped first"
  );
  // 3 live survivors + 50 of the 67 dead ones under the ordinary terminal cap.
  assert.equal(kept.length, 53, "and retention stays bounded");
});

test("a probe that cannot answer leaves the record in the survivor bucket", () => {
  // Unsure is the state the bucket is for. A throwing or false-returning probe must not be
  // read as "gone" — that would turn an unreadable /proc into silent data loss.
  const jobs = [];
  for (let index = 0; index < 70; index += 1) {
    jobs.push({
      id: `run-unknown-${index}`,
      status: "cancelled",
      agentPid: 7000 + index,
      bridgePid: null,
      pid: null,
      updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString()
    });
  }

  const kept = pruneJobs(jobs, {
    isGone: () => {
      throw new Error("cannot read process table");
    }
  });

  // None were provably gone, so none were demoted; the backstop slice then applies.
  assert.equal(kept.length, 50);
  assert.ok(kept.every((entry) => entry.id.startsWith("run-unknown-")));
});
