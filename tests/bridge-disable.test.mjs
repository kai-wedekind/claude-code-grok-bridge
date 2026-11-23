/**
 * A manual kill switch: `disable` must stop `run`, `review`, `critique` and
 * `check --verify-tools` from ever invoking the Grok CLI, and `enable` must restore them.
 *
 * A way to stop the bridge while the weekly allowance is exhausted, so that further runs do
 * not quietly spend credits. The CLI's `~/.grok/logs/unified.jsonl` carries usage fields that
 * look like an automatic signal for this, but that log line is written only when an
 * INTERACTIVE `grok` session starts — never by a headless run, which is every run this bridge
 * makes — so it can be days stale while the allowance is already used up. A gate built on
 * that signal would go silent exactly when it matters. This is the reliable alternative: a
 * flag the user sets, checked before anything spawns.
 *
 * ⚠ EVERY REFUSAL TEST ASSERTS THE ABSENCE OF AN INVOCATION, not only a non-zero exit code.
 * A command can fail non-zero for many reasons; the property that matters here is that the
 * fake Grok binary was never started at all, proven by checking its log file was never
 * written — a run that failed AFTER spawning grok would be a different, lesser bug than a
 * run that spawns grok despite being told not to.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, ...extra });
}

function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  return { repo, binDir, pluginDataDir, fakeGrokLog };
}

function bridge(args, repo, binDir, pluginDataDir, fakeGrokLog) {
  return run(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_LOG: fakeGrokLog })
  });
}

test("disable requires a reason", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const result = bridge(["disable"], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--reason/);
});

test("disable refuses run without ever invoking grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const disabled = bridge(
    ["disable", "--reason", "weekly allowance exhausted"],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /weekly allowance exhausted/);
  // One `grok version` probe can still run, so "starts the CLI" would over-claim what the
  // switch stops.
  assert.match(disabled.stdout, /starts a Grok session/);
  assert.doesNotMatch(disabled.stdout, /starts the CLI/);

  const attempt = bridge(
    ["run", "--prompt-file", writePromptFile(pluginDataDir, "hello")],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.notEqual(attempt.status, 0);
  assert.match(`${attempt.stdout}${attempt.stderr}`, /disabled/i);
  assert.match(`${attempt.stdout}${attempt.stderr}`, /weekly allowance exhausted/);
  assert.equal(fs.existsSync(fakeGrokLog), false, "grok must never have been invoked");
});

function promptLaunches(fakeGrokLog) {
  if (!fs.existsSync(fakeGrokLog)) {
    return 0;
  }
  return fs
    .readFileSync(fakeGrokLog, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.argv.includes("-p") || entry.argv.includes("--prompt-file")).length;
}

test("disable from a shell without CLAUDE_PLUGIN_DATA stops the plugin's runs", () => {
  // The flag does not follow the state root: a disable from a shell without CLAUDE_PLUGIN_DATA
  // must still stop the plugin.
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const shellEnv = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: undefined, GROK_FAKE_LOG: fakeGrokLog });
  const disabled = run(process.execPath, [SCRIPT, "disable", "--reason", "allowance exhausted"], {
    cwd: repo,
    env: shellEnv
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /flag: /, "disable must say where the flag is");

  const attempt = bridge(
    ["run", "--prompt-file", writePromptFile(pluginDataDir, "hello")],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.notEqual(attempt.status, 0);
  assert.match(`${attempt.stdout}${attempt.stderr}`, /allowance exhausted/);
  assert.equal(promptLaunches(fakeGrokLog), 0, "grok must never have been invoked");
});

test("without the override, disable with CLAUDE_PLUGIN_DATA unset still lands in the home directory", () => {
  // Every other home-path test sets CLAUDE_PLUGIN_DATA for both processes, so a flag path
  // that used the home only when that variable was set, and the state root when it was not,
  // would pass them. `disable` here is the unset shell;
  // the following `run` is the plugin. Neither sets GROK_CC_DISABLED_FLAG. TEMP is
  // a temp dir so a fallback state root cannot escape the test.
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const home = makeTempDir();
  const scratchTemp = makeTempDir();
  const expected = path.join(home, ".grok-cc", "disabled.json");
  const shared = {
    GROK_CC_DISABLED_FLAG: undefined,
    USERPROFILE: home,
    HOME: home,
    TEMP: scratchTemp,
    TMP: scratchTemp,
    GROK_FAKE_LOG: fakeGrokLog
  };
  const disabled = run(process.execPath, [SCRIPT, "disable", "--reason", "probe"], {
    cwd: repo,
    env: buildEnv(binDir, { ...shared, CLAUDE_PLUGIN_DATA: undefined })
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.ok(fs.existsSync(expected), `flag expected at ${expected}; stdout: ${disabled.stdout}`);
  assert.ok(disabled.stdout.includes(expected), disabled.stdout);

  const attempt = run(
    process.execPath,
    [SCRIPT, "run", "--prompt-file", writePromptFile(pluginDataDir, "hello")],
    {
      cwd: repo,
      env: buildEnv(binDir, { ...shared, CLAUDE_PLUGIN_DATA: pluginDataDir })
    }
  );
  assert.notEqual(attempt.status, 0);
  assert.match(`${attempt.stdout}${attempt.stderr}`, /probe/);
  assert.equal(promptLaunches(fakeGrokLog), 0, "grok must never have been invoked");
});

test("a batch stops launching as soon as the bridge is disabled mid-run", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const promptsFile = path.join(pluginDataDir, "prompts.ndjson");
  fs.writeFileSync(promptsFile, '"one"\n"two"\n"three"\n');
  run(process.execPath, [SCRIPT, "run", "--prompts-file", promptsFile], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_LOG: fakeGrokLog, GROK_FAKE_DISABLE_DURING_RUN: "1" })
  });
  assert.equal(promptLaunches(fakeGrokLog), 1, "only the prompt that was running when disable happened may launch");
});

test("an empty reply is not nudged once the bridge was disabled during the run", () => {
  // The nudge is a second CLI session. Without this, a run that came back empty after a
  // `disable` would start one anyway.
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  installFakeGrok(binDir, "empty-text");
  const attempt = run(process.execPath, [SCRIPT, "run", "say something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_LOG: fakeGrokLog, GROK_FAKE_DISABLE_DURING_RUN: "1" })
  });
  assert.equal(promptLaunches(fakeGrokLog), 1, "the empty first run may have launched; its nudge must not");
  // A skipped retry is reported as such, not rendered as a plain empty reply.
  assert.match(
    `${attempt.stdout}${attempt.stderr}`,
    /Automatic retry skipped: Grok Build was disabled during the run \(disabled mid-batch\)\./
  );
});

test("the background worker refuses while disabled", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const jobId = "run-disabletest-aaaa";
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const record = {
      id: jobId,
      status: "queued",
      kind: "task",
      kindLabel: "Run",
      title: "Queued before disable",
      jobClass: "task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: { prompt: "hello", cwd: repo }
    };
    writeJobFile(repo, jobId, record);
    upsertJob(repo, { id: jobId, status: "queued", kind: "task", kindLabel: "Run", title: record.title, jobClass: "task" });
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const disabled = bridge(["disable", "--reason", "allowance exhausted"], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.equal(disabled.status, 0, disabled.stderr);

  const worker = bridge(["run-worker", "--cwd", repo, "--job-id", jobId], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.notEqual(worker.status, 0);
  assert.match(`${worker.stdout}${worker.stderr}`, /disabled/i);
  assert.equal(promptLaunches(fakeGrokLog), 0, "grok must never have been invoked");

  // The worker's stdio is ignored in production, so the refusal has to
  // land on the record or the next `runs` calls a queued job "Orphaned".
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const stored = readJobFile(resolveJobFile(repo, jobId));
    assert.equal(stored.status, "failed");
    assert.match(stored.errorMessage ?? "", /Grok Build is disabled/);
    assert.match(stored.errorMessage ?? "", /allowance exhausted/);
    assert.doesNotMatch(stored.errorMessage ?? "", /Orphaned/);
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("disable refuses review and critique without ever invoking grok", () => {
  for (const subcommand of ["review", "critique"]) {
    const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
    bridge(["disable", "--reason", "test"], repo, binDir, pluginDataDir, fakeGrokLog);

    const attempt = bridge([subcommand], repo, binDir, pluginDataDir, fakeGrokLog);
    assert.notEqual(attempt.status, 0, `${subcommand} should be refused while disabled`);
    assert.match(`${attempt.stdout}${attempt.stderr}`, /disabled/i);
    assert.equal(
      fs.existsSync(fakeGrokLog),
      false,
      `grok must never have been invoked for ${subcommand}`
    );
  }
});

test("check --verify-tools reports disabled without invoking grok, and says so in --json", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  bridge(["disable", "--reason", "quota exhausted"], repo, binDir, pluginDataDir, fakeGrokLog);

  const result = bridge(
    ["check", "--verify-tools", "--json"],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );

  // Plain `check` always makes its own cheap `grok --version` / `grok models` probes to
  // report node/grok/auth status — unrelated to this gate and correctly left untouched, so
  // the log is not expected to be empty. What must be absent is the EXPENSIVE probe:
  // verifyDisallowedToolIds starts a real agentic session with `-p`, which those cheap
  // probes never do.
  const billedInvocations = fs.existsSync(fakeGrokLog)
    ? fs
        .readFileSync(fakeGrokLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.argv?.includes("-p"))
    : [];
  assert.deepEqual(
    billedInvocations,
    [],
    "verify-tools must never start the billed tool-probe session while disabled"
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.toolIds.checked, false);
  assert.match(payload.toolIds.error, /disabled/i);
  assert.match(payload.toolIds.error, /quota exhausted/);
  assert.ok(payload.disabled, "the check payload itself must carry the disabled record");
  assert.equal(payload.disabled.reason, "quota exhausted");
});

test("plain check keeps working while disabled, and shows the banner", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  bridge(["disable", "--reason", "budget"], repo, binDir, pluginDataDir, fakeGrokLog);

  const result = bridge(["check"], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.match(result.stdout, /DISABLED/);
  assert.match(result.stdout, /budget/);
  // Plain check's own node/grok/auth probing is unrelated to this gate and untouched by it —
  // only that the banner appears and the report still renders at all.
  assert.match(result.stdout, /Checks:/);
});

test("enable clears the flag and run proceeds normally, actually invoking grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  bridge(["disable", "--reason", "test"], repo, binDir, pluginDataDir, fakeGrokLog);

  const enabled = bridge(["enable"], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.equal(enabled.status, 0, enabled.stderr);

  const afterEnable = bridge(
    ["run", "--prompt-file", writePromptFile(pluginDataDir, "hello again")],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.equal(afterEnable.status, 0, afterEnable.stderr);
  assert.ok(fs.existsSync(fakeGrokLog), "grok should have been invoked once re-enabled");
});

test("enable when nothing was disabled says so without erroring", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const result = bridge(["enable"], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /was not disabled/);
});

function writePromptFile(dir, text) {
  const filePath = path.join(dir, `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(filePath, text);
  return filePath;
}

test("a directory at the flag path is named, not a raw OS error", () => {
  // Unlink and rename onto a directory throw EPERM on Windows; enable and disable must name the
  // path rather than surface that raw text with nothing the user can act on.
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const flagPath = path.join(binDir, "kill-switch", "disabled.json");
  fs.mkdirSync(flagPath, { recursive: true });

  const attempt = bridge(
    ["run", "--prompt-file", writePromptFile(pluginDataDir, "hello")],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.notEqual(attempt.status, 0);
  const refusal = `${attempt.stdout}${attempt.stderr}`;
  assert.match(refusal, /disabled/i);
  assert.match(refusal, /Flag:/);
  assert.ok(refusal.includes(flagPath), refusal);
  assert.equal(promptLaunches(fakeGrokLog), 0);

  const enabled = bridge(["enable"], repo, binDir, pluginDataDir, fakeGrokLog);
  assert.notEqual(enabled.status, 0);
  assert.ok(enabled.stderr.includes(`Cannot remove the kill-switch flag at ${flagPath}`), enabled.stderr);
  assert.match(enabled.stderr, /delete it by hand/);
  assert.match(enabled.stderr, /\([A-Za-z0-9]+\)/);

  const disabled = bridge(
    ["disable", "--reason", "still blocked"],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.notEqual(disabled.status, 0);
  assert.ok(disabled.stderr.includes(`Cannot write the kill-switch flag at ${flagPath}`), disabled.stderr);
  assert.match(disabled.stderr, /delete it by hand/);
});

test("disable names a flag path it cannot write", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const flagPath = path.join(binDir, "kill-switch", "disabled.json");
  fs.mkdirSync(flagPath, { recursive: true });
  const disabled = bridge(
    ["disable", "--reason", "still blocked"],
    repo,
    binDir,
    pluginDataDir,
    fakeGrokLog
  );
  assert.notEqual(disabled.status, 0);
  assert.ok(disabled.stderr.includes(`Cannot write the kill-switch flag at ${flagPath}`), disabled.stderr);
  assert.match(disabled.stderr, /delete it by hand/);
});

test("a relative GROK_CC_DISABLED_FLAG refuses a run instead of resolving it", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const relative = "rel-disabled.json";
  const attempt = run(process.execPath, [SCRIPT, "run", "--prompt-file", writePromptFile(pluginDataDir, "hello")], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_FAKE_LOG: fakeGrokLog,
      GROK_CC_DISABLED_FLAG: relative
    })
  });
  assert.notEqual(attempt.status, 0);
  const text = `${attempt.stdout}${attempt.stderr}`;
  assert.match(text, /GROK_CC_DISABLED_FLAG must be an absolute path/);
  assert.match(text, /rel-disabled\.json/);
  assert.equal(promptLaunches(fakeGrokLog), 0);
  assert.equal(fs.existsSync(path.join(repo, relative)), false);
});

function holdOnlySlot(pluginDataDir) {
  const slotsDir = path.join(pluginDataDir, "state", "global-slots");
  fs.mkdirSync(slotsDir, { recursive: true });
  const slotPath = path.join(slotsDir, "slot-1");
  // A live pid. A dead one is reclaimed at once and the waiter never queues.
  fs.writeFileSync(slotPath, `${process.pid}:held-by-test`, "utf8");
  return { slotsDir, slotPath };
}

async function assertRefusedWhileWaitingForSlot(subcommand, extraArgs) {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const { slotsDir, slotPath } = holdOnlySlot(pluginDataDir);
  const env = pluginDataEnv(pluginDataDir, binDir, {
    GROK_FAKE_LOG: fakeGrokLog,
    GROK_CC_MAX_CONCURRENCY: "1",
    GROK_CC_SLOT_WAIT_MS: "8000"
  });
  const child = spawn(process.execPath, [SCRIPT, subcommand, ...extraArgs], {
    cwd: repo,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  try {
    const needle = "Waiting for a free Grok slot";
    const started = Date.now();
    while (!stderr.includes(needle)) {
      if (child.exitCode != null) {
        throw new Error(`${subcommand} exited ${child.exitCode} before the slot queue line\n${stderr}\n${stdout}`);
      }
      if (Date.now() - started > 10000) {
        throw new Error(`${subcommand} timed out waiting for the slot queue line\n${stderr}\n${stdout}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const flagPath = path.join(binDir, "kill-switch", "disabled.json");
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(
      flagPath,
      JSON.stringify({ reason: "disabled while queued", disabledAt: "2026-10-19T00:00:00.000Z" })
    );
    fs.unlinkSync(slotPath);
    const code = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${subcommand} still running after the slot was freed\n${stderr}\n${stdout}`)),
          10000
        )
      )
    ]);
    assert.notEqual(code, 0, `${subcommand} must refuse`);
    assert.match(`${stdout}${stderr}`, /disabled while queued/);
    assert.equal(promptLaunches(fakeGrokLog), 0, `${subcommand} must not start a Grok session`);
    assert.deepEqual(fs.readdirSync(slotsDir), [], `${subcommand} must release the slot`);
  } finally {
    if (child.exitCode == null) {
      try {
        child.kill();
      } catch {
      }
    }
  }
}

// Slot accounting of a review that does start a session.
// The refusal branch is pinned by the waiting-review test below, which asserts an
// empty slot directory, so the property pinned here is that a review which ran releases the
// slot it acquired, and that it passes the `slot` option down: without it runHeadlessAgent
// queues for a second slot behind the review's own.
function reviewUnderOneSlot() {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();
  const result = run(process.execPath, [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_FAKE_LOG: fakeGrokLog,
      GROK_CC_MAX_CONCURRENCY: "1",
      GROK_CC_SLOT_WAIT_MS: "600"
    }),
    timeout: 60000
  });
  return { result, pluginDataDir, fakeGrokLog };
}

test("a review that ran leaves no concurrency slot held", () => {
  const { result, pluginDataDir, fakeGrokLog } = reviewUnderOneSlot();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(promptLaunches(fakeGrokLog) >= 1, "the review must have started a session");
  const slotsDir = path.join(pluginDataDir, "state", "global-slots");
  assert.ok(fs.existsSync(slotsDir), "the review must have acquired a slot at all");
  assert.deepEqual(fs.readdirSync(slotsDir), [], "the review must release the slot it acquired");
});

test("a review under a bound of one reuses its own slot instead of queueing for a second", () => {
  const { result, fakeGrokLog } = reviewUnderOneSlot();
  const text = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, text);
  assert.ok(promptLaunches(fakeGrokLog) >= 1, "the review must have started a session");
  assert.doesNotMatch(text, /Waiting for a free Grok slot/);
  assert.doesNotMatch(text, /Queue wait exhausted/);
});

test("a run waiting for the only slot refuses once disable lands", async () => {
  const promptDir = makeTempDir();
  await assertRefusedWhileWaitingForSlot("run", ["--prompt-file", writePromptFile(promptDir, "hello")]);
});

test("a review waiting for the only slot refuses once disable lands", async () => {
  await assertRefusedWhileWaitingForSlot("review", []);
});
