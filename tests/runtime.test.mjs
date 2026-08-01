// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { READ_ONLY_DISALLOWED_TOOLS } from "../plugins/grok-build/scripts/grok-bridge.mjs";
import {
  acquireThreadLock,
  generateJobId,
  listJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

function collectArgvFlagValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && index + 1 < argv.length) {
      values.push(argv[index + 1]);
    }
  }
  return values;
}

function countHeadlessArgvLines(argvLogPath) {
  if (!fs.existsSync(argvLogPath)) {
    return 0;
  }
  return fs
    .readFileSync(argvLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((argv) => argv.includes("-p") || argv.includes("--prompt-file")).length;
}

test("read-only runs carry the write barrier, write runs do not", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  const readOnly = run(process.execPath, [SCRIPT, "run", "--cwd", workspace, "inspect this"], { env });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const readOnlyArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop());
  const readOnlyJoined = readOnlyArgv.join(" ");
  // The barrier that makes a "read-only" run actually read-only on every platform: the
  // writing tools are removed and denied. --sandbox alone is not enforced on Windows.
  const disallowedIdx = readOnlyArgv.indexOf("--disallowed-tools");
  assert.notEqual(disallowedIdx, -1);
  // Compared against the constant itself, not a copy of it: this assertion exists to
  // prove the barrier reaches the command line, and restating the list here would only
  // prove that two literals match.
  assert.equal(readOnlyArgv[disallowedIdx + 1], READ_ONLY_DISALLOWED_TOOLS.join(","));
  assert.ok(
    readOnlyArgv[disallowedIdx + 1].includes("use_tool"),
    "the MCP meta-tools have to be among them, or the deny rule stands alone"
  );
  assert.deepEqual(
    collectArgvFlagValues(readOnlyArgv, "--deny").sort(),
    ["Bash", "Edit", "MCPTool", "Write"].sort(),
    "read-only deny list must match the full contract set"
  );
  assert.match(readOnlyJoined, /--sandbox read-only/);
  assert.match(readOnlyJoined, /--no-plan/);

  fs.writeFileSync(argvLog, "", "utf8");
  const writeRun = run(process.execPath, [SCRIPT, "run", "--write", "--cwd", workspace, "change this"], { env });
  assert.equal(writeRun.status, 0, writeRun.stderr);
  const writeArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop()).join(" ");
  assert.doesNotMatch(writeArgv, /--disallowed-tools/);
  assert.doesNotMatch(writeArgv, /--deny /);
  assert.match(writeArgv, /--always-approve/);
});

test("empty read-only deliverable nudges once then exits 2 with no-deliverable", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "empty-text");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  const result = run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, "empty please"], {
    env
  });

  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, false);
  assert.equal(payload.failureCode, "no-deliverable");
  assert.equal(payload.nudged, true);
  assert.equal(payload.status, 2);
  assert.equal(countHeadlessArgvLines(argvLog), 2, "read-only empty must run once then nudge");
});

test("empty-then-ok read-only nudges once, delivers, and exits 0", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "empty-then-ok");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, {
    GROK_FAKE_ARGV_LOG: argvLog,
    // One machine-wide slot across run+nudge: if the bridge re-acquired under the
    // same held slot, maxSlots=1 would force a long wait/overflow.
    GROK_CC_MAX_CONCURRENCY: "1"
  });

  const result = run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, "retry please"], {
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, true);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.nudged, true);
  assert.match(payload.rawOutput, /Recovered after empty first turn/);
  assert.equal(countHeadlessArgvLines(argvLog), 2);
});

test("empty --write run does not nudge and exits 2 with no-deliverable", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "empty-text");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--write", "--json", "--cwd", workspace, "mutate empty"],
    { env }
  );

  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, false);
  assert.equal(payload.failureCode, "no-deliverable");
  assert.equal(payload.nudged, false);
  assert.equal(countHeadlessArgvLines(argvLog), 1, "write empty must not auto-retry");
});

test("fail-print maps to exit 2 with failureCode cli-error", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "fail-print");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const env = pluginDataEnv(pluginDataDir, binDir);

  const result = run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, "will fail"], {
    env
  });

  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, false);
  assert.equal(payload.failureCode, "cli-error");
  assert.equal(payload.nudged, false);
});

test("json-schema without a JSON object fails with schema-parse and exit 2", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "non-json");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const env = pluginDataEnv(pluginDataDir, binDir);
  const schema = JSON.stringify({ type: "object", properties: { verdict: { type: "string" } } });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--json-schema", schema, "--cwd", workspace, "structured please"],
    { env }
  );

  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, false);
  assert.equal(payload.failureCode, "schema-parse");
  assert.match(payload.failureMessage, /JSON object|--json-schema/i);
});

test("--thread registers, resumes, and rejects a busy lock", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  const first = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--thread", "alpha", "--cwd", workspace, "first turn"],
    { env }
  );
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.delivered, true);
  assert.equal(firstPayload.thread, "alpha");
  assert.equal(firstPayload.threadRegistered, true);
  assert.ok(firstPayload.threadId);

  fs.writeFileSync(argvLog, "", "utf8");
  const second = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--thread", "alpha", "--cwd", workspace, "second turn"],
    { env }
  );
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.threadRegistered, true);
  assert.equal(secondPayload.threadId, firstPayload.threadId);
  const resumeArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop());
  assert.ok(resumeArgv.includes("-r"), "continuation must resume the registered session");
  assert.equal(resumeArgv[resumeArgv.indexOf("-r") + 1], firstPayload.threadId);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    // Plant a live lock so the next bridge run sees "busy".
    const lock = acquireThreadLock(workspace, "alpha");
    assert.ok(lock);
    try {
      const busy = run(
        process.execPath,
        [SCRIPT, "run", "--json", "--thread", "alpha", "--cwd", workspace, "should block"],
        { env }
      );
      assert.notEqual(busy.status, 0, busy.stdout);
      assert.match(`${busy.stdout}\n${busy.stderr}`, /already in use/i);
    } finally {
      lock.release();
    }
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("check reports ready when fake grok is installed and authenticated", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.equal(payload.reviewGateEnabled, undefined);
});

test("check reports not ready when models probe fails", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.length > 0);
});

test("check ignores legacy review-gate flags as unknown options", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--enable-review-gate", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.reviewGateEnabled, undefined);
  assert.match(result.stderr, /ignoring unknown option/);
});

test("review renders a no-findings style result from fake grok", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes|No material issues found/i);
  assert.match(result.stdout, /Grok Build Review|Target:/);
});

test("critique returns structured findings payload path", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run("node", [SCRIPT, "critique", "--json", "focus on docs"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Critique");
  assert.equal(payload.result?.verdict, "approve");
  assert.ok(Array.isArray(payload.result?.findings));
});

function setupReviewableRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeGrokLog };
}

function lastFakeGrokArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  // Long prompts are handed over as a file instead of on the command line, so a
  // headless run is identified by either form.
  const printRun = [...lines]
    .reverse()
    .find((entry) => entry.argv?.includes("-p") || entry.argv?.includes("--prompt-file"));
  assert.ok(printRun, "expected a headless grok invocation (-p or --prompt-file)");
  return printRun.argv;
}

test("review forwards --model and --effort to grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "review", "--model", "grok-build", "--effort", "high"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_LOG: fakeGrokLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "grok-build");
  assert.ok(argv.includes("--effort"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("critique forwards --model and --effort to grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "critique", "--model", "grok-build", "--effort", "medium", "focus on race conditions"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_LOG: fakeGrokLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "grok-build");
  assert.ok(argv.includes("--effort"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "medium");
});

test("review rejects unsupported --effort values", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();

  for (const effort of ["extreme", "xhigh", "max"]) {
    const result = run("node", [SCRIPT, "review", "--effort", effort], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, `expected rejection for --effort ${effort}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported reasoning effort/i);
  }
});

test("run delegates through fake grok and stores a finished job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("runs and show surface the latest finished run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const task = run("node", [SCRIPT, "run", "--json", "do a small thing"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const status = run("node", [SCRIPT, "runs", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished);
  assert.equal(statusPayload.latestFinished.status, "completed");
  assert.equal(statusPayload.needsReview, undefined);

  const result = run("node", [SCRIPT, "show"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task|Grok session ID|Run:/);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  if (process.platform === "win32") {
    // kill(0) success means the pid still resolves. Confirm via tasklist — there is
    // no portable `ps` on Windows, and an empty `ps` result would false-dead every pid.
    const listing = run("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    const out = `${listing.stdout ?? ""}\n${listing.stderr ?? ""}`;
    if (/no tasks/i.test(out)) {
      return false;
    }
    return out.includes(String(pid));
  }
  // Zombies still accept kill(0); treat them as not running.
  const ps = run("ps", ["-p", String(pid), "-o", "stat="]);
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  if (!stat || stat.includes("Z")) {
    return false;
  }
  return true;
}

test("stop terminates a tracked sleeper process and marks run cancelled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const agent = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  agent.unref();
  const bridge = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  bridge.unref();
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const jobsDir = path.join(resolveStateDir(repo), "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const logFile = path.join(jobsDir, `${jobId}.log`);
    fs.writeFileSync(logFile, "", "utf8");
    const job = {
      id: jobId,
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "fake running",
      status: "running",
      phase: "running",
      bridgePid,
      pid: bridgePid,
      agentPid,
      logFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);

    const result = run("node", [SCRIPT, "stop", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.killDelivered, true);
    assert.ok(payload.killTargets?.includes(agentPid));
    assert.ok(payload.killTargets?.includes(bridgePid));

    const jobs = listJobs(repo);
    const cancelled = jobs.find((entry) => entry.id === jobId);
    assert.equal(cancelled?.status, "cancelled");

    // Both process trees must actually be dead.
    assert.equal(processAlive(agentPid), false);
    assert.equal(processAlive(bridgePid), false);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }
});

test("enqueueBackgroundJob writes the job file before spawning the worker", async () => {
  const { enqueueBackgroundJob } = await import("../plugins/grok-build/scripts/grok-bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const events = [];
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "bg order",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(cwd, jobId) {
          events.push("spawn");
          const stored = readStoredJobFromDisk(repo, jobId);
          events.push(stored ? "job-present-at-spawn" : "job-missing-at-spawn");
          assert.ok(stored, "job file must exist before worker spawn");
          assert.equal(stored.status, "queued");
          assert.equal(stored.pid, null);
          return { pid: 424242 };
        }
      }
    );

    assert.deepEqual(events, ["spawn", "job-present-at-spawn"]);
    assert.equal(result.payload.status, "queued");
    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);
    const jobs = listJobs(repo);
    assert.equal(jobs[0].pid, 424242);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

function readStoredJobFromDisk(workspaceRoot, jobId) {
  const jobFile = path.join(resolveStateDir(workspaceRoot), "jobs", `${jobId}.json`);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

test("import uses grok import and prints resume hint", () => {
  const home = makeTempDir();
  const projects = path.join(home, ".claude", "projects", "demo");
  fs.mkdirSync(projects, { recursive: true });
  const sessionPath = path.join(projects, "sess-transfer.jsonl");
  fs.writeFileSync(sessionPath, '{"type":"user","text":"hi"}\n', "utf8");

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "import", "--source", sessionPath, "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      HOME: home,
      USERPROFILE: home
    })
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, "11111111-2222-4333-8444-555555555555");
  assert.equal(payload.resumeCommand, "grok -r 11111111-2222-4333-8444-555555555555");
});

test("run-resume-candidate reports available after a completed run with thread id", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const sessionId = "claude-session-1";
  const task = run("node", [SCRIPT, "run", "first task"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(task.status, 0, task.stderr);

  const candidate = run("node", [SCRIPT, "run-resume-candidate", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.threadId);
});

test("output-truncated: over-cap capture is delivered=false, exit 2, failureCode output-truncated", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "huge-output");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  // Cap well below the fixture's emission so truncation is guaranteed.
  const env = pluginDataEnv(pluginDataDir, binDir, {
    GROK_CC_STDOUT_CAP_BYTES: "64",
    GROK_FAKE_HUGE_BYTES: "4096"
  });

  const result = run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, "emit huge"], {
    env
  });

  assert.equal(result.status, 2, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, false);
  assert.equal(payload.failureCode, "output-truncated");
  assert.match(payload.failureMessage ?? "", /truncat/i);
  assert.match(result.stdout, /truncat|did not succeed|capture limit/i);
});

test("structuredOutput-only envelope is a deliverable (no false-fail, no needless nudge)", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "structured-output-only");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const schema = JSON.stringify({
    type: "object",
    required: ["verdict", "summary", "findings", "next_steps"],
    properties: {
      verdict: { type: "string" },
      summary: { type: "string" },
      findings: { type: "array" },
      next_steps: { type: "array" }
    }
  });
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--json-schema", schema, "--cwd", workspace, "structured only"],
    { env }
  );

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, true);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.nudged, false);
  assert.equal(payload.structured?.verdict, "approve");
  assert.match(payload.rawOutput ?? "", /Structured-only deliverable/);
  assert.equal(countHeadlessArgvLines(argvLog), 1, "SO-only must not auto-nudge");
});

test("nudge merge keeps first structuredOutput when retry returns none", () => {
  const binDir = makeTempDir();
  // First turn: empty text + SO. Resume: empty everything.
  // If hasDeliverable stops counting SO, a nudge would fire; the merge must still keep SO.
  installFakeGrok(binDir, "structured-then-empty-nudge");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const schema = JSON.stringify({
    type: "object",
    required: ["verdict", "summary", "findings", "next_steps"],
    properties: {
      verdict: { type: "string" },
      summary: { type: "string" },
      findings: { type: "array" },
      next_steps: { type: "array" }
    }
  });
  const env = pluginDataEnv(pluginDataDir, binDir);

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--json-schema", schema, "--cwd", workspace, "keep first SO"],
    { env }
  );

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivered, true);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.structured?.verdict, "approve");
  assert.match(
    payload.structured?.summary ?? "",
    /First structuredOutput must survive empty nudge/
  );
});

function setupReviewableRepoForGate() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir };
}

test("review empty output: exit 2, no-deliverable, rendered text does not claim success", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "empty-text");

  const result = run(process.execPath, [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 2, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "no-deliverable");
  // Non-JSON path also prints rendered text on stdout when not --json; with --json the
  // payload carries failureMessage. Render must never read as a completed review.
  assert.match(payload.failureMessage ?? "", /no output/i);
  assert.doesNotMatch(result.stdout, /completed without any stdout|No material issues found/i);
});

test("review empty output (plain): rendered text states the failure", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "empty-text");

  const result = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stdout, /no output|did not succeed|failed/i);
  assert.doesNotMatch(result.stdout, /completed without any stdout output/i);
});

test("show replays a failed review's exit class instead of a generic failure", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "empty-text");
  const env = pluginDataEnv(pluginDataDir, binDir);

  const review = run(process.execPath, [SCRIPT, "review", "--json"], { cwd: repo, env });
  assert.equal(review.status, 2, review.stderr + review.stdout);

  // The stored record has to carry the bridge's own exit class, not just the CLI's,
  // or a caller replaying the run through show cannot tell 2 (no deliverable) from
  // 1 (something else went wrong).
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  let jobId;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length > 0, "the review must have been recorded");
    jobId = jobs[0].id;
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  const shown = run(process.execPath, [SCRIPT, "show", jobId], { cwd: repo, env });
  assert.equal(shown.status, 2, `show must replay exit 2, got ${shown.status}`);
});

test("review over-cap output: exit 2, output-truncated, not reported as a finished review", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "huge-output");

  const result = run(process.execPath, [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_STDOUT_CAP_BYTES: "64",
      GROK_FAKE_HUGE_BYTES: "4096"
    })
  });

  // Truncated plain output is non-empty, so without an explicit gate this path used to
  // report a partial review as a complete one.
  assert.equal(result.status, 2, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "output-truncated");
  assert.match(payload.failureMessage ?? "", /truncat|capture limit/i);
});

test("critique over-cap output: output-truncated, never blamed on the model as schema-parse", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "huge-output");

  const result = run(process.execPath, [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_STDOUT_CAP_BYTES: "64",
      GROK_FAKE_HUGE_BYTES: "4096"
    })
  });

  assert.equal(result.status, 2, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "output-truncated");
  assert.equal(payload.result, null);
});

test("critique invalid shape: exit 2, schema-parse, rendered does not claim success", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "invalid-review-shape");

  const result = run(process.execPath, [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 2, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "schema-parse");
  assert.equal(payload.result, null);
  assert.match(payload.failureMessage ?? payload.parseError ?? "", /findings|shape|schema|Missing/i);
  assert.doesNotMatch(result.stdout, /"verdict"\s*:\s*"approve"/);
  // Rendered path (when stored) / parse messaging must not look like a successful critique.
  assert.doesNotMatch(`${payload.failureMessage}\n${result.stdout}`, /No material findings\./);
});

test("critique structuredOutput-only: exit 0 and result populated from SO", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "structured-output-only");

  const result = run(process.execPath, [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.result?.verdict, "approve");
  assert.equal(payload.result?.summary, "Structured-only deliverable.");
  assert.ok(Array.isArray(payload.result?.findings));
});

test("critique empty output: exit 2, no-deliverable", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepoForGate();
  installFakeGrok(binDir, "empty-text");

  const result = run(process.execPath, [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 2, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "no-deliverable");
  assert.equal(payload.result, null);
  assert.match(payload.failureMessage ?? "", /no output/i);
});

test("isPlausibleSchemaObject rejects envelopes and incomplete objects; accepts valid schema objects", async () => {
  const { isPlausibleSchemaObject } = await import("../plugins/grok-build/scripts/lib/grok.mjs");
  const schema = {
    type: "object",
    required: ["verdict", "summary", "findings", "next_steps"]
  };

  assert.equal(
    isPlausibleSchemaObject(
      {
        text: "",
        stopReason: "EndTurn",
        sessionId: "s1",
        num_turns: 1,
        usage: { total_tokens: 1 },
        structuredOutput: { verdict: "approve" }
      },
      schema
    ),
    false,
    "CLI envelope must be rejected"
  );

  assert.equal(
    isPlausibleSchemaObject({ verdict: "approve", summary: "ok" }, schema),
    false,
    "object missing required keys must be rejected"
  );

  assert.equal(
    isPlausibleSchemaObject(
      {
        verdict: "approve",
        summary: "ok",
        findings: [],
        next_steps: []
      },
      schema
    ),
    true,
    "valid schema object must be accepted"
  );
});
