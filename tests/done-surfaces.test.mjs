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

test("SURFACE-05: the removed import subcommand is rejected, not silently accepted", () => {
  // `import` was removed in 0.3.3. The Grok CLI has had no such subcommand since 0.2.118 —
  // the real argv exits 2 with "unexpected argument" — and nothing succeeded it: `sessions`
  // offers list, search and delete, while `--resume` resumes Grok's own sessions rather than
  // ingesting a Claude transcript.
  //
  // The test that stood here drove the whole command end to end and passed throughout, because
  // tests/fake-grok-fixture.mjs implements `argv[0] === "import"` and returns a session id. The
  // fixture implemented more than the thing it stood in for, so the suite kept certifying a
  // command that could not work against any CLI a user had.
  //
  // What replaces it asserts the removal rather than the feature: an unknown subcommand must
  // be refused with a non-zero exit. Deleting the old test instead would have left nothing to
  // notice if the dispatch arm came back in a merge.
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir, "import-ok");

  const result = run(
    process.execPath,
    [SCRIPT, "import", "--json", "--cwd", workspace],
    { env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.notEqual(result.status, 0, "a removed subcommand must not exit 0");
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unknown subcommand/i,
    "the failure must name the cause rather than being an empty non-zero"
  );
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
  // GROK_CC_TRANSCRIPT_PATH was asserted here until 0.3.3. It is gone: nothing ever read it
  // after `/grok-build:import` was removed, and every variable costs two lines in a file whose
  // growth is what broke the Bash tool. Asserting its ABSENCE, so it cannot drift back in.
  assert.doesNotMatch(body, /GROK_CC_TRANSCRIPT_PATH/, "the dead transcript variable must stay gone");

  // ⚠ ORDER. Both forms are written, a shell runs both, and the LAST assignment wins — so the
  // unquoted line must come FIRST or it overwrites the escaped one. This is not style: with the
  // old order a Windows path lost every backslash, measured live in a real session.
  // Anchored at line starts, not by searching for a leading newline: the bare line is now the
  // FIRST thing in the block, so at the top of a fresh file it has no newline before it.
  const plainAt = body.search(/^GROK_CC_SESSION_ID=/m);
  const exportAt = body.search(/^export GROK_CC_SESSION_ID=/m);
  assert.ok(plainAt !== -1 && exportAt !== -1, "both forms must be present");
  assert.ok(
    plainAt < exportAt,
    "the bare line must precede the export line, or a shell ends up with the unescaped value"
  );
});

test("SURFACE-05b: a backslash path survives the env file through a real shell", (t) => {
  // The guard that actually matters, and the one the shape assertions above cannot give: run
  // the file the way the consumer does and compare the VALUE, not the spelling.
  //
  // ⚠ WHERE THERE IS NO USABLE SHELL THIS MUST SKIP, AND `return` IS NOT A SKIP. It was one
  // until 2026-08-09: the comment said "skipped rather than failed" while the body printed a
  // line and returned — which node:test counts as a PASS. So on a host without bash this
  // reported success for a round-trip it had never performed, and the green summary said
  // nothing. Found by a vacuity audit.
  //
  // ⚠ And existence is the wrong question, the same trap as `env-file-shell-safety.test.mjs`:
  // a shell can exist and still be unable to resolve `C:/...`, which is exactly what the WSL
  // alias does on Windows. Ask it to do the job on a real temp path and check that it did.
  const probeDir = makeTempDir();
  const probeFile = path.join(probeDir, "probe-env");
  fs.writeFileSync(probeFile, "export SHELL_PROBE='canary-42'\n", "utf8");
  const shell = ["/bin/bash", "/usr/bin/bash", "C:\\Program Files\\Git\\bin\\bash.exe"].find((p) => {
    if (!fs.existsSync(p)) return false;
    const probe = run(p, ["-c", `source '${probeFile.replace(/\\/g, "/")}'; printf '[%s]' "$SHELL_PROBE"`]);
    return (probe.stdout || "").includes("[canary-42]");
  });
  if (!shell) {
    t.skip("no shell here can source a file at a native temp path — value round-trip not exercised");
    return;
  }

  const dir = makeTempDir();
  const envFile = path.join(dir, "env");
  fs.writeFileSync(envFile, "");
  const pluginData = "C:\\Users\\test\\AppData\\Local\\Temp\\state";

  const result = run(process.execPath, [HOOK, "SessionStart"], {
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-456",
      transcript_path: "C:\\tmp\\t.jsonl"
    })
  });
  assert.equal(result.status, 0, result.stderr);

  const script = path.join(dir, "probe.sh");
  fs.writeFileSync(
    script,
    `. "$1"\nprintf '%s' "$CLAUDE_PLUGIN_DATA"\n`.replace(/\r\n/g, "\n"),
    "utf8"
  );
  const probe = run(shell, [script, envFile]);
  assert.equal(
    probe.stdout,
    pluginData,
    `a shell sourcing the env file must see the path unchanged; got "${probe.stdout}"`
  );
});

test("SURFACE-06: repeated SessionStart does not grow the env file", () => {
  // ⚠ This is the defect that killed the Bash tool in six sessions on one machine.
  //
  // SessionStart fires on every start, resume and compaction, and the hook used to APPEND.
  // Claude Code inlines the whole of CLAUDE_ENV_FILE into the `bash -c` argument of every
  // Bash tool call, and MSYS2 bash silently truncates that argument past 8186 characters —
  // no error, everything after the cut simply gone. So the file grew about 531 bytes per
  // event until the user's command was severed and bash blamed a parse error on whatever
  // line the cut landed in. Measured 2026-08-06: one session held 57 copies of each
  // variable, 15 KiB, and had been unable to run a single Bash command for days.
  //
  // The error names bash, never this plugin, so no user would ever have reported it. That
  // is why this asserts a BOUND rather than the presence of a line: presence was already
  // green while the file was ten times too big.
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginData = makeTempDir();

  function fire(sessionId) {
    return run(process.execPath, [HOOK, "SessionStart"], {
      env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData },
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
        transcript_path: "C:\\\\tmp\\\\transcript.jsonl"
      })
    });
  }

  assert.equal(fire("sess-1").status, 0);
  const afterFirst = fs.readFileSync(envFile, "utf8");

  for (let i = 0; i < 8; i += 1) {
    assert.equal(fire("sess-1").status, 0);
  }
  const afterMany = fs.readFileSync(envFile, "utf8");

  assert.equal(
    afterMany.length,
    afterFirst.length,
    `nine identical SessionStart events must not grow the file; grew ${afterFirst.length} -> ${afterMany.length}`
  );
  for (const name of ["GROK_CC_SESSION_ID", "CLAUDE_PLUGIN_DATA"]) {
    const hits = afterMany.split("\n").filter((l) => l.trim().startsWith(`export ${name}=`));
    assert.equal(hits.length, 1, `${name} must appear exactly once, found ${hits.length}`);
  }

  // A changed value replaces rather than accumulates, and stays a single pair.
  assert.equal(fire("sess-2").status, 0);
  const afterChange = fs.readFileSync(envFile, "utf8");
  assert.match(afterChange, /GROK_CC_SESSION_ID=.?sess-2/);
  assert.doesNotMatch(afterChange, /sess-1/, "the superseded value must be gone, not appended past");

  // The whole point: it must stay far below the shell's argument limit.
  assert.ok(
    afterChange.length < 2000,
    `env file must stay small; MSYS2 bash truncates a -c argument past 8186 chars. Got ${afterChange.length}`
  );
});

test("SURFACE-06: another hook's lines survive, blank lines included", () => {
  // ⚠ THIS TEST ASSERTS ON CONTENT WE DO NOT OWN, and that is the entire point.
  //
  // The rewrite that fixed unbounded growth dropped every blank line in the file, not just
  // the empty final element its own split had created. CLAUDE_ENV_FILE is SHARED — any hook
  // may write to it — so that quietly reformatted other people's content on every
  // SessionStart, of which there is one per start, resume and compaction.
  //
  // It survived review and shipped into a public pull request because every existing
  // assertion here reads back the variables this hook writes. A test that only inspects what
  // you own is structurally blind to what you damage, however carefully it is written.
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const foreign =
    "# another hook was here\n" +
    "export OTHER_HOOK_A=1\n" +
    "\n" +
    "# the blank line above separates two groups and belongs to whoever wrote it\n" +
    "export OTHER_HOOK_B=2\n";
  fs.writeFileSync(envFile, foreign, "utf8");
  const pluginData = makeTempDir();

  function fire(sessionId) {
    return run(process.execPath, [HOOK, "SessionStart"], {
      env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData },
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
        transcript_path: "C:\\\\tmp\\\\transcript.jsonl"
      })
    });
  }

  assert.equal(fire("sess-a").status, 0);
  const after = fs.readFileSync(envFile, "utf8");

  // Every foreign line, in order, byte for byte — including the blank one.
  for (const line of foreign.split("\n").filter((l) => l !== "")) {
    assert.ok(after.includes(line), `foreign line was lost: ${JSON.stringify(line)}`);
  }
  assert.match(
    after,
    /export OTHER_HOOK_A=1\n\n# the blank line above/,
    "the blank line between the two foreign groups must survive verbatim"
  );

  // And the growth fix must still hold with foreign content present: repeated events must
  // not accumulate. Fixing the blank-line damage by reverting to append would trade one
  // defect for the worse one.
  const afterFirst = fs.readFileSync(envFile, "utf8");
  for (let i = 0; i < 5; i += 1) {
    assert.equal(fire("sess-a").status, 0);
  }
  const afterMany = fs.readFileSync(envFile, "utf8");
  assert.equal(
    afterMany.length,
    afterFirst.length,
    `repeated events must not grow a file containing foreign lines; ${afterFirst.length} -> ${afterMany.length}`
  );
});

test("SURFACE-06: an unreadable env file aborts instead of overwriting", () => {
  // Rewriting instead of appending introduced a destructive path the old code could not
  // reach: read fails -> `existing` is empty -> the whole file is overwritten with one
  // variable. handleSessionStart runs three such cycles in a row, so a transient failure on
  // the second would erase what the first had just written. Only ENOENT may be read as
  // empty; anything else must leave the file alone.
  //
  // A directory in place of the file produces a non-ENOENT read error (EISDIR/EPERM) without
  // needing permission games that behave differently on Windows and POSIX.
  const dirAsFile = makeTempDir();
  const result = run(process.execPath, [HOOK, "SessionStart"], {
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: dirAsFile,
      CLAUDE_PLUGIN_DATA: makeTempDir()
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-unreadable",
      transcript_path: "C:\\\\tmp\\\\transcript.jsonl"
    })
  });

  // A SessionStart hook that throws is worse than one that writes nothing: it fires on every
  // start, resume and compaction, so a crash here is a crash the user meets constantly.
  assert.equal(result.status, 0, `hook must survive an unreadable env file: ${result.stderr}`);
  assert.ok(fs.statSync(dirAsFile).isDirectory(), "the target must be left untouched");
});
