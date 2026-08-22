/**
 * A spend figure has to say WHICH ledger it came from.
 *
 * `collectUsage` scans exactly one state root, and the bridge has more than one. Claude Code
 * sets CLAUDE_PLUGIN_DATA for the plugin; a bridge invoked from a plain shell does not have
 * it and silently falls back to a directory under the process temp — which `state.mjs`
 * already describes as a place "nothing else looks".
 *
 * The existing guard is `stateRootExisted`, and it only distinguishes a root that was MISSING
 * from one that was EMPTY. The fallback root is neither: it exists, it has records, and it is
 * simply the wrong ledger. So the report answered with a confident, warning-free total.
 *
 * Measured 2026-08-01 with every state root live at the same moment: with CLAUDE_PLUGIN_DATA
 * unset the report read the fallback root and answered with a small, plausible total, while
 * the shared root held nearly all of the real history. Exit 0, no warning, and entirely
 * believable as a quiet week. That is the failure mode this ledger exists to prevent: not an
 * error, but a plausible number that gets believed and then multiplied — these figures are
 * used to calibrate dollars per percentage point of a weekly allowance.
 *
 * The disclosure text was already written and already correct. `describeStateRootOrigin` in
 * state.mjs says exactly the right thing and was wired into the RUN path only, so the run that
 * spent the money warned about where it was recording while the report that added the money up
 * did not.
 */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { collectUsage, renderUsage } from "../plugins/grok-build/scripts/lib/usage-ledger.mjs";
import { makeTempDir } from "./helpers.mjs";

// A root that exists and is empty — the case `stateRootExisted` deliberately cannot flag,
// because there is nothing wrong with an empty ledger. What is wrong is not saying whose.
function emptyExistingRoot() {
  return makeTempDir();
}

test("with CLAUDE_PLUGIN_DATA unset, the report says the ledger is not the shared one", () => {
  const report = collectUsage({
    stateRoot: emptyExistingRoot(),
    env: {},
    subscriptionOverride: null
  });

  assert.equal(report.stateRootSource, "fallback");
  assert.ok(
    typeof report.stateRootDisclosure === "string" && report.stateRootDisclosure.length > 0,
    "an unset CLAUDE_PLUGIN_DATA must produce a disclosure, not silence"
  );
  assert.match(report.stateRootDisclosure, /CLAUDE_PLUGIN_DATA/);
});

test("the disclosure is printed BEFORE any number, where it changes what they mean", () => {
  const report = collectUsage({
    stateRoot: emptyExistingRoot(),
    env: {},
    subscriptionOverride: null
  });
  const text = renderUsage(report);

  const warningAt = text.indexOf("CLAUDE_PLUGIN_DATA");
  const firstNumberAt = text.indexOf("Runs recorded:");

  assert.ok(warningAt !== -1, "renderUsage must surface the disclosure, not only the payload");
  assert.ok(
    warningAt < firstNumberAt,
    "a caveat after the total is read after the total has already been believed"
  );
});

test("with the variable set, there is nothing to disclose and nothing is said", () => {
  const report = collectUsage({
    stateRoot: emptyExistingRoot(),
    env: { CLAUDE_PLUGIN_DATA: "C:\\somewhere\\plugin-data" },
    subscriptionOverride: null
  });

  assert.equal(report.stateRootSource, "plugin-data");
  assert.equal(report.stateRootDisclosure, null);
  assert.doesNotMatch(
    renderUsage(report),
    /is not set/,
    "a correct setup must not be warned about, or the warning stops being read"
  );
});

test("stateRootExisted still answers its own separate question", () => {
  // The two guards overlap in neither direction: this root is MISSING *and* the variable is
  // set, so the existing warning must fire while the new one stays quiet.
  const report = collectUsage({
    stateRoot: `${emptyExistingRoot()}-definitely-not-created`,
    env: { CLAUDE_PLUGIN_DATA: "C:\\somewhere\\plugin-data" },
    subscriptionOverride: null
  });

  assert.equal(report.stateRootExisted, false);
  assert.equal(report.stateRootDisclosure, null);
  assert.match(renderUsage(report), /did not exist before the report ran/);
});

test("collectUsage never creates the state root it reports as missing", () => {
  // ⚠ This is why the suite leaked exactly one directory per run for two weeks.
  //
  // `writeCachedSubscription` did `mkdirSync(stateRoot, { recursive: true })` before caching
  // the subscription hint, so a report that had just answered "did not exist before the
  // report ran" brought that directory into being — falsifying its own finding for every
  // later run, and creating a path no test-cleanup registry could know about because it is
  // derived rather than returned by makeTempDir.
  //
  // `usage` is a read-only diagnostic. It must leave the filesystem exactly as it found it.
  const absent = `${makeTempDir()}-definitely-not-created`;
  assert.equal(fs.existsSync(absent), false, "precondition: the path must not exist");

  const report = collectUsage({
    stateRoot: absent,
    env: { CLAUDE_PLUGIN_DATA: "C:\somewhere\plugin-data" },
    subscriptionOverride: null
  });

  assert.equal(report.stateRootExisted, false, "the finding itself must still be reported");
  assert.equal(
    fs.existsSync(absent),
    false,
    "and reporting it must not create it — a diagnostic that changes what it measures is worthless"
  );
});
