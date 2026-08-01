#!/usr/bin/env node
// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.

import fs from "node:fs";
import process from "node:process";

import { killTargetSettled, terminateProcessTree } from "./lib/process.mjs";
import {
  claimJobTerminal,
  collectJobsFromStateDir,
  listWorkspaceStateDirs,
  resolveStateDir,
  resolveTrustedJobLogFile
} from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { appendLogLine, resolveJobKillTargets, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// The host kills this hook after 30 seconds. The state lock's own deadline is far
// longer, because a waiter must outlast the reclaim thresholds — so the hook has to
// impose its own, or a wedged lock costs it the whole budget on one job.
const SESSION_END_LOCK_DEADLINE_MS = 4000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Write session env for the host. Claude Code historically sources CLAUDE_ENV_FILE
 * as shell (`export KEY='value'`). Non-bash consumers (and some Windows hosts) only
 * accept plain `KEY=value`. Emit both so either parser still sees the variable: the
 * shell line quoted, the plain line raw. Quoting both emits the same line twice, and a
 * plain reader takes the quotes as part of the value. The plain form has no quoting to
 * offer, so a value containing spaces cannot be expressed in it at all.
 * Assumption: values are single-line; newlines are collapsed to spaces.
 */
function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  const singleLine = String(value).replace(/\r?\n/g, " ");
  const quoted = shellEscape(singleLine);
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `export ${name}=${quoted}\n${name}=${singleLine}\n`,
    "utf8"
  );
}

/**
 * Cancel and kill active jobs for sessionId in one workspace, using that workspace's
 * state lock via claimJobTerminal. Never rewrites another workspace's job list.
 */
function cleanupSessionJobsInWorkspace(workspaceRoot, sessionId) {
  if (!workspaceRoot || !sessionId) {
    return;
  }

  let jobs;
  try {
    jobs = collectJobsFromStateDir(resolveStateDir(workspaceRoot));
  } catch {
    return;
  }

  const sessionJobs = jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (stillRunning) {
      // Kill first, record second — the opposite order to reclaim, and deliberately so.
      // Reclaim infers that a run was abandoned, and a failed write there is the signal
      // not to trust that inference. Here nothing is inferred: this job belongs to the
      // session that just ended, and the contract is that background work does not
      // outlive it. Recording takes the state lock, whose wait is longer than this
      // hook's whole budget, so claiming first means one wedged lock leaves the agents
      // running for good.
      const killTargets = resolveJobKillTargets(job);
      // Per-pid isolation: one failure must not skip the rest (bridgePid last-chance).
      let allDelivered = true;
      for (const pid of killTargets) {
        try {
          const expectedImage =
            job?.agentPid != null && Number(job.agentPid) === pid
              ? job.agentImage
              : job.bridgeImage;
          const outcome = terminateProcessTree(pid, expectedImage ? { expectedImage } : {});
          // Only a delivered kill, or a process that was already gone, permits dropping
          // the targets. The earlier condition required `attempted`, which excluded the
          // one case that matters most: an image mismatch returns attempted false with
          // no kill performed at all, so the pids were erased for a process still very
          // much alive. Anything that is not positively "gone or killed" counts as not
          // delivered. (Second-opinion review, 2026-07-28.)
          //
          // "Already gone" used to be decided here by `method === "taskkill"`, which was
          // right on Windows and wrong everywhere else: the ENOENT fallback reports
          // `kill` and both posix already-gone paths report `process-group`. On those, a
          // dead pid counted as a live survivor and the targets were kept forever. The
          // outcome now carries `gone` itself and stop asks the same question.
          if (!killTargetSettled(outcome)) {
            allDelivered = false;
          }
        } catch {
          allDelivered = false;
        }
      }

      try {
        claimJobTerminal(
          workspaceRoot,
          job.id,
          "cancelled",
          {
            errorMessage: allDelivered
              ? "Stopped by session end."
              : "Session ended; the kill was not confirmed and an agent may still be running.",
            phase: "cancelled",
            // The run is being killed mid-flight, so its cost envelope never arrives and
            // the ledger would otherwise book it as an exact zero. Same reasoning and
            // same condition as the stop path: a queued job with no process behind it
            // genuinely spent nothing.
            ...(job.status === "running" || killTargets.length > 0
              ? { usageIncomplete: true }
              : {}),
            // Only drop the kill targets when the kill actually landed. Otherwise the
            // record would point at nobody while a survivor of a half-walked process
            // tree keeps going, and no later stop could ever reach it. Omitting the keys
            // preserves whatever is stored; passing null erases it. (Follow-up review pass.)
            ...(allDelivered ? { pid: null, agentPid: null, bridgePid: null } : {})
          },
          // Well inside the host's 30s budget, and per job, so a contended workspace
          // still gets through its list instead of being killed on the first entry.
          { deadlineMs: SESSION_END_LOCK_DEADLINE_MS }
        );
      } catch (error) {
        // The kill above may well have succeeded while only the recording failed — a
        // wedged lock, an unwritable volume. Swallowing that left the record reading
        // "running" for a process that is already gone, with nothing anywhere saying
        // why. Reclaim corrects it eventually, but silently and outside this hook's
        // budget. The job log is the one place a person looks afterwards.
        try {
          appendLogLine(
            resolveTrustedJobLogFile(job),
            `Session end killed this run, but the outcome could not be recorded: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        } catch {
        }
      }
    }
  }

  // Deliberately NO state rewrite here. Cancelling above already persisted each job's
  // terminal status under the state lock. Writing back a job list that was read earlier
  // made saveState prune everything added in between — deleting the job file AND log of
  // runs owned by OTHER sessions while they were still going. Retention is the job of
  // the normal MAX_JOBS pruning, and keeping the records means a finished run's result
  // survives the session that produced it.
}

/**
 * Reap this session's jobs across every workspace state directory under the state root.
 * Runs started with --cwd other-repo during the session live in other state dirs; a
 * SessionEnd that only cleaned the invocation cwd left those agents running.
 */
function cleanupSessionJobs(cwd, sessionId) {
  if (!sessionId) {
    return;
  }

  const seenWorkspaces = new Set();
  // Always include the session's invocation cwd so jobs that never recorded
  // workspaceRoot (thin index rows) are still cancelled.
  if (cwd) {
    try {
      const primary = resolveWorkspaceRoot(cwd);
      seenWorkspaces.add(primary);
      cleanupSessionJobsInWorkspace(primary, sessionId);
    } catch {
    }
  }

  for (const stateDir of listWorkspaceStateDirs()) {
    let jobs;
    try {
      jobs = collectJobsFromStateDir(stateDir);
    } catch {
      continue;
    }
    for (const job of jobs) {
      if (job.sessionId !== sessionId) {
        continue;
      }
      const workspaceRoot = job.workspaceRoot;
      if (!workspaceRoot || seenWorkspaces.has(workspaceRoot)) {
        continue;
      }
      // Only claim via a workspaceRoot that actually maps back to this state dir so a
      // stale path cannot rewrite a different workspace's index.
      try {
        if (resolveStateDir(workspaceRoot) !== stateDir) {
          continue;
        }
      } catch {
        continue;
      }
      seenWorkspaces.add(workspaceRoot);
      cleanupSessionJobsInWorkspace(workspaceRoot, sessionId);
    }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
