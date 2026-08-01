import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateFile,
  saveState,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import {
  appendLogBlock,
  appendLogLine,
  createJobProgressUpdater
} from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { reclaimOrphanedJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { runHeadlessAgent } from "../plugins/grok-build/scripts/lib/grok.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

/**
 * How long the harness waits for a timed-out run to finish and print.
 *
 * Not the thing under test. These tests assert how a wall-clock timeout is *classified*
 * and that partial output is never presented as a finished review — never how fast that
 * happens. `--timeout-ms` is a best-effort deadline: the run path does synchronous work
 * (process-tree kill, state locking, file IO), so on a busy machine it slips. Measured
 * 2026-07-28 under load: a 500ms budget took about 19 seconds end to end,
 * and the old 20s harness limit killed the bridge before it could print — which turns a
 * busy machine into a red acceptance gate and sends whoever sees it after a regression
 * that is not there. Waiting longer costs nothing on an idle machine and weakens no
 * assertion.
 */
const TIMEOUT_HARNESS_MS = 90000;

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

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

function setupReviewableRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");
  return { repo, binDir, pluginDataDir };
}

// ---------------------------------------------------------------------------
// DEFECT 1 — retention cap must never destroy a just-finished result
// ---------------------------------------------------------------------------

test("DEFECT1-retention: finished job survives prune when active count already fills MAX_JOBS", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    // 50 active jobs consume the entire old "total budget". Under the broken
    // terminalBudget = MAX_JOBS - active.length formula that leaves 0 slots for
    // terminal records, so a job that just completed is deleted with its result.
    const jobs = [];
    for (let index = 0; index < 50; index += 1) {
      const jobId = `active-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "running" }, null, 2), "utf8");
      jobs.push({
        id: jobId,
        status: "running",
        logFile,
        updatedAt,
        createdAt: updatedAt
      });
    }

    const finishedId = "just-finished";
    const finishedAt = new Date(Date.UTC(2026, 0, 2, 12, 0, 0)).toISOString();
    const finishedLog = resolveJobLogFile(workspace, finishedId);
    const finishedFile = resolveJobFile(workspace, finishedId);
    fs.writeFileSync(finishedLog, "result of a completed run\n", "utf8");
    fs.writeFileSync(
      finishedFile,
      JSON.stringify(
        {
          id: finishedId,
          status: "completed",
          result: { delivered: true, summary: "valuable result" }
        },
        null,
        2
      ),
      "utf8"
    );
    jobs.push({
      id: finishedId,
      status: "completed",
      logFile: finishedLog,
      updatedAt: finishedAt,
      createdAt: finishedAt,
      summary: "valuable result"
    });

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`,
      "utf8"
    );

    saveState(workspace, { version: 1, config: {}, jobs });

    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const ids = new Set(saved.jobs.map((job) => job.id));

    // Every active record must still be retained (previous-round guarantee).
    for (let index = 0; index < 50; index += 1) {
      assert.equal(ids.has(`active-${index}`), true, `active-${index} must survive`);
      assert.equal(fs.existsSync(resolveJobFile(workspace, `active-${index}`)), true);
    }

    // The just-finished terminal job must also survive — the cap is on finished
    // history independently of active count.
    assert.equal(ids.has(finishedId), true, "just-finished result must not be destroyed at completion");
    assert.equal(fs.existsSync(finishedFile), true, "job file must remain");
    assert.equal(fs.existsSync(finishedLog), true, "log file must remain");
    assert.ok(saved.jobs.length >= 51, "active + terminal may exceed MAX_JOBS");
  });
});

test("DEFECT1-retention: terminal history still capped at MAX_JOBS independently of actives", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    const jobs = [];
    // 3 active + 55 terminal → keep all 3 active + newest 50 terminal.
    for (let index = 0; index < 3; index += 1) {
      const jobId = `run-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(
        resolveJobFile(workspace, jobId),
        JSON.stringify({ id: jobId, status: "running" }, null, 2),
        "utf8"
      );
      jobs.push({ id: jobId, status: "running", logFile, updatedAt, createdAt: updatedAt });
    }
    for (let index = 0; index < 55; index += 1) {
      const jobId = `done-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 2, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(
        resolveJobFile(workspace, jobId),
        JSON.stringify({ id: jobId, status: "completed" }, null, 2),
        "utf8"
      );
      jobs.push({ id: jobId, status: "completed", logFile, updatedAt, createdAt: updatedAt });
    }

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`,
      "utf8"
    );
    saveState(workspace, { version: 1, config: {}, jobs });

    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const active = saved.jobs.filter((j) => j.status === "running");
    const terminal = saved.jobs.filter((j) => j.status === "completed");
    assert.equal(active.length, 3, "all actives retained");
    assert.equal(terminal.length, 50, "terminal history capped at MAX_JOBS");
    assert.equal(saved.jobs.length, 53);
    // Oldest terminal dropped; newest kept.
    assert.equal(
      saved.jobs.some((j) => j.id === "done-0"),
      false,
      "oldest terminal must be pruned"
    );
    assert.equal(saved.jobs.some((j) => j.id === "done-54"), true, "newest terminal kept");
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — secrets scrubbed in logs must also be scrubbed on lastMessage
// ---------------------------------------------------------------------------

test("DEFECT2-secrets: lastMessage is scrubbed like the log, after scrub not before truncate", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-secret-progress";
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789SECRET";
    // Pad so the secret sits past the 240-char preview window: truncating first
    // would leave a short sk-… fragment that may not match the redaction regex.
    // Trailing space keeps a word boundary so scrubSecrets can see the token.
    const padding = `${"progress: "}${"x".repeat(210)} `;
    const message = `${padding}${secret}`;
    assert.ok(message.length > 240, "fixture must exceed lastMessage preview length");

    writeJobFile(workspace, jobId, {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Secret progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    upsertJob(workspace, {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Secret progress"
    });

    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, "", "utf8");
    appendLogLine(logFile, message);

    const updater = createJobProgressUpdater(workspace, jobId);
    updater({ message });

    const logText = fs.readFileSync(logFile, "utf8");
    assert.match(logText, /sk-\[REDACTED\]/);
    assert.doesNotMatch(logText, /sk-abcdefghijklmnopqrstuvwxyz/);

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
    assert.ok(stored.lastMessage, "progress must write lastMessage");
    assert.match(
      stored.lastMessage,
      /sk-\[REDACTED\]/,
      "lastMessage must be scrubbed the same way as the log"
    );
    assert.doesNotMatch(
      stored.lastMessage,
      /sk-abcdefghijklmnopqrstuvwxyz|SECRET/,
      "raw API key must not appear on the job record"
    );
    // Truncation after scrub: the redacted token must be intact, not a half-cut sk-.
    assert.doesNotMatch(stored.lastMessage, /sk-[A-Za-z0-9]{1,7}(\.\.\.)?$/);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — progress durable writes must be fail-open
// ---------------------------------------------------------------------------

test("DEFECT3-failopen: appendLogLine / appendLogBlock swallow unwritable log errors", () => {
  const dir = makeTempDir();
  // appendFileSync on a directory path throws EISDIR / EACCES — durable write failure.
  const notAFile = path.join(dir, "blocked-log");
  fs.mkdirSync(notAFile);

  assert.doesNotThrow(() => appendLogLine(notAFile, "line that cannot be written"));
  assert.doesNotThrow(() => appendLogBlock(notAFile, "Title", "body that cannot be written"));
});

test("DEFECT3-failopen: createJobProgressUpdater does not throw when job patch write fails", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-progress-failopen";
    writeJobFile(workspace, jobId, {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    upsertJob(workspace, { id: jobId, status: "running", phase: "running", title: "Progress" });

    const updater = createJobProgressUpdater(workspace, jobId);
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function failingWrite(...args) {
      const target = String(args[0] ?? "");
      if (target.includes(jobId) || target.includes("state.json")) {
        const err = new Error("simulated EIO on progress path");
        err.code = "EIO";
        throw err;
      }
      return originalWrite.apply(this, args);
    };

    try {
      assert.doesNotThrow(() => updater({ message: "still running", phase: "running" }));
    } finally {
      fs.writeFileSync = originalWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// DEFECT 4 — stderr capture must share the stdout cap (diagnostic clip, not fail)
// ---------------------------------------------------------------------------

test("DEFECT4-stderr-cap: over-cap stderr is clipped without failing a successful run", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "huge-stderr");
  const cwd = makeTempDir();
  const env = buildEnv(binDir, {
    GROK_CC_STDOUT_CAP_BYTES: "256",
    GROK_FAKE_STDERR_BYTES: "20000"
  });

  const result = await runHeadlessAgent(cwd, {
    prompt: "emit stderr",
    env,
    globalSlot: false,
    // No newline flood: fixture emits one giant chunk without newlines so the
    // line assembler is forced to bound stderrLineBuf as well as the string.
    timeoutMs: 15000
  });

  assert.equal(result.status, 0, "stderr overflow must not fail the run");
  assert.ok(result.stderr.length < 5000, `stderr must be bounded, got ${result.stderr.length}`);
  assert.match(result.stderr, /clip|truncat/i, "clipped stderr must note that it was cut");
  // Cap is 256; allow the clip note after the retained prefix.
  assert.ok(
    result.stderr.length <= 256 + 200,
    `retained stderr body must respect the shared cap (got ${result.stderr.length})`
  );
});

// ---------------------------------------------------------------------------
// DEFECT 5 — live PID alone must not pin a job forever (age + image backstop)
// ---------------------------------------------------------------------------

test("DEFECT5-reclaim: live PID with fresh updatedAt keeps the job active", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const now = new Date().toISOString();
    const job = {
      id: "job-live-fresh",
      status: "running",
      phase: "running",
      bridgePid: process.pid,
      createdAt: now,
      updatedAt: now
    };
    const kept = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false
    });
    assert.equal(kept.status, "running", "fresh live job must not be reclaimed");
  });
});

test("DEFECT5-reclaim: live PID with stale updatedAt is reclaimed (recycled-PID backstop)", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    // Well past any normal progress/heartbeat silence; PID still "resolves".
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const job = {
      id: "job-live-stale",
      status: "running",
      phase: "running",
      bridgePid: 424242,
      createdAt: old,
      updatedAt: old
    };
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false,
      terminateImpl: () => ({ attempted: true, delivered: true, method: "test" })
    });
    assert.equal(reclaimed.status, "failed", "stale record with live PID must be reclaimed");
    // Abandoned-while-alive (not "process gone"): keep targets, distinct wording.
    assert.match(reclaimed.errorMessage || "", /abandon|stale|may still be running/i);
    assert.equal(reclaimed.bridgePid, 424242, "kill targets retained so stop still works");
  });
});

test("DEFECT5-reclaim: image fingerprint mismatch treats live PID as not ours", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const now = new Date().toISOString();
    const job = {
      id: "job-image-mismatch",
      status: "running",
      phase: "running",
      agentPid: 999001,
      agentImage: "node.exe",
      createdAt: now,
      updatedAt: now
    };
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false,
      readImageImpl: () => "chrome.exe"
    });
    assert.equal(
      reclaimed.status,
      "failed",
      "mismatched process image means the PID was recycled — reclaim"
    );
    assert.match(reclaimed.errorMessage || "", /Orphaned/i);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 6 — failed critique must not present a completed structured review
// ---------------------------------------------------------------------------

test("DEFECT6-critique: cli-error does not leave payload.result as a finished review", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();
  installFakeGrok(binDir, "json-then-fail");

  const result = run(process.execPath, [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "cli-error");
  assert.equal(
    payload.result,
    null,
    "structured result must not be presented as a completed review after cli-error"
  );
  // Partial content remains available, but not under result.
  assert.ok(
    payload.rawOutput || payload.grok?.stdout,
    "partial content should still be available to the caller"
  );
  assert.doesNotMatch(
    result.stdout,
    /No material findings\.|Verdict:\s*approve/i,
    "rendered / payload path must not read as a successful critique"
  );
});

test("DEFECT6-critique: timeout does not leave payload.result as a finished review", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();
  installFakeGrok(binDir, "json-then-hang");

  const result = run(
    process.execPath,
    [SCRIPT, "critique", "--json", "--timeout-ms", "500"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir),
      timeout: TIMEOUT_HARNESS_MS
    }
  );

  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "timeout");
  assert.equal(
    payload.result,
    null,
    "structured result must not be presented as a completed review after timeout"
  );
  assert.doesNotMatch(result.stdout, /No material findings\.|Verdict:\s*approve/i);
});

test("DEFECT6-critique: plain review timeout frames partial stdout as failure, not success", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();
  installFakeGrok(binDir, "text-then-hang");

  const result = run(
    process.execPath,
    [SCRIPT, "review", "--json", "--timeout-ms", "500"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir),
      timeout: TIMEOUT_HARNESS_MS
    }
  );

  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "timeout");
  // Plain path has no structured result field; rendered text must still frame failure.
  const rendered = String(result.stdout);
  assert.match(rendered, /timeout|fail|did not succeed|Partial output/i);
});
