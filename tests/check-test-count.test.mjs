/**
 * The release-time test-count gate (scripts/check-test-count.mjs).
 *
 * A failed `git tag` lookup, and a checkout with no tags at all, must not read the topmost
 * CHANGELOG section as unreleased, or `--write` would rewrite a published count. These tests
 * run a copy of the script in a scratch directory. They never point it at this repository's
 * CHANGELOG.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { initGitRepo, makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-test-count.mjs");

function fixture({ git = false, tag = null, otherTag = null } = {}) {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "check-test-count.mjs"));
  fs.writeFileSync(path.join(dir, "README.md"), "The suite has 10 unit tests.\n");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## [1.2.3]\n\nVerified with 4 unit tests.\n");
  fs.writeFileSync(path.join(dir, "tap.txt"), "# tests 10\n# pass 10\n");
  if (git) {
    initGitRepo(dir);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "fixture"]);
    if (tag) execFileSync("git", ["-C", dir, "tag", tag]);
    if (otherTag) execFileSync("git", ["-C", dir, "tag", otherTag]);
  }
  return dir;
}

function run(dir, args, options = {}) {
  return spawnSync(process.execPath, [path.join(dir, "scripts", "check-test-count.mjs"), "--tap", path.join(dir, "tap.txt"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: options.env ?? process.env
  });
}

function changelog(dir) {
  return fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
}

test("a directory that is not a git repo fails closed and does not rewrite the changelog", () => {
  const dir = fixture();
  const result = run(dir, ["--write"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Could not ask git/);
  assert.match(changelog(dir), /4 unit tests/);
  assert.doesNotMatch(result.stderr, /Run with --write/);
});

test("a checkout with no tags at all fails closed and does not rewrite the changelog", () => {
  const dir = fixture({ git: true });
  const result = run(dir, ["--write"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Could not ask git/);
  assert.match(result.stderr, /no tags/);
  assert.match(changelog(dir), /4 unit tests/);
});

test("a tagged release section is skipped", () => {
  const dir = fixture({ git: true, tag: "v1.2.3" });
  const result = run(dir, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1\.2\.3 is already released/);
  assert.match(result.stdout, /README\.md: agrees at 10/);
  assert.match(changelog(dir), /4 unit tests/);
});

test("other tags do not make an untagged section look unreleased-or-unknown", () => {
  const dir = fixture({ git: true, otherTag: "v9.9.9" });
  const result = run(dir, []);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /claims 4 but the suite has 10/);
  assert.doesNotMatch(result.stderr, /Could not ask git/);
  assert.match(changelog(dir), /4 unit tests/);
});

test("git missing from PATH is a failed lookup, not an unreleased section", () => {
  const dir = fixture({ git: true, tag: "v1.2.3" });
  const result = run(dir, ["--write"], { env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Could not ask git/);
  assert.match(changelog(dir), /4 unit tests/);
});
