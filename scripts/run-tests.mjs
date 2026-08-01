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

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
