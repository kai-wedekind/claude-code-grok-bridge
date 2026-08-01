/**
 * On Windows a bare command name must resolve on PATH or the launch is refused.
 *
 * `CreateProcess` searches the **current directory before PATH**, and this plugin's
 * working directory is routinely a repository somebody else wrote — that is what `review`
 * is for. So when `resolveExecutable` finds nothing, spawning the bare name hands the
 * choice to whatever `grok.exe` the reviewed repository happens to contain.
 *
 * POSIX is genuinely different and must stay unguarded: `execvp` searches PATH and never
 * the working directory, and `resolveExecutable` returns null there by design — that null
 * means "let the OS do it", not "not found". A guard that fired on both platforms would be
 * wrong on one of them.
 *
 * The first version of this guard fired on absolute paths too, because `resolveExecutable`
 * only searches PATH and returns null for a path that names one file directly. That would
 * have broken every user who points `GROK_BINARY` at a full path — which is exactly what
 * the documentation tells them to do. The suite caught it; hence the third test.
 *
 * Found 2026-07-31 by an audit pass that asked what a hostile repository could do. It stayed
 * invisible because on a machine where `grok` is always on PATH, the null branch never
 * ran.
 */
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runCommand, isBareCommandName, bareNameSpawnIsSafe } from "../plugins/grok-build/scripts/lib/process.mjs";

test("windows refuses to spawn a bare name that is not on PATH", () => {
  const result = runCommand("definitely-not-on-path-grok", [], {
    platform: "win32",
    env: { PATH: "", PATHEXT: ".EXE" },
    sanitizeEnv: false
  });

  assert.equal(result.status, 1);
  assert.equal(result.error?.code, "ENOENT");
  assert.match(result.stderr, /current directory before PATH/i);
  assert.match(result.stderr, /GROK_BINARY/, "the message has to say how to fix it");
});

test("posix still spawns a bare name — execvp does not search the working directory", () => {
  // Not asserting a successful launch: the point is that the guard does not intercept.
  // A refusal would carry our ENOENT message; a real failure to find the binary carries
  // the OS error instead.
  const result = runCommand("definitely-not-on-path-grok", [], {
    platform: "linux",
    env: { PATH: "/nonexistent" },
    sanitizeEnv: false
  });

  assert.doesNotMatch(
    String(result.stderr ?? ""),
    /current directory before PATH/i,
    "the windows guard must not fire on posix"
  );
});

test("an absolute path is never ambiguous, so the guard leaves it alone", () => {
  const absolute = path.join(process.cwd(), "no-such-grok.exe");
  const result = runCommand(absolute, [], {
    platform: "win32",
    env: { PATH: "", PATHEXT: ".EXE" },
    sanitizeEnv: false
  });

  assert.doesNotMatch(
    String(result.stderr ?? ""),
    /current directory before PATH/i,
    "a full path names one file; refusing it would break GROK_BINARY as documented"
  );

  assert.equal(isBareCommandName(absolute), false);
  assert.equal(isBareCommandName("grok"), true);
  assert.equal(isBareCommandName("./grok"), false);
  assert.equal(isBareCommandName("bin\\grok.exe"), false);
  assert.equal(bareNameSpawnIsSafe("linux"), true);
  assert.equal(bareNameSpawnIsSafe("win32"), false);
});
