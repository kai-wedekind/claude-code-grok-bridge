import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { JOB_LIVE_STALE_MS } from "./job-control.mjs";
import { isProcessGone } from "./process.mjs";
import { describeStateRootOrigin, resolveStateRoot } from "./state.mjs";
import { resolveJobKillTargets } from "./tracked-jobs.mjs";

/**
 * Did this run end without anyone recording that it ended?
 *
 * A record with an active status and NO kill targets is never counted: that is a queued job
 * whose worker has not started, so nothing was spent and "unknown spend" would be a
 * fabrication.
 *
 * Beyond that, two independent reasons to call it stranded, and the second is not optional:
 *
 *   - every process it names is gone; or
 *   - the record has been silent longer than JOB_LIVE_STALE_MS.
 *
 * The age backstop exists because A LIVE PID IS NOT PROOF — pids recycle, and job-control
 * says exactly that at the top of its own file. Measured 2026-08-01 against a real state
 * root: records still claiming to run, days old, probed as ALIVE, because their pids belong
 * to something else entirely now. With liveness alone such a record stays invisible for
 * good — the very defect this function was written to remove, surviving inside its own fix.
 *
 * The threshold is imported rather than restated: heartbeats run every ~15s, so fifteen
 * minutes of silence is far past any healthy run, and a second copy of that number would
 * drift away from the reclaim path that shares the judgement.
 */
function isStrandedActiveRecord(job, isGone = isProcessGone, stampMs = null, nowMs = Date.now()) {
  if (job?.status !== "queued" && job?.status !== "running") {
    return false;
  }
  const targets = resolveJobKillTargets(job);
  if (targets.length === 0) {
    return false;
  }
  if (Number.isFinite(stampMs) && nowMs - stampMs > JOB_LIVE_STALE_MS) {
    return true;
  }
  return targets.every((pid) => {
    try {
      return isGone(pid) === true;
    } catch {
      // A probe that cannot answer leaves the record alone: unsure is not stranded.
      return false;
    }
  });
}

/**
 * Local spend ledger.
 *
 * A Grok subscription publishes no usage or quota endpoint, whichever plan backs it, so
 * the only honest
 * source of truth available locally is what the CLI itself reported for each run
 * (`total_cost_usd` and the token counts in its JSON envelope). This aggregates those
 * per-run numbers across every workspace under the state root.
 *
 * It measures SPEND, not remaining quota — calibrate it against a manual reading of the
 * subscription page to translate dollars into percent of the weekly allowance.
 *
 * Runs against the test fixture are excluded: they never touch the real service.
 */
// 1 USD = 10^10 ticks, per the CLI's headless-mode documentation.
const TICKS_PER_USD = 1e10;
const TEST_WORKSPACE_PATTERN = /grok-build-plugin-test-/i;

/**
 * @returns {{records: object[], damaged: number}} always this shape, on every path.
 *
 * The early return used to hand back a bare `[]` while the happy path returned the object
 * — a leftover from when this function only produced records. A workspace with no `jobs`
 * directory therefore destructured to `records: undefined` and the report died on
 * "records is not iterable". Every workspace on the development machine happened to have
 * one, so it surfaced first under `--include-test-workspaces`, which pulls in
 * directories the test suite created and never filled. The crash took out `usage`, which
 * is the budget report the availability switch is meant to be built on.
 */
/**
 * When did this record last do anything?
 *
 * Deliberately the same precedence as `resolveJobStamp` in job-control.mjs, which makes the
 * same judgement for the reclaim path: the record's own dates in order, then the file's
 * mtime, which the filesystem maintains whether or not the content is sane. The two are kept
 * as separate functions rather than shared because each resolves the job file by a different
 * route — reclaim from a workspace root, the ledger from a state directory it is already
 * walking — but the ORDER is the thing that has to match, and it now does.
 *
 * Returns null when nothing can date the record, so the caller can distinguish "outside the
 * window" from "cannot be placed in any window".
 */
function resolveRecordStamp(job, mtimeMs, options = {}) {
  const fromRecord = Date.parse(job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
  if (Number.isFinite(fromRecord)) {
    return fromRecord;
  }
  const mtime = typeof options.jobMtimeImpl === "function" ? options.jobMtimeImpl(job) : mtimeMs;
  return Number.isFinite(mtime) ? mtime : null;
}

function readJobRecords(workspaceDir) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(workspaceDir, "jobs")).filter((name) => name.endsWith(".json"));
  } catch {
    return { records: [], damaged: 0 };
  }
  const records = [];
  let damaged = 0;
  for (const name of names) {
    const file = path.join(workspaceDir, "jobs", name);
    try {
      // The mtime is taken here, where the file is already in hand, because it is the last
      // resort for dating a record whose own timestamps are unreadable. The reclaim path
      // has always had that fallback; this one did not, and the difference made a torn
      // write reclaimable and unaccountable at the same time.
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        // Unreadable mtime is not a reason to drop the record — it only removes one way of
        // dating it, and the caller decides what that means.
      }
      records.push({ job: JSON.parse(fs.readFileSync(file, "utf8")), mtimeMs });
    } catch {
      // A job file that will not parse is a run whose spend nobody can read. Swallowing
      // it counted that run as an exact zero, which is the same dishonesty the
      // usageIncomplete flag exists to prevent — just arrived at through a truncated
      // write instead of a killed process. Count it and say so.
      damaged += 1;
    }
  }
  return { records, damaged };
}

/**
 * Best-effort read of the subscription's weekly usage percentage.
 *
 * There is no supported endpoint for this. The official CLI fetches its own billing
 * config at session start and logs the result, so the number can be read back out of
 * that local log. This is an UNSUPPORTED side channel: the field names are not a public
 * contract, the log rotates, and the value is only as fresh as the last CLI session.
 *
 * Every failure path returns null. Nothing here may throw or block a run — a stale or
 * missing reading must never be able to stop work, which is why this is reported and
 * not enforced.
 */
const BILLING_LOG_TAIL_BYTES = 4 * 1024 * 1024;
const SUBSCRIPTION_CACHE_FILE = "subscription-usage.json";

/**
 * The CLI rotates its log in place, and the billing line is only written when an
 * interactive session starts — so the reading disappears for long stretches. Keeping
 * the last one we saw turns that from "no information" into "information with an age
 * attached", which is what a hint like this is worth anyway.
 */
function readCachedSubscription(stateRoot) {
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(stateRoot, SUBSCRIPTION_CACHE_FILE), "utf8"));
    return typeof cached?.percentUsed === "number" ? cached : null;
  } catch {
    return null;
  }
}

function writeCachedSubscription(stateRoot, reading) {
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, SUBSCRIPTION_CACHE_FILE), JSON.stringify(reading), {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {
    // A hint that cannot be cached is still a hint.
  }
}

function ageHoursFrom(observedAt) {
  const stamp = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(stamp) ? Number(((Date.now() - stamp) / 3_600_000).toFixed(1)) : null;
}

export function readSubscriptionUsage(options = {}) {
  const logFile =
    options.logFile ??
    path.join(options.home ?? process.env.USERPROFILE ?? process.env.HOME ?? "", ".grok", "logs", "unified.jsonl");
  const stateRoot = options.stateRoot ?? resolveStateRoot();

  let text = "";
  try {
    const handle = fs.openSync(logFile, "r");
    try {
      const size = fs.fstatSync(handle).size;
      const start = Math.max(0, size - BILLING_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, BILLING_LOG_TAIL_BYTES));
      fs.readSync(handle, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return readCachedSubscription(stateRoot);
  }

  // Scan backwards: the most recent reading wins.
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes("creditUsagePercent")) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const config = entry?.ctx?.config;
    const percent = config?.creditUsagePercent;
    if (typeof percent !== "number") {
      continue;
    }
    const observedAt = typeof entry.ts === "string" ? entry.ts : null;
    const reading = {
      percentUsed: percent,
      periodEnd: config?.currentPeriod?.end ?? null,
      tier: entry?.ctx?.subscriptionTier ?? null,
      observedAt
    };
    writeCachedSubscription(stateRoot, reading);
    return { ...reading, ageHours: ageHoursFrom(observedAt), cached: false };
  }

  // The log holds no reading right now — it rotates, and the line only appears when an
  // interactive session starts. Fall back to the last one we saw, clearly marked.
  const cached = readCachedSubscription(stateRoot);
  return cached ? { ...cached, ageHours: ageHoursFrom(cached.observedAt), cached: true } : null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The allowance period this report falls in — not the same seven days as `--days 7`.
 *
 * The rolling window looks back from now; the subscription renews at a fixed boundary.
 * Both are a week long and they are offset against each other, which makes the rolling
 * figure the wrong number for any budget decision. Measured 2026-07-31: the rolling total
 * ran 28 % above the actual period's. Against a fixed weekly allowance that is the
 * difference between "nearly spent" and "a third still free".
 *
 * `periodEnd` comes from the same aging cache as `percentUsed`, and that reading can be
 * days stale — but a period BOUNDARY repeats even when the observation does not, so an
 * old edge is rolled forward in whole periods instead of being trusted or discarded.
 * Without any reading at all this returns null rather than inventing a boundary.
 */
function resolveQuotaPeriod(subscription, nowMs) {
  const observedEnd = Date.parse(subscription?.periodEnd ?? "");
  if (!Number.isFinite(observedEnd)) {
    return null;
  }
  let end = observedEnd;
  while (end <= nowMs) {
    end += WEEK_MS;
  }
  return { startMs: end - WEEK_MS, endMs: end, rolledForward: end !== observedEnd };
}

export function collectUsage(options = {}) {
  const days = options.days ?? 7;
  const nowMs = Date.now();
  const since = nowMs - days * 24 * 60 * 60 * 1000;
  // WHICH ledger, not just whether it is there. `stateRootExisted` below answers "does this
  // directory exist"; this answers "is it the shared one". They are different questions and
  // only the second one catches the common case, because the fallback root exists and has
  // records in it — it is simply not where the plugin records.
  //
  // Measured 2026-08-01 with all three roots live: the root used when the variable is unset
  // and the root the plugin actually records into reported entirely different totals for the
  // same week. Exit 0, no warning, and the smaller figure reads as a quiet week rather than
  // as the wrong drawer. The run path already disclosed this; the report that adds the money
  // up did not, which is the half where it gets believed.
  const origin = describeStateRootOrigin(options.env ?? process.env);
  const root = options.stateRoot ?? origin.root;
  // An explicitly passed root is the caller's own decision, so there is nothing to disclose.
  // Tests pass one on every call; warning there would train the reader to skip the line.
  const rootWasChosenByCaller = options.stateRoot !== undefined && options.env === undefined;
  // Asked BEFORE anything else runs, because reading this report creates the directory:
  // readSubscriptionUsage caches its result under the state root, and a cache write makes
  // the parent. So by the time the walk below finds nothing, the root exists and looks
  // like an ordinary empty one.
  //
  // That is how a state root that never existed and a state root with no spend became the
  // same answer — a flat $0.00 either way. Point CLAUDE_PLUGIN_DATA at a typo and the
  // report says zero with a straight face, and it is not lying so much as unable to tell.
  // Found 2026-08-01 during a clean reinstall (the directory was absent before the query
  // and present after). An empty state root and a wrong state root report the same $0.00
  // and nothing in the output separates them, so the reading points at the wrong cause.
  const stateRootExisted = fs.existsSync(root);
  // Injectable so the period arithmetic can be tested without a billing log to read:
  // the boundary matters at hour resolution and a fixture cannot produce one on demand.
  const subscription = options.subscriptionOverride ?? readSubscriptionUsage(options);
  // Injectable for the same reason as the subscription above: whether a pid is gone is a
  // property of the machine, and a test cannot conjure a reliably-dead pid — a number too
  // large to be a pid does not raise ESRCH on Windows, it raises EINVAL, so the honest
  // fixture is a stub rather than a magic number. Measured while writing that test.
  const isGoneImpl = options.isProcessGoneImpl ?? isProcessGone;
  const period = resolveQuotaPeriod(subscription, nowMs);
  // Scan far enough back to cover BOTH windows. Otherwise a period that started before
  // the rolling window silently reported a partial total, and the caller had to know to
  // pass --days 14 — a footgun in exactly the number people budget against.
  const scanSince = period ? Math.min(since, period.startMs) : since;

  let workspaceDirs = [];
  try {
    workspaceDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "global-slots")
      .map((entry) => path.join(root, entry.name));
  } catch {
    workspaceDirs = [];
  }

  // Ticks are integers, so they add up exactly; the dollar floats are only a fallback
  // for records written before the bridge captured ticks.
  const totals = {
    runs: 0,
    runsWithCost: 0,
    incomplete: 0,
    damaged: 0,
    undated: 0,
    costTicks: 0,
    costUsdFallback: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0
  };
  // Accumulated alongside the rolling totals rather than derived from perDay afterwards:
  // a period boundary falls at a time of day, and day buckets cannot represent that.
  const periodTotals = { runs: 0, runsWithCost: 0, incomplete: 0, costTicks: 0, costUsdFallback: 0 };
  const perDay = new Map();
  const perWorkspace = new Map();

  for (const dir of workspaceDirs) {
    if (!options.includeTestWorkspaces && TEST_WORKSPACE_PATTERN.test(path.basename(dir))) {
      continue;
    }
    const { records, damaged } = readJobRecords(dir);
    totals.damaged += damaged;
    for (const { job, mtimeMs } of records) {
      // Dated exactly as the reclaim path dates it (job-control.mjs `resolveJobStamp`):
      // the record's own timestamps in the same order, then the file's mtime. The two used
      // to disagree — the ledger read only `updatedAt ?? createdAt` and then discarded
      // whatever it could not parse — so a record carrying only `startedAt`, which is what
      // a crash between spawn and the first heartbeat leaves, was reclaimable as unknown
      // spend and invisible to the accounting at the same time. Same for a torn write whose
      // mtime the filesystem still maintains.
      //
      // Zero records hit this on the machine where it was found. That is a fact
      // about one machine on one day, not about the code, and it is the wrong thing to lean
      // on for software other people are about to run.
      const stamp = resolveRecordStamp(job, mtimeMs, options);
      if (stamp === null) {
        // Undatable even by mtime. It cannot be placed in a window, so it stays out of the
        // totals — but it is counted and printed rather than dropped in silence, because a
        // silent drop is the exact dishonesty the incomplete flag exists to prevent.
        totals.undated += 1;
        continue;
      }
      if (stamp < scanSince) {
        continue;
      }
      const inPeriod = period ? stamp >= period.startMs : false;
      const inWindow = stamp >= since;
      const usage = job.usage ?? job.result?.usage ?? null;
      const rawTicks = Number.isInteger(job.costTicks) ? job.costTicks : job.result?.costTicks;
      const ticks = Number.isInteger(rawTicks) ? rawTicks : null;
      const rawCost = typeof job.costUsd === "number" ? job.costUsd : job.result?.costUsd;
      const cost = typeof rawCost === "number" ? rawCost : null;
      // A record still claiming to be queued or running, whose processes are demonstrably
      // gone, is a run that ended without ever accounting for itself — a hard kill, a
      // machine that went down. It has no usage, no cost and no flag, so the skip below
      // dropped it entirely: not counted, and not reported as incomplete either. Invisible
      // rather than unknown, which is the one thing this ledger is not allowed to be.
      //
      // The same reasoning is already written down two dozen lines up for a job file that
      // will not parse ("Swallowing it counted that run as an exact zero"). This is that
      // case reached through a killed process instead of a truncated write.
      //
      // Not status alone: a job that is genuinely running will account for itself when it
      // finishes, and flagging it on every `usage` call in the meantime would cry wolf. So
      // it takes dead targets OR silence past the stale threshold — see
      // isStrandedActiveRecord for why liveness by itself is not enough (pids recycle).
      //
      // This sentence read "Only a record whose targets are all dead is stranded" for one
      // commit after the age backstop had already made it false. Caught by Grok verifying
      // the change. A comment that outlives its code is the same defect as a gate that
      // outlives its assumption — it just fails in the reader instead of the machine, and
      // this file has more than one comment in that class already.
      //
      // Measured 2026-08-01 during a clean reinstall: the acceptance suite's step 8 kills a
      // run on purpose, and its cost vanished from the ledger every single time — 13 runs
      // counted where 14 had happened, with incompleteRuns reported as 0. Silently short,
      // in exactly the figure spend is budgeted against.
      const stranded = isStrandedActiveRecord(job, isGoneImpl, stamp, nowMs);
      const incomplete =
        job.usageIncomplete === true || job.result?.usageIncomplete === true || stranded;
      if (!usage && cost === null && ticks === null && !incomplete) {
        continue;
      }

      if (inPeriod) {
        periodTotals.runs += 1;
        if (incomplete) {
          periodTotals.incomplete += 1;
        }
        if (ticks !== null) {
          periodTotals.costTicks += ticks;
          periodTotals.runsWithCost += 1;
        } else if (cost !== null) {
          periodTotals.costUsdFallback += cost;
          periodTotals.runsWithCost += 1;
        }
      }

      if (!inWindow) {
        // Only scanned to complete the allowance period; it is older than the rolling
        // window and must not inflate the window's own figures.
        continue;
      }

      totals.runs += 1;
      if (incomplete) {
        // The CLI could not account for this run. Counting it as zero would quietly
        // understate spend, so it is counted separately and said out loud.
        totals.incomplete += 1;
      }
      if (ticks !== null) {
        totals.costTicks += ticks;
        totals.runsWithCost += 1;
      } else if (cost !== null) {
        totals.costUsdFallback += cost;
        totals.runsWithCost += 1;
      }
      totals.input += usage?.input_tokens ?? 0;
      totals.output += usage?.output_tokens ?? 0;
      totals.reasoning += usage?.reasoning_tokens ?? 0;
      totals.total += usage?.total_tokens ?? 0;

      const day = new Date(stamp).toISOString().slice(0, 10);
      const dayEntry = perDay.get(day) ?? { runs: 0, costUsd: 0 };
      dayEntry.runs += 1;
      dayEntry.costUsd += ticks !== null ? ticks / TICKS_PER_USD : (cost ?? 0);
      perDay.set(day, dayEntry);

      const wsName = path.basename(dir);
      const wsEntry = perWorkspace.get(wsName) ?? { runs: 0, costUsd: 0 };
      wsEntry.runs += 1;
      wsEntry.costUsd += ticks !== null ? ticks / TICKS_PER_USD : (cost ?? 0);
      perWorkspace.set(wsName, wsEntry);
    }
  }

  const round = (value) => Number(value.toFixed(4));
  return {
    days,
    subscription,
    // Where the numbers came from, and whether that place was already there. A zero from a
    // root that did not exist means "wrong path", not "no spend", and nothing else in this
    // report can tell the two apart.
    stateRoot: root,
    stateRootExisted,
    // "plugin-data" when CLAUDE_PLUGIN_DATA named it, "fallback" when nobody did. A total
    // from the fallback root is a real total of the wrong ledger, which no other field here
    // can express: the runs are real, the money is real, and it is not the money you meant.
    stateRootSource: rootWasChosenByCaller ? "explicit" : origin.source,
    stateRootDisclosure: rootWasChosenByCaller ? null : origin.disclosure,
    // The number to budget against. `days`/`since` describe a rolling window that is NOT
    // the allowance period, and reporting only that made the report read 28 % higher than
    // the period it was being compared to. Null when no subscription reading exists, so a
    // caller can tell "no period known" from "period is empty".
    period: period
      ? {
          start: new Date(period.startMs).toISOString(),
          end: new Date(period.endMs).toISOString(),
          rolledForward: period.rolledForward,
          runs: periodTotals.runs,
          runsWithCost: periodTotals.runsWithCost,
          incompleteRuns: periodTotals.incomplete,
          costUsd: round(periodTotals.costTicks / TICKS_PER_USD + periodTotals.costUsdFallback)
        }
      : null,
    since: new Date(since).toISOString(),
    runs: totals.runs,
    runsWithCost: totals.runsWithCost,
    costUsd: round(totals.costTicks / TICKS_PER_USD + totals.costUsdFallback),
    costTicks: totals.costTicks,
    incompleteRuns: totals.incomplete,
    // Job files that would not parse. Not folded into incompleteRuns: those are runs the
    // ledger could read and knows it cannot price, these are runs it could not read at
    // all, and the remedy differs (look at the file, not at the run).
    damagedRecords: totals.damaged,
    // Records that parsed but carry no usable date, not even a readable mtime. Separate from
    // damagedRecords because the remedy differs: those need the file looked at, these need a
    // clock. Both are runs whose spend is not in any total below.
    undatedRecords: totals.undated,
    tokens: {
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      total: totals.total
    },
    perDay: [...perDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, entry]) => ({ day, runs: entry.runs, costUsd: round(entry.costUsd) })),
    perWorkspace: [...perWorkspace.entries()]
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .slice(0, 10)
      .map(([workspace, entry]) => ({ workspace, runs: entry.runs, costUsd: round(entry.costUsd) }))
  };
}

export function renderUsage(report) {
  const fmt = (value) => new Intl.NumberFormat("en-US").format(value ?? 0);
  const lines = [
    `# Grok Build usage (last ${report.days} days)`,
    "",
    // Said before any number, because it changes what every number below means. Without
    // this line a mistyped CLAUDE_PLUGIN_DATA reports a confident $0.00, and the reading
    // is indistinguishable from a genuinely quiet week.
    // Which ledger this is, said before the total rather than after it. The run path has
    // carried this disclosure since a fallback state root turned out to be invisible to the
    // ledger; the report needs it more, because a wrong number that looks right is worse
    // than a run recorded in an odd place.
    ...(report.stateRootDisclosure
      ? [`⚠ ${report.stateRootDisclosure}`, ""]
      : []),
    ...(report.stateRootExisted === false
      ? [
          `⚠ This state root did not exist before the report ran: ${report.stateRoot}`,
          "  Every figure below is therefore zero because there is nothing THERE, not",
          "  because nothing was spent. Check CLAUDE_PLUGIN_DATA — and note that the",
          "  fallback root is used only when that variable is UNSET; pointing the variable",
          "  at the fallback path finds nothing.",
          ""
        ]
      : []),
    `Runs recorded: ${report.runs} (cost reported for ${report.runsWithCost}` +
      `${report.incompleteRuns ? `, ${report.incompleteRuns} with incomplete accounting` : ""})`,
    ...(report.damagedRecords
      ? [`Unreadable job files: ${report.damagedRecords} — their spend is not in this total.`]
      : []),
    ...(report.undatedRecords
      ? [
          `Undated job records: ${report.undatedRecords} — no usable timestamp and no readable`,
          "  file mtime, so they cannot be placed in any window and their spend is not in this",
          "  total either. Counted here rather than dropped in silence."
        ]
      : []),
    `Reported spend: $${report.costUsd.toFixed(2)}`,
    // Named explicitly, because "last 7 days" is formally right and practically
    // misleading: it rolls, the allowance does not. Reading the rolling figure as the
    // budget overstated it by 28 % on the day this was added.
    ...(report.period
      ? [
          "",
          `Allowance period (${report.period.start.slice(0, 10)} to ${report.period.end.slice(0, 10)}):` +
            ` $${report.period.costUsd.toFixed(2)} over ${report.period.runs} runs` +
            `${report.period.incompleteRuns ? `, ${report.period.incompleteRuns} unaccounted` : ""}`,
          "  This is the figure to budget against; the window above rolls and the allowance does not."
        ]
      : [
          "",
          "Allowance period unknown — no subscription reading available, so only the rolling window is shown."
        ]),
    `Tokens: ${fmt(report.tokens.input)} in / ${fmt(report.tokens.output)} out / ` +
      `${fmt(report.tokens.reasoning)} reasoning / ${fmt(report.tokens.total)} total`,
    ""
  ];
  if (report.subscription) {
    const sub = report.subscription;
    const age = sub.ageHours == null ? "unknown age" : `read ${sub.ageHours}h ago`;
    const origin = sub.cached ? ", from the last reading the log still had" : "";
    const until = sub.periodEnd ? `, weekly period ends ${sub.periodEnd}` : "";
    lines.push(
      `Subscription: ${sub.percentUsed}% of the weekly allowance used (${age}${until}${origin}).`,
      "  Source: the Grok CLI's own local log. Unsupported side channel, only as fresh as",
      "  the last CLI session — read it as a hint, and confirm on the subscription page.",
      ""
    );
  }

  if (report.perDay.length > 0) {
    lines.push("| Day | Runs | Spend |", "| --- | ---: | ---: |");
    for (const entry of report.perDay) {
      lines.push(`| ${entry.day} | ${entry.runs} | $${entry.costUsd.toFixed(2)} |`);
    }
    lines.push("");
  }
  lines.push(
    "This is a local ledger of what the CLI reported per run. A Grok subscription",
    "exposes no quota endpoint, so this measures spend, not the remaining weekly allowance;",
    "calibrate it against the subscription page. Test-fixture runs are excluded.",
    ""
  );
  return `${lines.join("\n")}\n`;
}
