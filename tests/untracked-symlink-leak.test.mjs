/**
 * An untracked symlink must not carry its target's contents into the review context.
 *
 * `git ls-files --others` lists a symlink as an untracked entry, and the context builder
 * used statSync + readFileSync — both of which follow links. A link in the working tree
 * pointing at anything readable (an ssh key, a token file, a document a directory up)
 * therefore had its target inlined into the prompt sent to the model. Nobody asking for a
 * code review asked for that, and the person who made the link cannot be expected to read
 * it as a disclosure.
 *
 * Found by reading xai-org/grok-build-plugin-cc issue #4 — opened 2026-07-16 and still open
 * upstream, with PR #10 (2026-07-29) unmerged, when last checked 2026-08-01 — while surveying
 * what other bridges do differently. This fork inherited the defect from that same code.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  collectReviewContext,
  formatUntrackedFile,
  resolveReviewTarget
} from "../plugins/grok-build/scripts/lib/git.mjs";

const SECRET = "SUPER-SECRET-KEY-THAT-MUST-NOT-REACH-THE-MODEL";

/** Windows needs elevation or developer mode for symlinks; say so instead of passing. */
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return false;
    }
    throw error;
  }
}

// Runs everywhere, including the Windows box this was written on, where creating a real
// symlink needs elevation and the integration test below therefore skips itself.
test("the untracked-file formatter refuses a symlink without reading it", () => {
  let opened = null;
  const output = formatUntrackedFile("/repo", "notes.txt", {
    lstatImpl: () => ({
      isSymbolicLink: () => true,
      isDirectory: () => false,
      size: 42
    }),
    readFileImpl: (target) => {
      opened = target;
      return Buffer.from(SECRET, "utf8");
    }
  });

  assert.equal(opened, null, "the target must not be opened at all, not merely withheld");
  assert.doesNotMatch(output, new RegExp(SECRET));
  assert.match(output, /skipped: symlink/);
  assert.match(output, /notes\.txt/, "the entry is still named");
});

test("a plain untracked file is still inlined", () => {
  const output = formatUntrackedFile("/repo", "app.js", {
    lstatImpl: () => ({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      size: 20
    }),
    readFileImpl: () => Buffer.from("export const a = 1;\n", "utf8")
  });

  assert.match(output, /export const a = 1;/, "the guard must not swallow ordinary files");
});

test("an untracked symlink does not leak its target into the review context", (t) => {
  const outside = makeTempDir();
  const repo = makeTempDir();
  initGitRepo(repo);

  // A committed file, so the repository has a HEAD and the review has something to scope.
  fs.writeFileSync(path.join(repo, "app.js"), "export const answer = 42;\n", "utf8");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });

  const secretFile = path.join(outside, "id_rsa");
  fs.writeFileSync(secretFile, `${SECRET}\n`, "utf8");

  if (!trySymlink(secretFile, path.join(repo, "notes.txt"))) {
    t.skip("symlink creation needs elevation or developer mode on this host");
    return;
  }

  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);

  assert.doesNotMatch(
    context.content,
    new RegExp(SECRET),
    "the link's target contents must never appear in what is sent to the model"
  );
  assert.match(
    context.content,
    /notes\.txt/,
    "the entry is still named, so the reviewer knows something was there"
  );
  assert.match(context.content, /skipped: symlink/);
});
