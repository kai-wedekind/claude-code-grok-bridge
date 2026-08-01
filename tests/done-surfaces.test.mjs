import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import {
  buildStatusSnapshot,
  filterJobsForSession
} from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { renderTaskResult } from "../plugins/grok-build/scripts/lib/render.mjs";
import {
  cleanTerminalJobs,
  listJobs,
  listNamedThreads,
  setNamedThread,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { createJobProgressUpdater } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { runHeadlessAgent } from "../plugins/grok-build/scripts/lib/grok.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

/**
 * Harness patience for the timeout test below — not the thing under test. `--timeout-ms`
 * is a best-effort deadline, and on a busy machine it slips well past its budget; the old
 * 20s limit killed the bridge before it could print and made the gate red for reasons
 * that had nothing to do with the code. See the same constant in confirmed-defects.
 */
const TIMEOUT_HARNESS_MS = 90000;
const HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

function seedJob(workspace, id, sessionId, status, extra = {}) {
  const job = {
    id,
    sessionId,
    status,
    jobClass: "task",
    title: `job ${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: extra.updatedAt ?? new Date().toISOString(),
    logFile: null,
    ...extra
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
  return job;
}

// --- SURFACE-01: multi-session observability ---

test("SURFACE-01: runs is session-scoped; --all-sessions lists every session", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    seedJob(workspace, "job-a1", "session-A", "completed", { summary: "from A" });
    seedJob(workspace, "job-b1", "session-B", "completed", { summary: "from B" });
    seedJob(workspace, "job-a2", "session-A", "running", { summary: "live A" });

    const scoped = buildStatusSnapshot(workspace, { sessionId: "session-A" });
    assert.equal(scoped.allSessions, false);
    assert.equal(scoped.currentSessionId, "session-A");
    assert.equal(scoped.running.length, 1);
    assert.equal(scoped.running[0].id, "job-a2");
    assert.equal(scoped.latestFinished?.id, "job-a1");

    const all = buildStatusSnapshot(workspace, { sessionId: "session-A", allSessions: true });
    assert.equal(all.allSessions, true);
    const allIds = new Set([
      ...all.running.map((j) => j.id),
      all.latestFinished?.id,
      ...all.recent.map((j) => j.id)
    ].filter(Boolean));
    assert.equal(allIds.has("job-b1"), true, "other session jobs must appear with --all-sessions");
    assert.equal(allIds.has("job-a1"), true);
    assert.equal(allIds.has("job-a2"), true);

    // Explicit id resolution is already cross-session (not filtered).
    const filtered = filterJobsForSession(listJobs(workspace), { sessionId: "session-A" });
    assert.equal(filtered.every((j) => j.sessionId === "session-A"), true);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("SURFACE-01: bridge runs --all-sessions surfaces foreign session jobs", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    seedJob(workspace, "job-other", "session-other", "completed", { summary: "other session work" });
    seedJob(workspace, "job-mine", "session-mine", "completed", { summary: "mine" });

    const scoped = run(process.execPath, [SCRIPT, "runs", "--json", "--cwd", workspace], {
      env: pluginDataEnv(pluginDataDir, binDir, { GROK_CC_SESSION_ID: "session-mine" })
    });
    assert.equal(scoped.status, 0, scoped.stderr);
    const scopedPayload = JSON.parse(scoped.stdout);
    assert.equal(scopedPayload.latestFinished?.id, "job-mine");

    const all = run(process.execPath, [SCRIPT, "runs", "--json", "--all-sessions", "--cwd", workspace], {
      env: pluginDataEnv(pluginDataDir, binDir, { GROK_CC_SESSION_ID: "session-mine" })
    });
    assert.equal(all.status, 0, all.stderr);
    const allPayload = JSON.parse(all.stdout);
    assert.equal(allPayload.allSessions, true);
    const ids = [
      allPayload.latestFinished?.id,
      ...(allPayload.recent ?? []).map((j) => j.id),
      ...(allPayload.running ?? []).map((j) => j.id)
    ];
    assert.ok(ids.includes("job-other"), `expected job-other in ${JSON.stringify(ids)}`);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

// --- SURFACE-02: wall-clock timeout + max-turns wiring ---

test("SURFACE-02: --timeout-ms kills a hanging agent and claims failed with timeout", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "hang");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const env = pluginDataEnv(pluginDataDir, binDir);

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", workspace, "--timeout-ms", "400", "hang please"],
    { env, timeout: TIMEOUT_HARNESS_MS }
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "timeout");
  assert.equal(payload.timedOut, true);
  assert.match(payload.failureMessage || "", /timeout/i);
});

test("SURFACE-02: --max-turns is forwarded on the headless argv", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", workspace, "--max-turns", "3", "brief task"],
    { env }
  );
  assert.equal(result.status, 0, result.stderr);
  const lastArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop());
  const idx = lastArgv.indexOf("--max-turns");
  assert.notEqual(idx, -1, `expected --max-turns in ${lastArgv.join(" ")}`);
  assert.equal(lastArgv[idx + 1], "3");
});

// --- SURFACE-03: progress / usage ---

test("SURFACE-03: progress updater patches lastMessage; usage footer renders", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    seedJob(workspace, "job-progress", "session-A", "running");
    const update = createJobProgressUpdater(workspace, "job-progress");
    update({ message: "searching: auth module", phase: "investigating" });
    const jobs = listJobs(workspace);
    const job = jobs.find((entry) => entry.id === "job-progress");
    assert.equal(job.lastMessage, "searching: auth module");
    assert.equal(job.phase, "investigating");

    const rendered = renderTaskResult(
      {
        rawOutput: "answer text",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      },
      {}
    );
    assert.match(rendered, /Usage: input 10, output 5, total 15/);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("SURFACE-03: stderr progress lines are forwarded via onProgress", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "stderr-progress");
  const messages = [];
  const result = await runHeadlessAgent(makeTempDir(), {
    prompt: "go",
    env: buildEnv(binDir),
    binary: path.join(binDir, "grok-fake.mjs"),
    globalSlot: false,
    heartbeatMs: 60_000,
    onProgress: (event) => {
      const message = typeof event === "string" ? event : event?.message;
      if (message) {
        messages.push(message);
      }
    }
  });
  assert.equal(result.status, 0);
  assert.ok(
    messages.some((line) => /searching: auth module/i.test(line)),
    `expected stderr progress in ${JSON.stringify(messages)}`
  );
});

// --- SURFACE-04: threads / check / wait exit / SessionEnd timeout ---

test("SURFACE-04: threads list and --forget", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    setNamedThread(workspace, "alpha", "session-alpha");
    setNamedThread(workspace, "beta", "session-beta");

    const listed = run(process.execPath, [SCRIPT, "threads", "--json", "--cwd", workspace], {
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    assert.equal(payload.threads.length, 2);
    assert.ok(payload.threads.some((t) => t.name === "alpha" && t.sessionId === "session-alpha"));

    const forgot = run(
      process.execPath,
      [SCRIPT, "threads", "--forget", "alpha", "--json", "--cwd", workspace],
      { env: pluginDataEnv(pluginDataDir, binDir) }
    );
    assert.equal(forgot.status, 0, forgot.stderr);
    assert.equal(JSON.parse(forgot.stdout).deleted, true);
    assert.equal(listNamedThreads(workspace).alpha, undefined);
    assert.equal(listNamedThreads(workspace).beta.sessionId, "session-beta");

    const missing = run(
      process.execPath,
      [SCRIPT, "threads", "--forget", "missing", "--json", "--cwd", workspace],
      { env: pluginDataEnv(pluginDataDir, binDir) }
    );
    assert.equal(missing.status, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("SURFACE-04: check reports state root and concurrency", () => {
  const pluginDataDir = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const result = run(process.execPath, [SCRIPT, "check", "--json"], {
    env: pluginDataEnv(pluginDataDir, binDir, { GROK_CC_MAX_CONCURRENCY: "4", GROK_CC_SLOT_WAIT_MS: "12000" })
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.bridge?.stateRoot);
  assert.equal(report.bridge.maxConcurrency, 4);
  assert.equal(report.bridge.slotWaitMs, 12000);
  assert.ok(Array.isArray(report.envHints) && report.envHints.length > 0);
});

test("SURFACE-04: runs --wait times out with exit 3", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    seedJob(workspace, "job-live", "session-A", "running");
    const result = run(
      process.execPath,
      [
        SCRIPT,
        "runs",
        "job-live",
        "--wait",
        "--timeout-ms",
        "200",
        "--poll-interval-ms",
        "50",
        "--json",
        "--cwd",
        workspace
      ],
      { env: pluginDataEnv(pluginDataDir, binDir, { GROK_CC_SESSION_ID: "session-A" }) }
    );
    assert.equal(result.status, 3, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.waitTimedOut, true);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("SURFACE-04: SessionEnd hook timeout is raised above 5s", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const sessionEnd = hooks.hooks.SessionEnd[0].hooks[0];
  assert.ok(sessionEnd.timeout >= 30, `expected SessionEnd timeout >= 30, got ${sessionEnd.timeout}`);
});

// --- SURFACE-05: clean / import --thread / show exit / prompts-file ---

test("SURFACE-05: clean --keep retains newest terminal jobs only", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    seedJob(workspace, "old-1", "s", "completed", { updatedAt: "2020-01-01T00:00:00.000Z" });
    seedJob(workspace, "old-2", "s", "failed", { updatedAt: "2020-01-02T00:00:00.000Z" });
    seedJob(workspace, "new-1", "s", "completed", { updatedAt: "2026-01-01T00:00:00.000Z" });
    seedJob(workspace, "live", "s", "running", { updatedAt: "2026-01-02T00:00:00.000Z" });

    const result = cleanTerminalJobs(workspace, { keep: 1 });
    assert.ok(result.removed.includes("old-1"));
    assert.ok(result.removed.includes("old-2"));
    assert.equal(result.removed.includes("new-1"), false);
    assert.equal(result.removed.includes("live"), false);
    const remaining = new Set(listJobs(workspace).map((j) => j.id));
    assert.equal(remaining.has("live"), true);
    assert.equal(remaining.has("new-1"), true);
    assert.equal(remaining.has("old-1"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("SURFACE-05: import --thread registers the imported session", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir, "import-ok");
  // Import only accepts transcripts under ~/.claude/projects.
  const projectsDir = path.join(os.homedir(), ".claude", "projects", `gbp-done-test-${Date.now()}`);
  fs.mkdirSync(projectsDir, { recursive: true });
  const transcript = path.join(projectsDir, "session.jsonl");
  fs.writeFileSync(transcript, "{}\n", "utf8");
  // Parent must use the same state root as the bridge child, or listNamedThreads
  // reads a different directory and the registry looks empty.
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const result = run(
      process.execPath,
      [SCRIPT, "import", "--source", transcript, "--thread", "imported", "--json", "--cwd", workspace],
      { env: pluginDataEnv(pluginDataDir, binDir) }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.threadRegistered, true);
    assert.equal(payload.thread, "imported");
    assert.equal(listNamedThreads(workspace).imported.sessionId, payload.threadId);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    try {
      fs.rmSync(projectsDir, { recursive: true, force: true });
    } catch {
    }
  }
});

test("SURFACE-05: show exits with stored status; --wait timeout is 3", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const failed = {
      id: "job-failed",
      sessionId: "session-A",
      status: "failed",
      jobClass: "task",
      title: "failed run",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: { status: 2, rawOutput: "", failureCode: "no-deliverable" },
      rendered: "failed\n"
    };
    writeJobFile(workspace, failed.id, failed);
    upsertJob(workspace, failed);

    const showFailed = run(process.execPath, [SCRIPT, "show", "job-failed", "--cwd", workspace], {
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(showFailed.status, 2, showFailed.stderr);

    seedJob(workspace, "job-wait", "session-A", "running");
    const wait = run(
      process.execPath,
      [
        SCRIPT,
        "show",
        "job-wait",
        "--wait",
        "--timeout-ms",
        "150",
        "--poll-interval-ms",
        "40",
        "--json",
        "--cwd",
        workspace
      ],
      { env: pluginDataEnv(pluginDataDir, binDir) }
    );
    assert.equal(wait.status, 3, wait.stderr + wait.stdout);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("SURFACE-05: run --prompts-file emits sequential NDJSON results", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const promptsFile = path.join(makeTempDir(), "prompts.ndjson");
  fs.writeFileSync(promptsFile, `${JSON.stringify("first prompt")}\n${JSON.stringify({ prompt: "second prompt" })}\n`, "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--cwd", workspace, "--prompts-file", promptsFile],
    { env: pluginDataEnv(pluginDataDir, binDir) }
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].index, 0);
  assert.equal(lines[1].index, 1);
  assert.equal(lines[0].exitStatus, 0);
  assert.equal(lines[1].exitStatus, 0);
  assert.ok(lines[0].jobId);
  assert.ok(lines[1].jobId);
  assert.notEqual(lines[0].jobId, lines[1].jobId);
});

// --- SURFACE-06: SessionStart env dual-format ---

test("SURFACE-06: SessionStart writes export and plain KEY=VALUE lines", () => {
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const result = run(process.execPath, [HOOK, "SessionStart"], {
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: makeTempDir()
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-123",
      transcript_path: "C:\\\\tmp\\\\transcript.jsonl"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const body = fs.readFileSync(envFile, "utf8");
  // Two forms, and the point is that they are DIFFERENT forms. The shell line is quoted so
  // a value with a space survives `source`; the plain line is not, because a plain
  // `KEY=value` parser has no quoting convention and would take the quotes as part of the
  // value. This test used to assert the quoted spelling on both lines, which is exactly the
  // bug it was written to catch: the "plain" form was never emitted, and the assertion
  // certified its absence.
  assert.match(body, /export GROK_CC_SESSION_ID='sess-123'/);
  assert.match(body, /^GROK_CC_SESSION_ID=sess-123$/m);
  assert.doesNotMatch(body, /^GROK_CC_SESSION_ID='/m, "the plain line must not be quoted");
  assert.match(body, /export GROK_CC_TRANSCRIPT_PATH=/);
  assert.match(body, /^GROK_CC_TRANSCRIPT_PATH=/m);
});
