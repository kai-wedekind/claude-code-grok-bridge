import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  collectUsage,
  readSubscriptionUsage,
  renderUsage
} from "../plugins/grok-build/scripts/lib/usage-ledger.mjs";

function writeBillingLog(dir, lines) {
  const logDir = path.join(dir, ".grok", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, "unified.jsonl");
  fs.writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
  return file;
}

function billingLine(percent, ts, periodEnd = "2026-07-28T06:14:17.613057+00:00") {
  return {
    ts,
    lvl: "info",
    msg: "billing: fetched credits config",
    ctx: {
      subscriptionTier: "X Premium+",
      config: {
        creditUsagePercent: percent,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: periodEnd }
      }
    }
  };
}

function writeJob(stateRoot, workspace, id, record) {
  const jobsDir = path.join(stateRoot, workspace, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify(record));
}

test("subscription reading takes the most recent entry in the log", () => {
  const home = makeTempDir();
  writeBillingLog(home, [
    billingLine(24, "2026-07-26T08:00:00.000Z"),
    billingLine(50, "2026-07-26T20:21:04.176Z")
  ]);

  const reading = readSubscriptionUsage({ home, stateRoot: makeTempDir() });

  assert.equal(reading.percentUsed, 50);
  assert.equal(reading.tier, "X Premium+");
  assert.equal(reading.periodEnd, "2026-07-28T06:14:17.613057+00:00");
  assert.ok(reading.ageHours >= 0, "age is derived from the log timestamp");
});

test("subscription reading fails open: missing log, junk lines, and wrong shapes yield null", () => {
  const missing = makeTempDir();
  assert.equal(readSubscriptionUsage({ home: missing, stateRoot: makeTempDir() }), null, "missing log must not throw");

  const junk = makeTempDir();
  writeBillingLog(junk, [
    "not json at all",
    '{"ctx":{"config":{"creditUsagePercent":"not a number"}},"msg":"creditUsagePercent"}',
    '{"ctx":{},"msg":"unrelated"}'
  ]);
  assert.equal(readSubscriptionUsage({ home: junk, stateRoot: makeTempDir() }), null, "unusable entries must not be reported");
});

test("subscription reading skips a malformed newest entry and uses the last usable one", () => {
  const home = makeTempDir();
  writeBillingLog(home, [
    billingLine(31, "2026-07-26T10:00:00.000Z"),
    '{"ts":"2026-07-26T21:00:00.000Z","msg":"creditUsagePercent truncated write'
  ]);

  assert.equal(readSubscriptionUsage({ home, stateRoot: makeTempDir() }).percentUsed, 31);
});

test("a reading is cached and survives the log rotating it away", () => {
  const home = makeTempDir();
  const stateRoot = makeTempDir();
  writeBillingLog(home, [billingLine(50, "2026-07-26T20:21:04.176Z")]);

  const fresh = readSubscriptionUsage({ home, stateRoot });
  assert.equal(fresh.percentUsed, 50);
  assert.equal(fresh.cached, false);

  // The CLI rotates unified.jsonl in place, and the billing line only reappears when
  // an interactive session starts — so without a cache the number simply vanishes.
  writeBillingLog(home, ['{"ts":"2026-07-27T01:00:00.000Z","msg":"something else"}']);

  const afterRotation = readSubscriptionUsage({ home, stateRoot });
  assert.equal(afterRotation.percentUsed, 50, "the last known reading must survive");
  assert.equal(afterRotation.cached, true, "and must be marked as coming from the cache");
  assert.equal(afterRotation.periodEnd, "2026-07-28T06:14:17.613057+00:00");
});

test("with neither a log nor a cache, nothing is reported rather than something wrong", () => {
  assert.equal(readSubscriptionUsage({ home: makeTempDir(), stateRoot: makeTempDir() }), null);
});

test("render marks a cached reading as such", () => {
  const home = makeTempDir();
  const stateRoot = makeTempDir();
  writeBillingLog(home, [billingLine(42, "2026-07-26T20:00:00.000Z")]);
  readSubscriptionUsage({ home, stateRoot });
  writeBillingLog(home, ["{}"]);

  const rendered = renderUsage(collectUsage({ stateRoot, home }));

  assert.match(rendered, /42% of the weekly allowance used/);
  assert.match(rendered, /from the last reading the log still had/);
});

test("ledger sums cost and tokens per day and skips test-fixture workspaces", () => {
  const stateRoot = makeTempDir();
  const now = new Date().toISOString();
  writeJob(stateRoot, "real-workspace", "a", {
    updatedAt: now,
    costUsd: 0.02,
    usage: { input_tokens: 100, output_tokens: 10, reasoning_tokens: 5, total_tokens: 115 }
  });
  writeJob(stateRoot, "real-workspace", "b", {
    updatedAt: now,
    result: { costUsd: 0.03, usage: { input_tokens: 200, output_tokens: 20, total_tokens: 220 } }
  });
  writeJob(stateRoot, "grok-build-plugin-test-abc", "c", {
    updatedAt: now,
    costUsd: 99,
    usage: { input_tokens: 1, total_tokens: 1 }
  });

  const report = collectUsage({ stateRoot, home: makeTempDir() });

  assert.equal(report.runs, 2, "fixture workspace must not be counted");
  assert.equal(report.costUsd, 0.05);
  assert.equal(report.tokens.input, 300);
  assert.equal(report.tokens.total, 335);
  assert.equal(report.perDay.length, 1);
});

test("exact tick counts win over the dollar floats", () => {
  const stateRoot = makeTempDir();
  const now = new Date().toISOString();
  // 1 USD = 10^10 ticks. Three runs whose float sum drifts, but whose ticks are exact.
  for (const [id, ticks] of [["a", 3_333_333_333], ["b", 3_333_333_333], ["c", 3_333_333_334]]) {
    writeJob(stateRoot, "ws", id, {
      updatedAt: now,
      costTicks: ticks,
      costUsd: ticks / 1e10,
      usage: { total_tokens: 10 }
    });
  }

  const report = collectUsage({ stateRoot, home: makeTempDir() });

  assert.equal(report.costTicks, 10_000_000_000, "ticks add up without drift");
  assert.equal(report.costUsd, 1, "and convert to exactly one dollar");
  assert.equal(report.runsWithCost, 3);
});

test("records written before ticks existed still count via their dollar value", () => {
  const stateRoot = makeTempDir();
  writeJob(stateRoot, "ws", "old-shape", {
    updatedAt: new Date().toISOString(),
    costUsd: 0.25,
    usage: { total_tokens: 5 }
  });

  const report = collectUsage({ stateRoot, home: makeTempDir() });

  assert.equal(report.costUsd, 0.25);
  assert.equal(report.runsWithCost, 1);
});

test("a run the CLI could not account for is counted as unmeasured, not as free", () => {
  const stateRoot = makeTempDir();
  const now = new Date().toISOString();
  writeJob(stateRoot, "ws", "measured", { updatedAt: now, costTicks: 5_000_000_000, usage: { total_tokens: 1 } });
  writeJob(stateRoot, "ws", "unmeasured", { updatedAt: now, usageIncomplete: true });

  const report = collectUsage({ stateRoot, home: makeTempDir() });

  assert.equal(report.runs, 2, "the unmeasured run is still a run");
  assert.equal(report.incompleteRuns, 1);
  assert.equal(report.runsWithCost, 1, "but it does not pretend to have a cost");
  assert.match(renderUsage(report), /incomplete accounting/i, "and the report says so");
});

test("ledger ignores records older than the window and those without any usage", () => {
  const stateRoot = makeTempDir();
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  writeJob(stateRoot, "ws", "old", { updatedAt: old, costUsd: 5, usage: { total_tokens: 10 } });
  writeJob(stateRoot, "ws", "bare", { updatedAt: new Date().toISOString() });

  const report = collectUsage({ stateRoot, days: 7, home: makeTempDir() });

  assert.equal(report.runs, 0);
  assert.equal(report.costUsd, 0);
});

test("render states that the number is spend, not remaining quota", () => {
  const stateRoot = makeTempDir();
  const home = makeTempDir();
  writeBillingLog(home, [billingLine(50, "2026-07-26T20:21:04.176Z")]);

  const rendered = renderUsage(collectUsage({ stateRoot, home }));

  assert.match(rendered, /50% of the weekly allowance used/);
  assert.match(rendered, /Unsupported side channel/);
  assert.match(rendered, /measures spend, not the remaining weekly allowance/);
});
