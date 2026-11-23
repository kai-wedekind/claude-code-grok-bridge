/**
 * `SECURITY.md` says the read-only barrier is applied on every launch path and that each path
 * is pinned by a test asserting the argv. A release audit on 2026-08-09 checked that sentence
 * against the suite and found it ahead of the evidence: the foreground `run` argv was pinned,
 * but the nudge's SECOND launch was only counted rather than re-inspected, and `review` /
 * `critique` had no argv assertion at all — they were trusted to inherit the constants because
 * they share a helper.
 *
 * Sharing a helper is a reason to expect it to hold, not evidence that it does. These tests
 * assert the flags on the launches nobody was looking at, so the sentence in the security
 * document is a claim the suite can actually cash.
 *
 * The sandbox profile is a literal, never `readOnlySandboxProfile()`.
 * Comparing with the function under test stays green when every launch passes `off`, and a
 * hard-coded `"read-only"` at one site stays green on a host whose own answer is `read-only`.
 * The walk therefore runs twice on a forced Linux answer: `present` expects `read-only` on
 * every read-only launch, `absent` expects `off`. Only the absent walk tells a hard-coded
 * `"read-only"` at one site from the real code. Write launches assert that no `--sandbox`
 * is passed.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeGrok, buildEnv } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { READ_ONLY_DISALLOWED_TOOLS } from "../plugins/grok-build/scripts/grok-bridge.mjs";

const SCRIPT = path.resolve("plugins/grok-build/scripts/grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, ...extra });
}

/** Every argv the fake CLI was launched with, in order. */
function launches(argvLogPath) {
  if (!fs.existsSync(argvLogPath)) return [];
  return fs
    .readFileSync(argvLogPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function probeEnv(binDir, argvLog, probe) {
  return pluginDataEnv(makeTempDir(), binDir, {
    GROK_FAKE_ARGV_LOG: argvLog,
    GROK_CC_LANDLOCK_PROBE: probe,
    GROK_CC_CONFINEMENT_PLATFORM: "linux"
  });
}

/** The barrier, asserted positively rather than by absence of the write flag. */
function assertBarrier(argv, label, expectedSandbox) {
  const joined = argv.join(" ");
  const idx = argv.indexOf("--disallowed-tools");
  assert.ok(idx !== -1, `${label}: --disallowed-tools missing from argv: ${joined}`);
  const removed = argv[idx + 1].split(",").map((s) => s.trim()).filter(Boolean);
  for (const tool of READ_ONLY_DISALLOWED_TOOLS) {
    assert.ok(removed.includes(tool), `${label}: ${tool} not removed — argv: ${joined}`);
  }
  for (const rule of ["Bash", "Write", "Edit", "MCPTool"]) {
    assert.ok(joined.includes(`--deny ${rule}`), `${label}: deny rule ${rule} missing — argv: ${joined}`);
  }
  assert.ok(!joined.includes("--always-approve"), `${label}: read-only must not auto-approve — argv: ${joined}`);
  // The sandbox flag is checked too, and the expected profile is a literal, not the
  // function the launch calls.
  const sandbox = argv.indexOf("--sandbox");
  assert.ok(
    sandbox !== -1 && argv[sandbox + 1] === expectedSandbox,
    `${label}: --sandbox ${expectedSandbox} missing — argv: ${joined}`
  );
  // Passed, not enforcing. A headless run ignores `--no-plan`;
  // the assertion only checks that the argv still carries it.
  assert.ok(argv.includes("--no-plan"), `${label}: --no-plan missing — argv: ${joined}`);
}

function assertNoSandbox(argv, label) {
  assert.equal(
    argv.indexOf("--sandbox"),
    -1,
    `${label}: write launch must not pass --sandbox — argv: ${argv.join(" ")}`
  );
}

/**
 * Nudge, review, critique and `check --verify-tools` are different call sites. The nudge
 * is the task site (`run`, connector and the background worker use the same expression).
 * Review and critique share one site. verify-tools is its own. A literal at any one of
 * them survives a walk that does not launch it.
 */
function walkLaunches(probe, expectedSandbox) {
  const label = `probe ${probe}`;

  const nudgeBin = makeTempDir();
  installFakeGrok(nudgeBin, "empty-text");
  const nudgeLog = path.join(makeTempDir(), "argv.log");
  const nudgeWorkspace = makeTempDir();
  run(process.execPath, [SCRIPT, "run", "--cwd", nudgeWorkspace, "say nothing"], {
    env: probeEnv(nudgeBin, nudgeLog, probe)
  });
  const nudge = launches(nudgeLog);
  assert.ok(nudge.length >= 2, `${label}: expected a nudge relaunch, saw ${nudge.length} launch(es)`);
  nudge.forEach((argv, i) => assertBarrier(argv, `${label} nudge launch ${i + 1} of ${nudge.length}`, expectedSandbox));

  for (const command of ["review", "critique"]) {
    const binDir = makeTempDir();
    installFakeGrok(binDir);
    const workspace = makeTempDir();
    initGitRepo(workspace);
    // A review of nothing launches nothing: with no working-tree change the command exits
    // before it ever builds argv, and an "at least one launch" assertion then fails for a
    // reason that has nothing to do with the barrier.
    fs.writeFileSync(path.join(workspace, "changed.txt"), "a line worth reviewing\n", "utf8");
    const argvLog = path.join(makeTempDir(), "argv.log");
    run(process.execPath, [SCRIPT, command, "--cwd", workspace], {
      env: probeEnv(binDir, argvLog, probe)
    });
    const all = launches(argvLog);
    assert.ok(all.length >= 1, `${label}: ${command} must have launched the CLI at least once`);
    all.forEach((argv, i) => assertBarrier(argv, `${label} ${command} launch ${i + 1}`, expectedSandbox));
  }

  const checkBin = makeTempDir();
  installFakeGrok(checkBin);
  const checkLog = path.join(makeTempDir(), "argv.log");
  run(process.execPath, [SCRIPT, "check", "--verify-tools", "--cwd", makeTempDir()], {
    env: probeEnv(checkBin, checkLog, probe)
  });
  const probed = launches(checkLog).filter((argv) => argv.includes("--disallowed-tools"));
  assert.ok(probed.length >= 1, `${label}: verify-tools must have launched the removal-list probe`);
  probed.forEach((argv, i) => assertBarrier(argv, `${label} verify-tools launch ${i + 1}`, expectedSandbox));

  const writeBin = makeTempDir();
  installFakeGrok(writeBin);
  const writeLog = path.join(makeTempDir(), "argv.log");
  const writeWorkspace = makeTempDir();
  run(process.execPath, [SCRIPT, "run", "--write", "--cwd", writeWorkspace, "change this"], {
    env: probeEnv(writeBin, writeLog, probe)
  });
  const writeLaunches = launches(writeLog).filter((argv) => argv.includes("-p") || argv.includes("--prompt-file"));
  assert.ok(writeLaunches.length >= 1, `${label}: write run must have launched`);
  writeLaunches.forEach((argv, i) => assertNoSandbox(argv, `${label} write launch ${i + 1}`));
}

test("every read-only launch passes --sandbox read-only when the probe says present", () => {
  walkLaunches("present", "read-only");
});

test("every read-only launch passes --sandbox off when the probe says absent", () => {
  walkLaunches("absent", "off");
});
