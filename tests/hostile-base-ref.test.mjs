// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
//
// A `--base` value reaches git POSITIONALLY, with no option terminator, so a value beginning
// with a dash is read as an OPTION rather than as a revision. These tests pin that the shape is
// refused at the CLI door, by us, with our message.
//
// ⚠ SCOPE, corrected after an audit on 2026-08-08 found the original claim overstated. The raw
// value reaches exactly ONE git call — `merge-base HEAD <ref>` — and every later `diff`/`log`
// consumes `<mergeBase>..HEAD`, built from git's own stdout. The earlier version of this header
// said `git diff` would see the value and could be turned into `--output=<file>`; it cannot, on
// the production path. This is defence in depth and a clear error message, not a plugged write
// primitive, and saying otherwise made the guard look load-bearing when it is not.
//
// ⚠ Nor is it complete: `collectReviewContext` is exported and bypasses this function entirely,
// so a library caller is not covered. Today such a call still dies at `merge-base`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function makeRepo() {
  const repo = makeTempDir();
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "first");
  return repo;
}

test("a base ref that looks like a git option is refused", () => {
  const repo = makeRepo();
  for (const hostile of ["--upload-pack=echo", "-n", "--output=pwned.txt", "--all"]) {
    assert.throws(
      () => resolveReviewTarget(repo, { base: hostile }),
      /may not begin with/,
      `${hostile} must be refused before it can reach git's option parser`
    );
  }
});

test("ordinary refs still resolve, including ones containing a dash", () => {
  // The guard keys on the FIRST character, and must not become a ban on dashes: `release-1.2`
  // and `feature/x-y` are entirely ordinary branch names.
  const repo = makeRepo();
  for (const ok of ["main", "release-1.2", "feature/x-y", "v0.3.3"]) {
    const target = resolveReviewTarget(repo, { base: ok });
    assert.equal(target.baseRef, ok);
    assert.equal(target.mode, "branch");
  }
});

test("the refusal reaches the command line, and the value never reaches git", () => {
  // ⚠ Renamed from "git is never run", which was false: ensureGitRepository and
  // getWorkingTreeState both run git before the guard fires. What is actually pinned is that
  // the hostile VALUE never reaches a git argv — the refusal is ours, not git's.
  // End to end, because the unit assertion above would still pass if `review` resolved its
  // target by some other route. A real `git` is on PATH here, so the test also proves the
  // failure is OURS: git's own complaint reads `error: unknown option`, and if that appears
  // the value got through.
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const canary = path.join(os.tmpdir(), `grok-cc-hostile-canary-${process.pid}.txt`);
  fs.rmSync(canary, { force: true });

  const result = spawnSync(
    process.execPath,
    [SCRIPT, "review", "--cwd", repo, "--base", `--output=${canary}`],
    { encoding: "utf8", env: { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: makeTempDir() } }
  );

  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, "a refused ref must not exit 0");
  assert.match(output, /may not begin with/, "the refusal must be ours and must say why");
  assert.doesNotMatch(output, /unknown option|unknown switch/, "the value must never reach git");
  assert.equal(fs.existsSync(canary), false, "no file may be written by the ref");
});
