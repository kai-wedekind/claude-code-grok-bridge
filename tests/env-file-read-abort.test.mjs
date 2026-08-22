/**
 * A read that fails for anything other than ENOENT must abort rather than rewrite the file.
 *
 * ⚠ THIS FILE WAS CALLED `env-file-atomic-fallback` UNTIL 2026-08-17, and its header described
 * a temp-file-and-rename write with a silent fallback. That mechanism no longer exists: the
 * writer replaces the file in place, deliberately, because writing in place keeps the inode so
 * the mode and any symlink identity survive by construction, and the rename needed a Windows
 * EPERM fallback that was the very truncating write it existed to avoid.
 *
 * Neither test here ever stubbed `renameSync`. Both audits that read this file said the same
 * thing: what actually ships is a real read-abort test and an import-does-not-run-main test,
 * living under a name that promised atomicity. A name is the first thing anyone believes, and
 * a suite map ticking "atomic write: covered" off this file would have been wrong.
 *
 * What these two tests do pin, and it is worth keeping:
 *   - B1: a non-ENOENT read error leaves existing content alone. Treating a failed read as an
 *     empty file would rewrite somebody else's env file down to our own two lines.
 *   - importing the hook does not execute it, even with stdin held open — which is what makes
 *     it safe for a test to import at all.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { appendEnvVar } from "../plugins/grok-build/scripts/session-lifecycle-hook.mjs";
import { makeTempDir } from "./helpers.mjs";

function withEnvFile(run) {
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  fs.writeFileSync(file, "", "utf8");
  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = file;

  // ⚠ Capture stderr ONLY around the call under test, never around the assertions. Patching it
  // for the whole body swallows the test runner's own failure diagnostics, so a failing
  // assertion reports "test failed" with nothing under it — which is what happened here first.
  // And the stub must honour the callback form: `write(chunk, cb)` and `write(chunk, enc, cb)`
  // are both used by Node internals, and swallowing the callback hangs whoever waits on it.
  // That timed this file out at two minutes on its first run.
  const capture = (fn) => {
    const realWrite = process.stderr.write.bind(process.stderr);
    const seen = [];
    process.stderr.write = (chunk, encoding, cb) => {
      seen.push(String(chunk));
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") done();
      return true;
    };
    try {
      fn();
    } finally {
      process.stderr.write = realWrite;
    }
    return seen;
  };

  try {
    return run(file, capture);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_ENV_FILE;
    else process.env.CLAUDE_ENV_FILE = previous;
  }
}

test("a non-ENOENT read error leaves existing content alone", () => {
  // The destructive path rewriting introduced: read fails, `existing` becomes empty, and the
  // whole file is overwritten with one variable. handleSessionStart runs three such cycles in
  // a row, so a transient failure on the second erases what the first just wrote.
  //
  // ⚠ SURFACE-06 in done-surfaces.test.mjs names this defect but cannot detect it. Its fixture
  // is a DIRECTORY standing in for the file, which does produce a non-ENOENT read error — but
  // it also makes the subsequent write fail no matter what, so its two assertions (exit 0, the
  // target is still a directory) hold whether or not the guard exists. It proves the hook
  // SURVIVES an unreadable env file, which is worth proving, and nothing about overwriting.
  // Found by a vacuity audit 2026-08-09.
  //
  // Here the target is a real file with foreign content, and the read is made to fail with
  // EACCES directly — deterministic, and identical on Windows and POSIX, where permission
  // games are not. Testing it in-process is only possible because importing this module no
  // longer runs the hook.
  withEnvFile((file, capture) => {
    const foreign = "OTHER_HOOK_VAR=keep-me\nexport OTHER_HOOK_VAR='keep-me'\n";
    fs.writeFileSync(file, foreign, "utf8");

    const realRead = fs.readFileSync;
    fs.readFileSync = (target, ...rest) => {
      if (String(target) === file) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realRead(target, ...rest);
    };
    let seen;
    try {
      seen = capture(() => {
        appendEnvVar("CLAUDE_PLUGIN_DATA", "C:/state/root");
      });
    } finally {
      fs.readFileSync = realRead;
    }

    assert.equal(
      fs.readFileSync(file, "utf8"),
      foreign,
      "an unreadable env file must be left exactly as it was, not rewritten with one variable"
    );
    // B2 on the read path: a refused read must announce itself, and name the errno. Until
    // 2026-08-11 this path was silent — B1 held and B2 did not, which is how the two
    // contradicted each other in the first draft of the invariant list.
    const warning = seen.join("");
    assert.match(
      warning,
      /EACCES/,
      "B2: the refused-read warning must name the errno, not only say something failed"
    );
    assert.match(warning, /could not read/, "and must identify the operation");
  });
});

test("importing the hook does not run it, even with stdin held open", () => {
  // Until 2026-08-09 `main()` was called unconditionally at module scope, so importing this
  // file for `appendEnvVar` started the hook, which then blocked reading a stdin that would
  // never deliver a payload. A directly-imported test hung for ninety seconds and reported
  // only "test failed"; it is also why the older shell-safety tests drive this module through
  // spawned subprocesses rather than importing it.
  //
  // stdin is deliberately a PIPE that is never written to and never closed — that is the
  // condition that hung, and closing it would make this test pass against the old code too.
  const hook = path.resolve("plugins/grok-build/scripts/session-lifecycle-hook.mjs");
  const url = `file:///${hook.replace(/\\/g, "/")}`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); process.stdout.write(typeof m.appendEnvVar);`],
    { encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }
  );

  assert.equal(child.signal, null, "the import must not have to be killed — that is the hang this pins");
  assert.equal(child.status, 0, `import exited ${child.status}: ${child.stderr}`);
  assert.equal(child.stdout, "function", "and the export must actually be importable");
});
