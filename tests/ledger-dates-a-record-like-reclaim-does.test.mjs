/**
 * The ledger has to date a record the same way the reclaim path does.
 *
 * Two pieces of code answer "when did this job last do anything", and they answered
 * differently:
 *
 *   reclaim  job-control.mjs   updatedAt ?? startedAt ?? createdAt   then the file's mtime
 *   ledger   usage-ledger.mjs  updatedAt ??              createdAt   then discard the record
 *
 * A record carrying only `startedAt` — what a crash between spawn and the first heartbeat
 * leaves behind — was therefore reclaimable as unknown spend and simultaneously invisible to
 * the accounting. The same for a torn write whose dates are unreadable but whose mtime the
 * filesystem still maintains. Both vanished from `runs`, from `costUsd` and from
 * `incompleteRuns` alike, with no line anywhere saying a record had been dropped.
 *
 * That is the silent-underreport class this ledger exists to prevent, reached by a different
 * route than the killed run it already handles. Zero records hit it on the machine where it
 * was found, which is a fact about one machine on one day and not about the code — the
 * repository is about to be handed to people whose machines nobody has seen.
 *
 * The residual case is kept honest rather than closed: a record with neither a parseable date
 * nor a readable mtime still cannot be placed in a time window, so it stays out of the
 * totals — but it is now counted and printed instead of silently dropped.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectUsage, renderUsage } from "../plugins/grok-build/scripts/lib/usage-ledger.mjs";
import { makeTempDir } from "./helpers.mjs";

const HOUR = 60 * 60 * 1000;

/** Write a job record verbatim — no dates are added, so a test can omit them deliberately. */
function seed(root, workspace, id, job, mtimeMs = null) {
  const jobsDir = path.join(root, workspace, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const file = path.join(jobsDir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, ...job }), "utf8");
  if (mtimeMs !== null) {
    const seconds = mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return file;
}

/** A completed run that reported real spend, so it shows up in the money columns. */
function paidRun(dates) {
  return {
    status: "completed",
    ...dates,
    result: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    // 1 USD = 10^10 ticks (TICKS_PER_USD in usage-ledger.mjs — named rather than cited by
    // line, because line numbers move and a stale one is worse than none). Written out
    // rather than computed so a change to that constant fails this test loudly instead of
    // quietly agreeing with it.
    costTicks: 10_000_000_000
  };
}

test("a record whose only date is startedAt is counted, not discarded", () => {
  const root = makeTempDir();
  const recently = new Date(Date.now() - HOUR).toISOString();
  seed(root, "ws", "run-started-only", paidRun({ startedAt: recently }));

  const report = collectUsage({ stateRoot: root, subscriptionOverride: null });

  assert.equal(report.runs, 1, "startedAt is a date like any other; reclaim already reads it");
  assert.equal(report.costUsd, 1);
});

test("an unreadable date falls back to the file's mtime, as reclaim does", () => {
  const root = makeTempDir();
  seed(
    root,
    "ws",
    "run-torn-write",
    paidRun({ updatedAt: "not-a-date", createdAt: "" }),
    Date.now() - HOUR
  );

  const report = collectUsage({ stateRoot: root, subscriptionOverride: null });

  assert.equal(report.runs, 1, "the filesystem knows when the file was last written");
  assert.equal(report.costUsd, 1);
});

test("the mtime fallback still respects the window rather than sweeping everything in", () => {
  const root = makeTempDir();
  seed(
    root,
    "ws",
    "run-ancient",
    paidRun({ updatedAt: "not-a-date" }),
    Date.now() - 90 * 24 * HOUR
  );

  const report = collectUsage({ stateRoot: root, days: 7, subscriptionOverride: null });

  assert.equal(report.runs, 0, "a ninety-day-old file is outside a seven-day window");
});

test("a record that cannot be dated at all is counted and printed, not silently dropped", () => {
  const root = makeTempDir();
  const file = seed(root, "ws", "run-undatable", paidRun({ updatedAt: "not-a-date" }));

  // Make the mtime unreadable too, which is what the residual case actually looks like.
  const report = collectUsage({
    stateRoot: root,
    subscriptionOverride: null,
    jobMtimeImpl: () => null
  });

  assert.ok(fs.existsSync(file));
  assert.equal(report.undatedRecords, 1, "the record must be counted somewhere");
  assert.equal(report.runs, 0, "it cannot be placed in a window, so it stays out of the totals");
  assert.match(
    renderUsage(report),
    /undated|could not be dated/i,
    "a dropped record has to be visible in the report, or the drop is silent again"
  );
});

test("ordinary records are unaffected", () => {
  const root = makeTempDir();
  const now = new Date().toISOString();
  seed(root, "ws", "run-normal", paidRun({ updatedAt: now, createdAt: now }));

  const report = collectUsage({ stateRoot: root, subscriptionOverride: null });

  assert.equal(report.runs, 1);
  assert.equal(report.undatedRecords, 0);
  assert.doesNotMatch(renderUsage(report), /undated/i, "no noise when there is nothing to say");
});
