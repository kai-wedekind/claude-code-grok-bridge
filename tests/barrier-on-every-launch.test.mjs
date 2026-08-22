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

/** The barrier, asserted positively rather than by absence of the write flag. */
function assertBarrier(argv, label) {
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
}

test("the nudge's second launch carries the barrier too, not just the first", () => {
  // The nudge re-launches the CLI after an empty deliverable. The existing test counts that
  // there were two launches; it never looked at what the second one was made of. A retry that
  // dropped the barrier would have passed it.
  const binDir = makeTempDir();
  installFakeGrok(binDir, "empty-text");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  run(process.execPath, [SCRIPT, "run", "--cwd", workspace, "say nothing"], { env });

  const all = launches(argvLog);
  assert.ok(all.length >= 2, `expected a nudge relaunch, saw ${all.length} launch(es)`);
  all.forEach((argv, i) => assertBarrier(argv, `launch ${i + 1} of ${all.length}`));
});

test("review builds the same barrier as run", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  initGitRepo(workspace);
  // A review of nothing launches nothing: with no working-tree change the command exits before
  // it ever builds argv, and an "at least one launch" assertion then fails for a reason that
  // has nothing to do with the barrier. Give it something to look at.
  fs.writeFileSync(path.join(workspace, "changed.txt"), "a line worth reviewing\n", "utf8");
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  run(process.execPath, [SCRIPT, "review", "--cwd", workspace], { env });

  const all = launches(argvLog);
  assert.ok(all.length >= 1, "review must have launched the CLI at least once");
  all.forEach((argv, i) => assertBarrier(argv, `review launch ${i + 1}`));
});

test("critique builds the same barrier as run", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  initGitRepo(workspace);
  // A review of nothing launches nothing: with no working-tree change the command exits before
  // it ever builds argv, and an "at least one launch" assertion then fails for a reason that
  // has nothing to do with the barrier. Give it something to look at.
  fs.writeFileSync(path.join(workspace, "changed.txt"), "a line worth reviewing\n", "utf8");
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = pluginDataEnv(pluginDataDir, binDir, { GROK_FAKE_ARGV_LOG: argvLog });

  run(process.execPath, [SCRIPT, "critique", "--cwd", workspace], { env });

  const all = launches(argvLog);
  assert.ok(all.length >= 1, "critique must have launched the CLI at least once");
  all.forEach((argv, i) => assertBarrier(argv, `critique launch ${i + 1}`));
});
