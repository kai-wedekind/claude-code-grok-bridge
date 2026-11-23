#!/usr/bin/env node
/**
 * Run the test suite portably.
 *
 * `node --test tests/*.test.mjs` works only where something expands the glob, and on
 * Windows nothing does below Node 21: cmd and PowerShell pass the asterisk through
 * unchanged, and Node itself only learned to expand patterns in 21. The result was a
 * suite that passed locally on Node 22 while every CI run on windows-latest with
 * Node 18.18 or 20 failed with `Could not find 'D:\\a\\…\\tests\\*.test.mjs'`.
 *
 * `node --test tests` is not the fix either: the runner treats a bare argument as a file
 * to execute, so it fails with MODULE_NOT_FOUND on the directory.
 *
 * So expand the list here, where the language does it the same way everywhere, and hand
 * the runner explicit paths. Extra arguments are forwarded, so
 * `npm test -- --test-name-pattern=auth` still works.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(ROOT, "tests");

const files = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join("tests", name));

if (files.length === 0) {
  // An empty list would make `node --test` search its default locations and quite
  // possibly exit 0, reporting success for a suite that never ran.
  console.error(`No *.test.mjs files found in ${TEST_DIR}`);
  process.exit(1);
}

// ⚠ The documented read-only tool list is checked against the shipped constant HERE, before
// the suite, because a gate nobody runs is not a gate. `check-tool-list.mjs` was written on
// 2026-08-08 after the README shipped two copy-pasteable launch lines carrying a list that
// cannot start a session — and it was then left out of `package.json`, out of this runner and
// out of CI, so the exact failure it exists to prevent could recur untouched. An audit found
// that the same day.
//
// Here rather than only in CI, for two reasons: it fails on the developer's machine where the
// fix is cheap, and CI skips `**.md` pushes entirely, so a docs-only edit that introduces the
// drift would never reach a runner. Unlike `check-test-count`, this list changes rarely, so it
// does not create friction mid-work.
const toolList = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-tool-list.mjs")], {
  cwd: ROOT,
  stdio: "inherit"
});
if (toolList.status !== 0) {
  console.error("\nDocumented tool list disagrees with the shipped constant — see above.");
  process.exit(toolList.status ?? 1);
}

// The kill switch lives under the user's home; the suite must never read or write the real one
// (a disabled bridge on the developer's machine would fail every run test, and the disable tests
// would switch it off). Individual tests still set their own path; this is the backstop.
const disabledFlag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-cc-suite-")), "disabled.json");

// The runner builds this env itself, so a delete inside a test file cannot see a variable
// that was copied in here. Drop both plugin-data names, including a differently cased key:
// a spread of process.env is a plain object, and on Windows the live name is not always the
// spelling delete would guess (upstream #52, 2026-10-24). The bridge's own child marker and
// forwarded session id go too: inherited inside a bridge-started Grok session, the marker made
// every hook test exit at once (11 failures, measured 2026-10-24). So does the update-check
// opt-out: set in the shell that runs acceptance, it silenced the notice the version-check tests
// assert on (1 failure, measured 2026-11-22); the opt-out tests set it themselves.
const suiteEnv = { ...process.env, GROK_CC_DISABLED_FLAG: disabledFlag };
for (const key of Object.keys(suiteEnv)) {
  if (/^(CLAUDE_PLUGIN_DATA|GROK_BUILD_PLUGIN_DATA|GROK_CC_BRIDGE_CHILD|GROK_CC_SESSION_ID|GROK_CC_UPDATE_CHECK)$/i.test(key)) {
    delete suiteEnv[key];
  }
}

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdio: "inherit",
  env: suiteEnv
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
