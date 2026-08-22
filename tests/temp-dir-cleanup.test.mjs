// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
//
// The suite created a temp directory per call and removed none of them. Measured 2026-08-07:
// 101,660 leaked directories, about 520 MB, the oldest from 2026-07-27. Inherited from upstream
// verbatim including the prefix, so ours are indistinguishable from theirs by name alone.
//
// ⚠ These tests assert on paths this process created and on nothing else. A before/after COUNT
// over the shared prefix would also count another checkout's directories, or a second suite
// running concurrently on the same machine — it would pass while deleting somebody else's live
// state, or fail for reasons that have nothing to do with this code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanupTempDirs, initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cleanupTempDirs removes exactly what this process created", () => {
  const mine = [makeTempDir(), makeTempDir(), makeTempDir()];
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "grok-build-plugin-test-"));

  for (const dir of mine) assert.ok(fs.existsSync(dir), "precondition: created");
  cleanupTempDirs();

  for (const dir of mine) {
    assert.equal(fs.existsSync(dir), false, `${dir} should have been removed`);
  }
  assert.ok(
    fs.existsSync(foreign),
    "a directory this process did not create must survive — the prefix is shared with other checkouts"
  );
  fs.rmSync(foreign, { recursive: true, force: true });
});

test("a git fixture is removed despite read-only loose objects", () => {
  // This is the case that defeated the first cleanup attempt: git writes objects under
  // .git/objects read-only, and one such file makes a recursive delete refuse the whole tree.
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "first"], { cwd: repo });

  const objects = path.join(repo, ".git", "objects");
  assert.ok(fs.existsSync(objects), "precondition: the fixture really is a git repo");

  cleanupTempDirs();
  assert.equal(fs.existsSync(repo), false, "a committed git fixture must still be removable");
});

test("the cleanup runs on process exit, not only when called by hand", () => {
  // The guard that matters: nothing in the suite calls cleanupTempDirs(), so if the exit hook
  // is not wired the leak simply continues while every other test passes. Proven from outside
  // by running a child that creates a directory, prints it and exits normally.
  const probe = path.join(makeTempDir(), "probe.mjs");
  fs.writeFileSync(
    probe,
    [
      // A bare absolute path is not a valid ESM specifier on Windows; it has to be a file URL.
      `import { makeTempDir } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "tests", "helpers.mjs")).href)};`,
      "const dir = makeTempDir();",
      "process.stdout.write(dir);"
    ].join("\n"),
    "utf8"
  );

  const result = run(process.execPath, [probe]);
  assert.equal(result.status, 0, result.stderr);
  const childDir = result.stdout.trim();
  assert.ok(childDir.length > 0, "the child must report the directory it created");
  assert.equal(
    fs.existsSync(childDir),
    false,
    `the child's temp directory survived its exit: ${childDir}`
  );
});
