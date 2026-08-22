/**
 * Rewriting the env file must not widen its permissions or replace a symlink at its path.
 *
 * Both hold by construction today, because `writeFileSync` over an existing path writes through
 * the existing inode: the mode is never re-created, and a symlink is followed rather than
 * swapped. So these tests pass without any code defending them, which is exactly why they must
 * stay — they are what would notice if the writer ever went back to building a new file and
 * moving it into place.
 *
 * ⚠ That is not hypothetical. 0.3.3 briefly did precisely that, to close a truncation window,
 * and it cost both properties: measured on Linux with umask 022, a file created 0600 came back
 * 0644, and a symlinked path was replaced by a regular file leaving the old target stale
 * forever. Repairing them took a `chmod` and a `realpathSync`; deleting the rename removed the
 * need for either. See `docs/env-file-invariants.md`, D1 and D2.
 *
 * ⚠ These can only fail on the second host. On Windows `chmod` moves the read-only bit and
 * nothing else, so every strategy reads back 666 and the assertion would pass for a reason
 * unrelated to what it checks. They SKIP on win32 with a reason rather than passing there.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { appendEnvVar } from "../plugins/grok-build/scripts/session-lifecycle-hook.mjs";
import { makeTempDir } from "./helpers.mjs";

const posixOnly = process.platform === "win32"
  ? { skip: "POSIX modes only: on Windows chmod moves the read-only bit, so this cannot fail here" }
  : {};

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

function withEnvFile(startingMode, run) {
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  fs.writeFileSync(file, "export FOREIGN='keepme'\n", "utf8");
  fs.chmodSync(file, startingMode);
  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previous;
    }
  }
}

test("a private env file keeps its mode when rewritten", posixOnly, () => {
  withEnvFile(0o600, (file) => {
    appendEnvVar("CLAUDE_SESSION_ID", "abc123");

    assert.equal(
      modeOf(file).toString(8),
      "600",
      "rewriting must not widen a private env file's mode"
    );
    // Control: the write must actually have happened, so the mode assertion cannot pass
    // simply because nothing touched the file.
    assert.match(fs.readFileSync(file, "utf8"), /CLAUDE_SESSION_ID/);
    assert.match(fs.readFileSync(file, "utf8"), /FOREIGN/, "foreign lines must survive");
  });
});

test("a group-readable env file keeps its mode when rewritten", posixOnly, () => {
  withEnvFile(0o640, (file) => {
    appendEnvVar("CLAUDE_SESSION_ID", "abc123");
    assert.equal(
      modeOf(file).toString(8),
      "640",
      "rewriting must not widen a group-readable env file to world-readable"
    );
    // Control, which the audit correctly noted was missing here while the 0600 test had one:
    // without it, a hook that early-returned before writing anything would leave the mode at
    // 640 and pass this test for exactly the wrong reason.
    assert.match(fs.readFileSync(file, "utf8"), /CLAUDE_SESSION_ID/);
  });
});

test("a symlinked env file keeps its link, and the target is what changes", posixOnly, () => {
  // The other half of the same defect. Writing over the original follows the link and updates
  // its target; replacing the file instead would swap the LINK for a regular file and leave the
  // old target stale — and anything still reading that target would never notice.
  const dir = makeTempDir();
  const real = path.join(dir, "real.env");
  const link = path.join(dir, "link.env");
  fs.writeFileSync(real, "export FOREIGN='keepme'\n", "utf8");
  fs.symlinkSync(real, link);

  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = link;
  try {
    appendEnvVar("CLAUDE_SESSION_ID", "abc123");

    assert.ok(
      fs.lstatSync(link).isSymbolicLink(),
      "the write replaced the symlink itself with a regular file"
    );
    assert.match(
      fs.readFileSync(real, "utf8"),
      /CLAUDE_SESSION_ID/,
      "the symlink's target never received the variable"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previous;
    }
  }
});

test("an env file that does not exist yet is still created", posixOnly, () => {
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = file;
  try {
    // No existing file, so nothing to preserve — this pins that creating one still works.
    appendEnvVar("CLAUDE_SESSION_ID", "abc123");
    assert.match(fs.readFileSync(file, "utf8"), /CLAUDE_SESSION_ID/);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previous;
    }
  }
});
