/**
 * The branch that decided a process was gone from taskkill's TEXT had never run in a test.
 *
 * `terminateProcessTree` classifies a Windows kill two ways: exit 128, which means "no such
 * pid" in every locale, and failing that, the wording of the message. Every fixture in the
 * suite that carries a missing-process message also sets `status: 128`, so all of them
 * returned at the exit-code check and the message branch never decided anything. That was
 * true before and after the commit that narrowed the pattern to English only — which is why
 * narrowing it looked free, and why two independent reviewers landed on the same gap.
 *
 * Measured on en-US Windows 11, 2026-08-01, with the exact argument list the bridge uses
 * (`/PID n /T /F`): a missing pid, a live pid under access-denied, and a critical system
 * process all exit 128. So this branch is a backstop rather than a hot path — but a backstop
 * nobody has ever executed is indistinguishable from one that does not work.
 *
 * These tests drive it directly, with a non-128 status, in both directions.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/grok-build/scripts/lib/process.mjs";

/**
 * A taskkill stub reporting a given exit status and text.
 *
 * It echoes back `command` and `args` because the real `runCommand` does, and the throw at
 * the end of the Windows branch formats them into its message. A stub that omitted them
 * turned that branch into a TypeError — which is worth recording, because it is the first
 * time anything executed it at all.
 */
function taskkillSaying(status, stdout, stderr = "") {
  return (command, args) => ({ command, args, status, stdout, stderr, error: null, signal: null });
}

/**
 * Force the identity check out of the way and the pid to look alive.
 *
 * Without `isGoneImpl` the real `process.kill(pid, 0)` runs, and on a POSIX CI runner a made
 * up pid answers ESRCH — the kill path would then never be reached at all and the test would
 * pass for the wrong reason on two of three platforms.
 */
const ALIVE_AND_UNCHECKED = {
  platform: "win32",
  isGoneImpl: () => false,
  readImageImpl: () => null
};

test("a non-128 exit whose text says the process is missing is still settled as gone", () => {
  const outcome = terminateProcessTree(4321, {
    ...ALIVE_AND_UNCHECKED,
    runCommandImpl: taskkillSaying(1, "", 'ERROR: The process "4321" not found.')
  });

  assert.equal(outcome.gone, true, "the message branch must classify this as gone");
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
});

test("each surviving pattern reaches the branch, so none is dead weight", () => {
  // One case per alternative in the regex. `no running instance` is included deliberately
  // even though taskkill only emits it for `/IM` — if it is unreachable for this caller it
  // should be removed knowingly, not left in place because nobody checked.
  const wordings = [
    'ERROR: The process "4321" not found.',
    "ERROR: There is no running instance of the task.",
    "ERROR: The system cannot find the process specified.",
    "ERROR: The process does not exist.",
    "kill: no such process"
  ];

  for (const text of wordings) {
    const outcome = terminateProcessTree(4321, {
      ...ALIVE_AND_UNCHECKED,
      runCommandImpl: taskkillSaying(1, "", text)
    });
    assert.equal(outcome.gone, true, `not classified as gone: ${text}`);
  }
});

test("a non-128 exit with an unrelated failure is NOT silently called gone", () => {
  // The other direction, and the one that matters for safety: an access-denied failure must
  // not be read as "already dead", or the record loses pids belonging to a live process.
  assert.throws(
    () =>
      terminateProcessTree(4321, {
        ...ALIVE_AND_UNCHECKED,
        runCommandImpl: taskkillSaying(
          1,
          "",
          "ERROR: The process with PID 4321 could not be terminated.\nReason: Access is denied."
        )
      }),
    /Access is denied/,
    "an unclassifiable failure must surface, not resolve to gone"
  );
});

test("the message is read from stdout as well as stderr", () => {
  // taskkill writes its errors to stderr, but the branch concatenates both streams and the
  // suite only ever exercised one of them.
  const outcome = terminateProcessTree(4321, {
    ...ALIVE_AND_UNCHECKED,
    runCommandImpl: taskkillSaying(1, 'ERROR: The process "4321" not found.', "")
  });

  assert.equal(outcome.gone, true);
});
