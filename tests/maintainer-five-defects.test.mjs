import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import {
  buildStatusSnapshot,
  reclaimOrphanedJob,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { runHeadlessAgent } from "../plugins/grok-build/scripts/lib/grok.mjs";
import { sanitizeChildEnv } from "../plugins/grok-build/scripts/lib/process.mjs";

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
// DEFECT 1 — stale reclaim must not leave a live agent unstoppable
// ---------------------------------------------------------------------------

test("DEFECT1-abandon: stale live PID is reclaimed with kill targets retained", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const jobId = "job-stale-live-agent";
    const agentPid = 424201;
    const bridgePid = 424202;
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Stale live",
      agentPid,
      bridgePid,
      pid: bridgePid,
      createdAt: old,
      updatedAt: old
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    const terminated = [];
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false,
      terminateImpl: (pid) => {
        terminated.push(pid);
        return { attempted: true, delivered: true, method: "test" };
      }
    });

    assert.equal(reclaimed.status, "failed", "stale live record must leave active list");
    assert.ok(
      terminated.includes(agentPid) || terminated.includes(bridgePid),
      "must best-effort terminate tracked processes while reclaiming"
    );
    // Distinct from the genuine-orphan wording ("no longer running").
    assert.match(
      reclaimed.errorMessage || "",
      /abandon|stale|may still be running/i,
      "error must distinguish abandoned-while-alive from process-died"
    );
    assert.doesNotMatch(
      reclaimed.errorMessage || "",
      /no longer running/i,
      "must not claim the process is gone when it may still be alive"
    );

    // Kill targets must remain so a later stop can still aim at them.
    assert.equal(reclaimed.agentPid, agentPid, "agentPid must not be nulled on abandon reclaim");
    assert.equal(reclaimed.bridgePid, bridgePid, "bridgePid must not be nulled on abandon reclaim");

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.agentPid, agentPid);
    assert.equal(stored.bridgePid, bridgePid);

    // stop must still resolve this job (failed-but-killable).
    const cancelable = resolveCancelableJob(workspace, jobId);
    assert.equal(cancelable.job.id, jobId);
    assert.ok(
      Number(cancelable.job.agentPid) === agentPid ||
        Number(cancelable.job.bridgePid) === bridgePid,
      "cancelable record must still expose kill targets"
    );
  });
});

test("DEFECT1-abandon: genuinely gone PIDs still null kill targets (backstop preserved)", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-truly-gone";
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      agentPid: 1,
      bridgePid: 2,
      pid: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    const terminated = [];
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => true,
      terminateImpl: (pid) => {
        terminated.push(pid);
        return { attempted: true, delivered: false, method: "test" };
      }
    });

    assert.equal(reclaimed.status, "failed");
    assert.match(reclaimed.errorMessage || "", /Orphaned|no longer running/i);
    assert.equal(terminated.length, 0, "no terminate attempt when targets are already gone");
    assert.equal(reclaimed.agentPid ?? null, null);
    assert.equal(reclaimed.bridgePid ?? null, null);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — agent process must inherit sanitized env only
// ---------------------------------------------------------------------------

test("DEFECT2-env: the filter keeps Windows system variables in either casing", () => {
  // Which casing arrives depends on the launcher: a native Windows parent gives
  // "SystemRoot"/"windir", MSYS/Git Bash gives "SYSTEMROOT"/"WINDIR". Dropping them
  // breaks native code in ways that look nothing like an env problem — missing
  // SystemRoot takes out TLS and DNS.
  for (const [systemRoot, windir, comSpec, pathKey] of [
    ["SystemRoot", "windir", "ComSpec", "Path"],
    ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH"]
  ]) {
    const filtered = sanitizeChildEnv({
      [systemRoot]: "C:\\Windows",
      [windir]: "C:\\Windows",
      [comSpec]: "C:\\Windows\\system32\\cmd.exe",
      [pathKey]: "C:\\bin",
      SystemDrive: "C:",
      AWS_SECRET_ACCESS_KEY: "must-not-survive"
    });

    for (const key of [systemRoot, windir, comSpec, pathKey, "SystemDrive"]) {
      assert.ok(key in filtered, `${key} must survive the filter`);
    }
    assert.equal("AWS_SECRET_ACCESS_KEY" in filtered, false, "secrets must still be dropped");
  }
});

test("DEFECT2-env: runHeadlessAgent passes sanitizeChildEnv to the spawned agent", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const cwd = makeTempDir();
  const secretValue = "should-not-reach-agent-process";
  const env = buildEnv(binDir, {
    AWS_SECRET_ACCESS_KEY: secretValue,
    RANDOM_LEAK_TOKEN: secretValue,
    // Preserved keys the agent genuinely needs (credentials / config / path).
    XAI_API_KEY: "xai-test-key",
    GROK_BINARY: path.join(binDir, "grok-fake.mjs")
  });

  // Capture the env object handed to spawn by patching child_process.spawn via
  // a wrapper binary that dumps process.env keys (GROK_FAKE already logs argv).
  // Instead: assert via a custom spawn by checking sanitizeChildEnv contract on
  // the same input, then confirm the agent path applies it by using a fixture
  // that echoes a marker env var only when present.
  const sanitized = sanitizeChildEnv(env);
  assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(sanitized.RANDOM_LEAK_TOKEN, undefined);
  assert.equal(sanitized.XAI_API_KEY, "xai-test-key");
  assert.ok(sanitized.PATH || sanitized.Path, "PATH must survive for the CLI binary");

  // Instrument: spawn a node -e child is not available; use FAKE that writes env
  // snapshot when GROK_FAKE_ENV_DUMP is set (GROK_ prefix is allowlisted).
  const dumpPath = path.join(makeTempDir(), "env-dump.json");
  const dumpEnv = {
    ...env,
    GROK_FAKE_ENV_DUMP: dumpPath
  };

  // Patch the fake grok to dump env when GROK_FAKE_ENV_DUMP is set — install a
  // one-shot dump binary instead so we do not depend on fixture changes for the
  // failure-before-fix observation.
  const dumpBinary = path.join(binDir, "grok-env-dump.mjs");
  fs.writeFileSync(
    dumpBinary,
    `import fs from "node:fs";
const dump = process.env.GROK_FAKE_ENV_DUMP;
if (dump) {
  fs.writeFileSync(dump, JSON.stringify(process.env), "utf8");
}
process.stdout.write(JSON.stringify({
  text: "ok",
  sessionId: "11111111-2222-4333-8444-555555555555",
  stopReason: "end_turn",
  num_turns: 1
}) + "\\n");
process.exit(0);
`,
    "utf8"
  );

  await runHeadlessAgent(cwd, {
    prompt: "env check",
    env: {
      ...dumpEnv,
      GROK_BINARY: dumpBinary
    },
    globalSlot: false,
    outputFormat: "json"
  });

  assert.equal(fs.existsSync(dumpPath), true, "agent must have run and written the env dump");
  const childEnv = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  assert.equal(
    childEnv.AWS_SECRET_ACCESS_KEY,
    undefined,
    "unrelated secrets must not reach the agent process"
  );
  assert.equal(
    childEnv.RANDOM_LEAK_TOKEN,
    undefined,
    "non-allowlisted tokens must not reach the agent process"
  );
  assert.equal(childEnv.XAI_API_KEY, "xai-test-key", "XAI_ credentials must be preserved");
  assert.ok(childEnv.PATH || childEnv.Path, "PATH must be preserved so the CLI can run");
});

// ---------------------------------------------------------------------------
// DEFECT 3 — one corrupt job file must not take down the whole workspace
// ---------------------------------------------------------------------------

test("DEFECT3-corrupt: damaged job file does not break runs listing of other jobs", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const goodId = "job-good";
    const badId = "job-corrupt";
    const now = new Date().toISOString();

    writeJobFile(workspace, goodId, {
      id: goodId,
      status: "completed",
      phase: "done",
      title: "Good",
      createdAt: now,
      updatedAt: now,
      result: { delivered: true }
    });
    upsertJob(workspace, {
      id: goodId,
      status: "completed",
      phase: "done",
      title: "Good"
    });

    // Index knows about the bad job; on-disk file is truncated garbage.
    upsertJob(workspace, {
      id: badId,
      status: "running",
      phase: "running",
      title: "Broken"
    });
    const badFile = resolveJobFile(workspace, badId);
    fs.writeFileSync(badFile, "{not-json truncated", "utf8");

    // Walking jobs (as runs/check/reclaim do) must not throw.
    let snapshot;
    assert.doesNotThrow(() => {
      snapshot = buildStatusSnapshot(workspace);
    }, "one corrupt job must not throw out of status/runs");

    const listed = listJobs(workspace);
    assert.ok(
      listed.some((j) => j.id === goodId),
      "healthy jobs must still be visible"
    );

    const damaged = listed.find((j) => j.id === badId);
    assert.ok(damaged, "damaged job must surface, not silently vanish");
    assert.equal(
      damaged.damaged === true || /damag/i.test(damaged.errorMessage || damaged.phase || ""),
      true,
      "damage must be visible on the record"
    );

    // Direct reader must also degrade rather than throw.
    assert.doesNotThrow(() => readJobFile(badFile));
    const direct = readJobFile(badFile);
    assert.equal(direct.damaged, true);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 4 — job file wins when index lags after a partial terminal claim
// ---------------------------------------------------------------------------

test("DEFECT4-index-heal: completed job file is reachable even when index still says running", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-file-ahead";
    const completedAt = new Date().toISOString();
    const resultPayload = {
      delivered: true,
      summary: "finished work",
      rawOutput: "the real answer"
    };

    // Simulate crash between writeJobFile and index update inside claimJobTerminal:
    // job file is terminal with full result; index still running.
    writeJobFile(workspace, jobId, {
      id: jobId,
      status: "completed",
      phase: "done",
      title: "Ahead of index",
      completedAt,
      updatedAt: completedAt,
      result: resultPayload,
      rendered: "the real answer\n"
    });
    upsertJob(workspace, {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Ahead of index"
    });

    // Index alone still says running.
    const indexOnly = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
    assert.equal(indexOnly.jobs.find((j) => j.id === jobId).status, "running");

    // Read path must prefer the durable job file so show can return the result.
    const { job } = resolveResultJob(workspace, jobId);
    assert.equal(job.status, "completed", "read path must prefer job-file status over index");
    assert.equal(job.result?.summary, "finished work");

    // Index should heal from the job file.
    const healed = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
    assert.equal(
      healed.jobs.find((j) => j.id === jobId).status,
      "completed",
      "index must heal from the durable job file"
    );
  });
});

// ---------------------------------------------------------------------------
// DEFECT 5 — temp prompt hand-over file cleaned on termination signals
// ---------------------------------------------------------------------------

test("DEFECT5-prompt-signal: temporary prompt file is removed on SIGTERM", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "hang");
  const cwd = makeTempDir();

  // Capture SIGTERM/SIGINT handlers registered by runHeadlessAgent, and prevent
  // re-raise from killing the test process. This exercises the same cleanup path
  // a real termination signal would hit.
  const handlers = new Map();
  const originalOn = process.on.bind(process);
  const originalRemoveListener = process.removeListener.bind(process);
  const originalKill = process.kill.bind(process);
  process.on = (event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  };
  process.removeListener = (event, listener) => {
    if ((event === "SIGTERM" || event === "SIGINT") && handlers.get(event) === listener) {
      handlers.delete(event);
      return process;
    }
    return originalRemoveListener(event, listener);
  };
  process.kill = (pid, signal) => {
    if (pid === process.pid && (signal === "SIGTERM" || signal === "SIGINT")) {
      return true;
    }
    return originalKill(pid, signal);
  };

  let promptPath = null;
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWrite(filePath, data, options) {
    const asString = String(filePath);
    if (asString.includes("grok-cc-prompt-")) {
      promptPath = asString;
    }
    return originalWriteFileSync.call(this, filePath, data, options);
  };

  try {
    const runPromise = runHeadlessAgent(cwd, {
      prompt: "P".repeat(4500),
      env: buildEnv(binDir),
      globalSlot: false,
      // Short wall-clock so the hang fixture cannot pin the test process.
      timeoutMs: 2500
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (!promptPath || !handlers.has("SIGTERM"))) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(promptPath, "expected a temporary grok-cc-prompt-* hand-over file");
    assert.equal(fs.existsSync(promptPath), true, "prompt file must exist before signal");
    assert.equal(handlers.has("SIGTERM"), true, "SIGTERM cleanup handler must be registered");

    // Invoke the same handler Node would call on signal delivery.
    handlers.get("SIGTERM")("SIGTERM");

    assert.equal(
      fs.existsSync(promptPath),
      false,
      "temporary prompt hand-over file must be deleted on termination signal"
    );

    // Drain the hang run (timeout kills the child).
    try {
      await runPromise;
    } catch {
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    process.on = originalOn;
    process.removeListener = originalRemoveListener;
    process.kill = originalKill;
  }
});

test("DEFECT5-prompt-signal: caller-supplied --prompt-file is not deleted on cleanup", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const cwd = makeTempDir();
  const ownedByCaller = path.join(makeTempDir(), "caller-prompt.txt");
  fs.writeFileSync(ownedByCaller, "caller owned prompt body", "utf8");

  await runHeadlessAgent(cwd, {
    prompt: "short",
    promptFile: ownedByCaller,
    env: buildEnv(binDir),
    globalSlot: false
  });

  assert.equal(
    fs.existsSync(ownedByCaller),
    true,
    "bridge must not delete a caller-supplied prompt file"
  );
});
