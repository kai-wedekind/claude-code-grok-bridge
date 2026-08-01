// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";

import { isProcessGone, readProcessImageName, terminateProcessTree } from "./process.mjs";
import {
  claimJobTerminal,
  collectJobsFromStateDir,
  getConfig,
  listJobs,
  listWorkspaceStateDirs,
  readJobFile,
  resolveJobFile,
  resolveTrustedJobLogFile
} from "./state.mjs";
import { appendLogLine, resolveJobKillTargets, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

// Live PID alone is not proof the tracked process still owns the job — PIDs recycle.
// A live PID keeps the job active only while the record is also being updated
// (progress / heartbeat). Runs of six minutes and more are routine; progress
// heartbeats every ~15s, so 15 minutes of silence is far past any healthy run.
export const JOB_LIVE_STALE_MS = 15 * 60 * 1000;

function processImagesMatch(actual, expected) {
  if (!expected || !actual) {
    // No fingerprint on the record, or probe failed: do not decide on image alone.
    return true;
  }
  const left = String(actual).split(/[/\\]/).pop().toLowerCase();
  const right = String(expected).split(/[/\\]/).pop().toLowerCase();
  return left === right;
}

/** Expected image fingerprint for a kill-target PID, when the record carries one. */
function expectedImageForPid(job, pid) {
  if (job.agentPid != null && Number(job.agentPid) === Number(pid) && job.agentImage) {
    return job.agentImage;
  }
  if (
    (job.bridgePid != null && Number(job.bridgePid) === Number(pid)) ||
    (job.pid != null && Number(job.pid) === Number(pid)) ||
    (job.companionPid != null && Number(job.companionPid) === Number(pid))
  ) {
    return job.bridgeImage ?? null;
  }
  return job.agentImage ?? job.bridgeImage ?? null;
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function getCurrentSessionId(options = {}) {
  if (options.sessionId) {
    return options.sessionId;
  }
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function filterJobsForCurrentSession(jobs, options = {}) {
  return filterJobsForSession(jobs, options);
}

/** Internal kind/jobClass "task" surfaces as user-facing "delegate". */
export function resolveJobKindLabel(kind, jobClass = null) {
  if (kind === "critique" || kind === "adversarial-review") {
    return "critique";
  }
  if (kind === "review" || jobClass === "review") {
    return "review";
  }
  if (kind === "task" || kind === "run" || jobClass === "task") {
    return "delegate";
  }
  return "run";
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  return resolveJobKindLabel(job.kind, job.jobClass);
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting grok") || line.startsWith("session ready") || line.startsWith("running grok")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("grok error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function getSessionRuntimeStatus() {
  return {
    mode: "plugin-owned",
    label: "plugin-owned runs",
    detail: "Runs are tracked by the Claude Code ↔ Grok Build bridge (PID + log files). There is no shared app-server broker.",
    endpoint: null
  };
}

// enqueueBackgroundJob writes a queued record before the worker spawn patches PIDs in.
// Reclaiming no-pid jobs immediately would race that window. 10 minutes is far above
// normal startup (seconds) while still clearing ghosts from a failed spawn.
const NO_PID_RECLAIM_GRACE_MS = 10 * 60 * 1000;

/**
 * If an active job's kill-target PIDs are all gone (ESRCH), claim it terminal-failed
 * as an orphan so /runs and resume-last do not block forever on dead bridges.
 * Records with no kill targets are reclaimable only after NO_PID_RECLAIM_GRACE_MS.
 * A live PID keeps the job only while the record is still being updated (age backstop
 * mirrors the lock LIVE_MAX policy — PIDs recycle). Image fingerprints strengthen
 * the decision when present.
 */
/**
 * When this record was last touched, in epoch ms, or null if truly unknowable.
 *
 * The dates on the record come first. If none of them parses — a truncated write, a
 * hand-edited file, an old schema — fall back to the job file's own mtime, which the
 * filesystem maintains whether or not the content is sane. Before this, an unparseable
 * date meant the job could never be reclaimed at all: the guard returned early every
 * time, and a record with no live pids sat at "running" indefinitely with nothing else
 * able to recover it.
 */
function resolveJobStamp(workspaceRoot, job, options = {}) {
  const fromRecord = Date.parse(job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
  if (Number.isFinite(fromRecord)) {
    return fromRecord;
  }
  if (typeof options.jobMtimeImpl === "function") {
    const injected = options.jobMtimeImpl(workspaceRoot, job.id);
    return Number.isFinite(injected) ? injected : null;
  }
  try {
    return fs.statSync(resolveJobFile(workspaceRoot, job.id)).mtimeMs;
  } catch {
    return null;
  }
}

export function reclaimOrphanedJob(workspaceRoot, job, options = {}) {
  if (!job || (job.status !== "queued" && job.status !== "running")) {
    return job;
  }
  const isGone = options.isGoneImpl ?? isProcessGone;
  const readImage = options.readImageImpl ?? readProcessImageName;
  const terminate = options.terminateImpl ?? terminateProcessTree;
  const claimTerminal = options.claimTerminalImpl ?? claimJobTerminal;
  const nowMs = options.nowMs ?? Date.now();
  const targets = resolveJobKillTargets(job);
  // True when at least one kill-target still resolves as our process but the
  // record is stale — age backstop fires while work may still be running.
  let abandonedWhileAlive = false;
  if (targets.length === 0) {
    const stamp = resolveJobStamp(workspaceRoot, job, options);
    // An unusable timestamp used to mean "never reclaim": the guard returned early, and
    // a record with no pids and no parseable date stayed running for good. That is the
    // one state nothing else recovers from, since there is no process to find dead
    // either. The file's own mtime is the fallback, and it always exists.
    if (stamp === null || nowMs - stamp < NO_PID_RECLAIM_GRACE_MS) {
      return job;
    }
  } else {
    let anyOursAlive = false;
    for (const pid of targets) {
      if (isGone(pid)) {
        continue;
      }
      const expectedImage = expectedImageForPid(job, pid);
      if (expectedImage) {
        const actual = readImage(pid);
        if (actual && !processImagesMatch(actual, expectedImage)) {
          // PID resolves but the image is not the process we tracked — recycled.
          continue;
        }
      }
      anyOursAlive = true;
      break;
    }
    if (anyOursAlive) {
      // Same shape as the lock backstop: live owner is trusted only while the
      // record is also being updated (progress / heartbeat). Without a usable
      // timestamp we cannot prove staleness, so keep the job (do not reclaim a
      // possibly-live run on missing metadata alone).
      const stamp = resolveJobStamp(workspaceRoot, job, options);
      if (stamp === null || nowMs - stamp < JOB_LIVE_STALE_MS) {
        return job;
      }
      abandonedWhileAlive = true;
    }
  }

  if (abandonedWhileAlive) {
    // Claim first, kill second. A record goes stale for two very different reasons:
    // the run really was abandoned, or progress writes are failing — which is exactly
    // what a full or unwritable state volume produces while the agent works on. Since
    // recording the decision uses that same volume, a failed claim is the signal that
    // we are the broken party, and nothing may be terminated.
    const errorMessage =
      "Abandoned: record went stale while tracked process(es) may still be running; best-effort terminate attempted.";
    let claim;
    try {
      claim = claimTerminal(workspaceRoot, job.id, "failed", {
        errorMessage,
        phase: "failed",
        // Keep kill targets so a later stop can still aim at them.
        pid: job.pid ?? null,
        agentPid: job.agentPid ?? null,
        bridgePid: job.bridgePid ?? job.companionPid ?? null,
        orphaned: true,
        abandonedWhileAlive: true,
        // Same reason as the orphan path: an abandoned run never accounted for itself,
        // so its spend is unknown rather than zero, and the ledger has to say so.
        usageIncomplete: true
      });
    } catch (error) {
      // Fail-closed is right — see above — but silent fail-closed is not. A reclaim that
      // decides to terminate nothing has just concluded that the state volume is broken
      // while an agent may be running, and that is precisely the situation someone will
      // later try to reconstruct from the log.
      try {
        appendLogLine(
          resolveTrustedJobLogFile(job),
          `Reclaim found this run stale but could not record the decision, so nothing was terminated: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } catch {
      }
      return job;
    }
    if (!claim?.claimed && claim?.reason !== "missing") {
      // Could not record the decision — most likely the same unwritable volume that
      // made the record look stale. Leave the job active and kill nothing.
      return claim?.job ?? job;
    }

    if (claim?.claimed) {
      for (const pid of targets) {
        try {
          const expectedImage = expectedImageForPid(job, pid);
          terminate(pid, expectedImage ? { expectedImage } : {});
        } catch (error) {
          // Per-pid isolation stays — one failure must not skip the rest — but the
          // failure itself gets said out loud. This is the branch that runs when a
          // process was believed abandoned AND alive; a kill that threw here is the
          // difference between "cleaned up" and "still burning quota".
          try {
            appendLogLine(
              resolveTrustedJobLogFile(job),
              `Reclaim could not terminate pid ${pid}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          } catch {
          }
        }
      }
    }

    return claim.job ?? {
      ...job,
      status: "failed",
      phase: "failed",
      errorMessage,
      orphaned: true,
      abandonedWhileAlive: true,
      // As above: the claim payload carries this flag, so the fallback has to as well.
      usageIncomplete: true
    };
  }

  // Same interlock as the abandoned branch: this runs inside runs, stop and show --wait,
  // so an unwritable state volume has to degrade to "not reclaimed this time" instead of
  // taking down every command that walks the job list.
  let claim;
  try {
    claim = claimTerminal(workspaceRoot, job.id, "failed", {
      errorMessage: "Orphaned: tracked process(es) no longer running.",
      phase: "failed",
      pid: null,
      agentPid: null,
      bridgePid: null,
      orphaned: true,
      // A reclaimed run never delivered its usage envelope — that is what "orphaned"
      // means. Without this flag collectUsage skips it entirely (no usage, no cost, not
      // flagged), so the tokens it really burned vanish from the week's total instead of
      // showing up as unknown. Measured 2026-07-28: three background runs burned real
      // tokens and moved the ledger by nothing at all.
      usageIncomplete: true
    });
  } catch {
    return job;
  }
  return claim.job ?? {
    ...job,
    status: "failed",
    phase: "failed",
    errorMessage: "Orphaned: tracked process(es) no longer running.",
    orphaned: true,
    // The claim payload sets this; the fallback must too, or a caller that trusts the
    // returned object without re-reading the record sees a reclaimed run whose spend
    // looks accounted for when it was never accounted for at all.
    usageIncomplete: true
  };
}

export function reclaimOrphanedJobs(workspaceRoot, jobs = null, options = {}) {
  const list = jobs ?? listJobs(workspaceRoot);
  return list.map((job) => reclaimOrphanedJob(workspaceRoot, job, options));
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(resolveTrustedJobLogFile(job), maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Run reference "${reference}" is ambiguous. Use a longer run id.`);
  }

  // No match is not an error here — the caller knows which subset it filtered to and can
  // say something useful. Throwing made resolveResultJob's "still running" branch dead
  // code, so asking to show an active run answered that it does not exist.
  return null;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  // Reap dead bridges first so a hard-killed run is not still classified as running —
  // a defect found by an audit of what concurrent commands do to one record. Then
  // scope: current Claude session by default, --all widens the recent slice within that
  // filter, --all-sessions drops the filter so every workspace job becomes visible.
  const listed = reclaimOrphanedJobs(workspaceRoot);
  const scoped = options.allSessions ? listed : filterJobsForCurrentSession(listed, options);
  const jobs = sortJobsNewestFirst(scoped);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const currentSessionId = getCurrentSessionId(options);

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all || options.allSessions ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(),
    currentSessionId,
    allSessions: Boolean(options.allSessions),
    // How many of this workspace's runs the session filter removed. An empty report is
    // otherwise indistinguishable from an empty workspace, and a session whose id changed
    // under it (compaction fork, resume) reads "no runs" while its own run is still going
    // — and then abandons a result it already paid for.
    hiddenBySessionFilter: Math.max(0, listed.length - scoped.length),
    running,
    latestFinished,
    recent
  };
}

/**
 * Find one explicitly named run across every workspace, reclaiming it where it lives.
 *
 * A run can legitimately sit under a different key than its cwd resolves to today:
 * resolveWorkspaceRoot answers with the git root, and an agent that runs `git init`
 * changes that answer for everyone afterwards. On 2026-07-28 three finished runs became
 * unreachable exactly this way, and "No run found" was simply false — the id was in
 * state.json the whole time. Reclaim has to run against the workspace the job actually
 * lives in, or the run reappears but still reports "running" with every pid long dead.
 *
 * Shared on purpose. The first version of this recovery lived only in
 * buildSingleJobSnapshot, so `runs <id>` found a relocated run while `show <id>` and
 * `stop <id>` still denied it existed — worse than before, because the run was now
 * visibly there and still not actionable. Only for an explicit reference; unfiltered
 * listings stay workspace-scoped so a project's runs do not bleed into each other.
 */
/**
 * Turn skipped workspaces into a sentence for a "not found" message.
 *
 * Without this the search would still be lying by omission: it reports that a run does
 * not exist while the one directory it could not read is exactly where the run might be.
 */
function describeUnreadable(result) {
  const skipped = result?.unreadable ?? [];
  if (skipped.length === 0) {
    return "";
  }
  return ` (${skipped.length} workspace${skipped.length === 1 ? "" : "s"} could not be read and were skipped: ${skipped.join("; ")})`;
}

function findJobAcrossWorkspaces(reference) {
  if (!reference) {
    return null;
  }
  // Workspaces that could not be read. Swallowing these was the sharpest defect two
  // independent review models found in this very function: the run being searched for
  // could be in exactly the directory that failed to read, and skipping it silently
  // produces "No run found" — the same false "does not exist" this function was written
  // to eliminate. The names are handed back so the caller can say so instead of lying.
  const unreadable = [];

  for (const stateDir of listWorkspaceStateDirs()) {
    let candidates;
    try {
      candidates = sortJobsNewestFirst(collectJobsFromStateDir(stateDir));
    } catch (error) {
      unreadable.push(`${stateDir} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const hit = matchJobReference(candidates, reference);
    if (!hit) {
      continue;
    }
    // No fallback to stateDir. It is the hashed state directory, not a workspace root:
    // handing it on would make resolveStateDir hash the hash, so the reclaim would target
    // a directory that does not exist and the caller would be told the run lives somewhere
    // it does not. A record without workspaceRoot is a thin index row — return it as found
    // and skip the reclaim rather than reclaim the wrong place. (Second-opinion review.)
    const workspaceRoot = hit.workspaceRoot ?? null;
    let reconciled = null;
    let reconcileFailed = false;
    try {
      reconciled = workspaceRoot
        ? matchJobReference(sortJobsNewestFirst(reclaimOrphanedJobs(workspaceRoot)), reference)
        : null;
    } catch {
      // Reclaim is what turns "running with every pid dead" into a terminal record.
      // When it fails, the record we return may still claim to be running even though
      // the run is long over — and a caller that trusts that reports "still running"
      // for a finished job forever. Flagged rather than swallowed.
      reconcileFailed = true;
    }
    return { workspaceRoot, job: reconciled ?? hit, reconcileFailed, unreadable };
  }
  return unreadable.length > 0 ? { notFound: true, unreadable } : null;
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reclaimOrphanedJobs(workspaceRoot));
  const local = matchJobReference(jobs, reference);
  const found = local ? { workspaceRoot, job: local } : findJobAcrossWorkspaces(reference);

  // `found?.job`, not `found`: the search also reports back when it had to skip an
  // unreadable workspace, and that report is truthy without carrying a job.
  if (!found?.job) {
    throw new Error(`No run found for "${reference}"${describeUnreadable(found)}. Run /grok-build:runs to inspect known runs.`);
  }

  return {
    workspaceRoot: found.workspaceRoot,
    job: enrichJob(found.job, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Run ${active.id} is still ${active.status}. Check /grok-build:runs and try again once it finishes.`);
  }

  if (reference) {
    // Same widening as `runs <id>`: a relocated run that `runs` can show must also be
    // openable, or the result is visible and unreachable at once.
    const elsewhere = findJobAcrossWorkspaces(reference);
    if (elsewhere?.job) {
      const status = elsewhere.job.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        return elsewhere;
      }
      // A non-terminal status here may simply be unverified: when the reclaim threw, the
      // record still says "running" while every process behind it may be long gone. Say
      // which it is, rather than sending the caller back to wait for a finished run.
      throw new Error(
        elsewhere.reconcileFailed
          ? `Run ${elsewhere.job.id} still reads ${status}, but its state could not be re-checked. Inspect /grok-build:runs ${elsewhere.job.id}.`
          : `Run ${elsewhere.job.id} is still ${status}. Check /grok-build:runs and try again once it finishes.`
      );
    }
    throw new Error(`No finished run found for "${reference}"${describeUnreadable(elsewhere)}. Run /grok-build:runs to inspect active runs.`);
  }

  throw new Error("No finished Grok Build runs found for this repository yet.");
}

/** Active runs, plus terminal runs that still carry kill targets (a survivor is alive). */
function isStoppableJob(job) {
  if (!job) {
    return false;
  }
  if (job.status === "queued" || job.status === "running") {
    return true;
  }
  // A terminal record keeps its kill targets in exactly one situation: the kill was tried
  // and not confirmed, so something is probably still running and the pids are the only
  // way back to it. `failed` gets there through stale reclaim, `cancelled` through stop
  // and through SessionEnd — and cancelled was missing here, which made both of those
  // deliberate "keep the pids so a later stop can reach it" decisions unreachable. There
  // was no later stop: it declined to see the job at all.
  //
  // Targets are only ever left behind unsettled (see patchStoppedJobKillTargets), so this
  // does not resurrect records whose processes are known to be gone.
  const terminalWithSurvivors = job.status === "failed" || job.status === "cancelled";
  return terminalWithSurvivors && resolveJobKillTargets(job).length > 0;
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reclaimOrphanedJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => isStoppableJob(job));

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      // A relocated run must stay stoppable. Refusing here is the worst of the three
      // failures: the agent may well still be alive, and the one command that could
      // reach it declines because the cwd resolves elsewhere today.
      const elsewhere = findJobAcrossWorkspaces(reference);
      if (elsewhere?.job && isStoppableJob(elsewhere.job)) {
        return elsewhere;
      }
      throw new Error(`No active run found for "${reference}"${describeUnreadable(elsewhere)}.`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Grok Build runs are active. Pass a run id to /grok-build:stop.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Grok Build runs to stop for this session.");
  }

  throw new Error("No active Grok Build runs to stop.");
}
