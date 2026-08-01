/**
 * A git file list is read with -z, because `--name-only` does not print paths.
 *
 * It prints *renderings* of paths, and git reformats two kinds of name on the way out:
 *
 *   - `core.quotePath` is on by default, so `café.txt` comes back as `"caf\303\251.txt"` —
 *     wrapped in quotes, with the UTF-8 bytes spelled out in octal;
 *   - a name containing a newline is C-quoted for the same reason, and splitting the output
 *     on newlines then yields two entries, neither of which names a file.
 *
 * Both failures are silent. The mangled name reaches `formatUntrackedFile`, whose `lstat`
 * throws ENOENT on a file that is sitting right there — so the review either loses the file
 * or loses the whole untracked listing with it. `-z` disables the quoting and separates with
 * NUL, the one byte a path cannot contain.
 *
 * Non-ASCII rather than a newline in the fixture: Windows forbids newlines in filenames, and
 * a test that only runs on two of three platforms is a test that stops running. The quoting
 * path is the same one.
 *
 * Found 2026-07-31 by an audit pass that read the git layer for parsing assumptions.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { getWorkingTreeState } from "../plugins/grok-build/scripts/lib/git.mjs";

// Any byte above ASCII triggers the quoting; the character just has to be one. Chosen to
// be a deliberate test artefact rather than a word in some language, so nobody later reads
// it as prose that wandered in.
const AWKWARD = "café.txt";

test("a non-ASCII filename survives the untracked listing intact", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, AWKWARD), "content\n", "utf8");

  const state = getWorkingTreeState(repo);

  assert.deepEqual(state.untracked, [AWKWARD]);
  assert.ok(
    fs.existsSync(path.join(repo, state.untracked[0])),
    "the listed name must be openable; a quoted rendering is not"
  );
});

test("a non-ASCII filename survives the staged and unstaged listings intact", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, AWKWARD), "content\n", "utf8");
  run("git", ["add", "--", AWKWARD], { cwd: repo });

  assert.deepEqual(getWorkingTreeState(repo).staged, [AWKWARD]);

  run("git", ["commit", "-m", "add"], { cwd: repo });
  fs.writeFileSync(path.join(repo, AWKWARD), "changed\n", "utf8");

  assert.deepEqual(getWorkingTreeState(repo).unstaged, [AWKWARD]);
});

test("an empty listing is empty, not one blank entry", () => {
  // -z terminates the last record too, so the split leaves a trailing empty string. Without
  // the filter, a clean repository reports one changed file whose name is "".
  const repo = makeTempDir();
  initGitRepo(repo);

  const state = getWorkingTreeState(repo);

  assert.deepEqual(state.staged, []);
  assert.deepEqual(state.unstaged, []);
  assert.deepEqual(state.untracked, []);
  assert.equal(state.isDirty, false);
});
