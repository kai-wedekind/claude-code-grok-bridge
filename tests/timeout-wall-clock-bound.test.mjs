import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { runCommand, terminateProcessTree } from "../plugins/grok-build/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

// Measured on 2026-07-28 while chasing an intermittent acceptance failure: a run given a
// 500ms wall-clock budget overshot past 22 seconds and produced no output at all — the
// caller got an empty stdout and a killed process. The cause was not the kill being slow
// as such. terminateProcessTree shells out to `taskkill /T` through spawnSync, which
// blocks the event loop for its entire duration, and it is called from inside the timeout
// handler. So the handler's own force-settle timer, the thing meant to guarantee the
// deadline, could not fire either. The safety net was behind the hazard.
const WALL_CLOCK_BUDGET_MS = 500;
// What is actually guaranteed: the run ends and says why, rather than hanging forever.
// NOT that it ends near its budget — measured 2026-07-28 under load, a
// 500ms budget took about 19 seconds, most of it before the agent was even spawned. The
// deadline is best-effort because the run path does synchronous work. Asserting a tight
// bound here would encode a promise the design does not make, and would go red whenever
// the machine is busy. The bound below only has to be far enough below "forever".
const MUST_NOT_HANG_MS = 90000;

test("a wall-clock timeout ends the run and reports why, instead of hanging", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "hang");
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() });

  const startedAt = Date.now();
  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--timeout-ms", String(WALL_CLOCK_BUDGET_MS), "--cwd", makeTempDir(), "hang forever"],
    { env, timeout: MUST_NOT_HANG_MS }
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(
    result.stdout.trim().length > 0,
    `the run must report something; empty stdout means the harness killed it first (${elapsed}ms)`
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "timeout");
  assert.equal(payload.delivered, false);
  assert.ok(elapsed < MUST_NOT_HANG_MS, `took ${elapsed}ms — the fake agent never exits on its own`);
});

// The bound itself: runCommand must hand spawnSync a timeout when asked, or nothing
// downstream can limit how long the loop is held.
test("runCommand passes a bound down to spawnSync", () => {
  let seen = null;
  runCommand("taskkill", ["/PID", "1"], {
    timeoutMs: 1234,
    spawnSyncImpl: (command, args, options) => {
      seen = options;
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(seen.timeout, 1234, "an unbounded spawnSync is what blocked the loop");
  assert.equal(seen.killSignal, "SIGKILL", "a bound that can itself be ignored is no bound");
});

test("runCommand stays unbounded when no bound is asked for", () => {
  let seen = null;
  runCommand("whoami", [], {
    spawnSyncImpl: (command, args, options) => {
      seen = options;
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(seen.timeout, undefined, "ordinary callers must not inherit a surprise deadline");
});

// When the tree walk is cut off, the caller must learn that only the known pid was
// reached. Found by a review pass over the bound added earlier the same day: the
// first version returned delivered:true here. `stop` restores a job's kill targets only
// when delivered is false (`patchStoppedJobKillTargets` in grok-bridge.mjs — named rather
// than cited by line, which drifts), so claiming delivery wiped the pids from
// the record while descendants of a half-walked tree were still alive — unreachable from
// then on, with the log reading "Stopped by user".
test("a tree kill that is cut off is not reported as delivered", () => {
  const killed = [];
  const outcome = terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync taskkill ETIMEDOUT"), { code: "ETIMEDOUT" })
    }),
    killImpl: (pid, signal) => {
      killed.push([pid, signal]);
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(
    outcome.delivered,
    false,
    "one pid was signalled, the tree was not — delivered here strands surviving children"
  );
  assert.equal(outcome.method, "kill-partial");
  assert.equal(outcome.treeKillTimedOut, true);
  // Signal 0 comes first, and it is not a kill. Since 2026-08-01 terminateProcessTree asks
  // whether the pid is even there before asking what image it wears — identity is a
  // question about a process that exists, and on macOS the probe still returns a name for
  // one that has exited, so asking anyway turned a dead target into an "image-mismatch".
  // This test records every call to killImpl, so the probe shows up here; that is the right
  // place for a behaviour change to become visible rather than a reason to hide it.
  assert.deepEqual(killed, [
    [4242, 0],
    [4242, "SIGTERM"]
  ]);
});

// The missing-binary case is a different state and keeps its old contract: no tree kill
// was ever available, so the direct kill is the whole kill this platform can offer.
test("a missing taskkill still reports its direct kill as delivered", () => {
  const outcome = terminateProcessTree(4243, {
    platform: "win32",
    runCommandImpl: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" })
    }),
    killImpl: () => {}
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "kill");
  assert.equal(outcome.treeKillTimedOut, undefined);
});
