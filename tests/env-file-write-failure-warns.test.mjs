/**
 * B2 on the write path: a failed write must name the errno, not go quiet.
 *
 * ⚠ This gate existed and was deleted as collateral. `env-file-write-is-atomic.test.mjs` held
 * the only assertion for it, and that whole file went when temp+rename did — the machinery it
 * mostly tested was gone, and this one test went with it unnoticed. Found by the audit of the
 * rewrite, 2026-08-11.
 *
 * The failure it guards is the one this function keeps re-growing: silence. A total write
 * failure has now been made loud three separate times in three different places here, so the
 * gate matters more than the code does.
 *
 * ⚠ The first test stubs `writeFileSync` so it throws before anything is opened. That is a
 * failed *open*: the file is untouched. It does not cover ENOSPC after a successful open,
 * which is O_TRUNC then a short write — that shape is the second test.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { appendEnvVar } from "../plugins/grok-build/scripts/session-lifecycle-hook.mjs";
import { makeTempDir } from "./helpers.mjs";

test("a failed open says so, and names the errno", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  const foreign = "export OTHER_TOOL_VAR='keep-me'\n";
  fs.writeFileSync(file, foreign, "utf8");

  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = file;

  const realWrite = fs.writeFileSync;
  const realStderr = process.stderr.write.bind(process.stderr);
  const seen = [];

  fs.writeFileSync = (dest, ...rest) => {
    if (String(dest) === file) {
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return realWrite(dest, ...rest);
  };
  // Capture stderr ONLY around the call under test: wrapping the assertions too swallows the
  // runner's own diagnostics, and the stub must honour both callback shapes or a waiter hangs.
  process.stderr.write = (chunk, encoding, cb) => {
    seen.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") done();
    return true;
  };

  try {
    appendEnvVar("CLAUDE_SESSION_ID", "abc123");
  } finally {
    fs.writeFileSync = realWrite;
    process.stderr.write = realStderr;
    if (previous === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previous;
    }
  }

  const warning = seen.join("");
  assert.match(warning, /could not write/, "a failed write produced no output at all");
  assert.match(warning, /ENOSPC/, "the warning must name the errno, or it cannot be acted on");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    foreign,
    "control: a failed open leaves the file untouched; this test does not cover a write that fails after truncation"
  );
});

test("a write that fails after truncation does not claim previous values survived", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  const foreign = "export OTHER_TOOL_VAR='keep-me'\n";
  fs.writeFileSync(file, foreign, "utf8");

  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = file;

  const realWrite = fs.writeFileSync;
  const realStderr = process.stderr.write.bind(process.stderr);
  const seen = [];
  let threw = false;

  fs.writeFileSync = (dest, ...rest) => {
    if (String(dest) === file) {
      realWrite(dest, "", "utf8");
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return realWrite(dest, ...rest);
  };
  process.stderr.write = (chunk, encoding, cb) => {
    seen.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") done();
    return true;
  };

  try {
    appendEnvVar("CLAUDE_SESSION_ID", "abc123");
  } catch {
    threw = true;
  } finally {
    fs.writeFileSync = realWrite;
    process.stderr.write = realStderr;
    if (previous === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previous;
    }
  }

  assert.equal(threw, false, "B4: a failed write must not throw out of the hook");
  const warning = seen.join("");
  assert.match(warning, /could not write/, "a failed write produced no output at all");
  assert.match(warning, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the warning must name the file");
  assert.match(warning, /ENOSPC/, "the warning must name the errno, or it cannot be acted on");
  assert.doesNotMatch(
    warning,
    /previous values are still in place/,
    "the warning must not claim previous values survived: writeFileSync already truncated the file"
  );
  assert.equal(fs.readFileSync(file, "utf8"), "", "control: the open succeeded and emptied the file before the throw");
});
