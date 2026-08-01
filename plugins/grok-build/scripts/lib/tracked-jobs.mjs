// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { readProcessImageName } from "./process.mjs";
import {
  claimJobTerminal,
  isTerminalJobStatus,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "GROK_CC_SESSION_ID";

/**
 * How long a progress write may wait for the state lock.
 *
 * withStateLock waits synchronously (`Atomics.wait` in a plain retry loop), so nothing
 * else on the event loop runs while it waits — including the wall-clock timeout timer of
 * the run whose progress is being written. The default deadline is 210 seconds, sized so
 * a waiter outlasts the reclaim thresholds; inherited here it would let a contended lock
 * hold a run's own deadline hostage for minutes. One second is generous for a critical
 * section measured in milliseconds, and losing a progress line is cheap — it is best
 * effort, and since the fix that logs write failures it is logged rather than swallowed.
 */
const PROGRESS_LOCK_DEADLINE_MS = 1000;

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const agentPidRaw = value.agentPid ?? null;
    const agentPid = Number.isFinite(Number(agentPidRaw)) ? Number(agentPidRaw) : null;
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      agentPid,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    agentPid: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

/**
 * Redact common secret-shaped tokens before they hit durable logs.
 *
 * The assignment pattern lists `KEY` on its own, not only `API_KEY`. SECURITY.md promises
 * that `KEY=` is redacted, and it was not: the alternation required the literal `API`
 * first, so a plain `KEY=…` — the shortest and most likely spelling anyone actually
 * writes — passed through untouched. Found on 2026-07-31 by an audit that finally had the
 * runtime code in front of it, after four earlier auditors had said they could not check
 * this because they had only the documentation.
 *
 * The surrounding `[A-Za-z0-9_]*` makes this deliberately over-eager: `MONKEY=banana` is
 * redacted too. That is the right direction to be wrong in. A redacted log line costs
 * somebody a moment of confusion; an unredacted one cannot be taken back once it is in a
 * bug report.
 */
export function scrubSecrets(text) {
  return String(text ?? "")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "sk-[REDACTED]")
    .replace(/\b(xai-[A-Za-z0-9_-]{8,})\b/g, "xai-[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-+=/]{8,}/gi, "$1[REDACTED]")
    .replace(
      /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]"
    );
}

export function appendLogLine(logFile, message) {
  const normalized = scrubSecrets(String(message ?? "").trim());
  if (!logFile || !normalized) {
    return;
  }
  // Progress logging is best-effort: a full disk or revoked ACL must not kill the run.
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
  }
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  const safeBody = scrubSecrets(String(body).trimEnd());
  const safeTitle = scrubSecrets(title);
  try {
    fs.appendFileSync(logFile, `\n[${nowIso()}] ${safeTitle}\n${safeBody}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {
  }
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
  }
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId, options = {}) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastAgentPid = null;
  let lastMessage = null;
  // Write failures used to vanish into a bare catch. A record that stops being updated
  // while the log keeps growing is exactly the shape of a run nobody can account for
  // afterwards, and the silence made it look like nothing had gone wrong. Said once,
  // never repeated: a persistently unwritable state volume must not flood the log it
  // is trying to warn about, and the log may well be on that same volume.
  let saidOnce = false;
  let suppressed = 0;
  const noteFailure = (error) => {
    suppressed += 1;
    if (saidOnce || !options.logFile) {
      return;
    }
    saidOnce = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendLogLine(
        options.logFile,
        `Progress could not be recorded on the job (further failures are not repeated): ${message}`
      );
    } catch {
    }
  };

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = {};
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.agentPid && normalized.agentPid !== lastAgentPid) {
      lastAgentPid = normalized.agentPid;
      patch.agentPid = normalized.agentPid;
      // Best-effort image fingerprint so stop can refuse to kill a recycled PID.
      //
      // When the probe cannot answer, say so on the record rather than leaving the field
      // absent. Absent is ambiguous: it is also what a record written before images were
      // recorded looks like, and the two get treated identically — `stop` falls back to
      // "any node or grok process", which on a developer machine is a weak fingerprint.
      // Whoever reads the record afterwards deserves to know which of the two it was.
      // The kill policy is unchanged and deliberate: a probe that cannot read the image
      // still allows the kill, because a run that cannot be stopped is the worse failure
      // for a tool that spends money. This makes that choice observable, not different.
      const image = readProcessImageName(normalized.agentPid);
      if (image) {
        patch.agentImage = image;
      } else {
        patch.agentImageProbe = "unavailable";
      }
      changed = true;
    }

    const message = normalized.message || normalized.stderrMessage;
    if (message) {
      // Scrub first, then truncate: cutting a token in half must not defeat redaction.
      // Same treatment as appendLogLine so the .json next to the .log never holds a raw key.
      const scrubbed = scrubSecrets(message);
      const preview = scrubbed.length > 240 ? `${scrubbed.slice(0, 237)}...` : scrubbed;
      if (preview && preview !== lastMessage) {
        // Keep a short preview on the job record so `runs` can show live progress without
        // re-reading the full log for every line.
        lastMessage = preview;
        patch.lastMessage = lastMessage;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    // Job-record progress is best-effort, same as log lines: never fail the run over it.
    // Best-effort is not the same as silent, though — say so once.
    try {
      // Short deadline on purpose. withStateLock waits synchronously, so a contended
      // lock here would hold the event loop — and with it the wall-clock timeout timer
      // of the very run this line is reporting on. A progress line is worth far less
      // than the deadline the run promised, so give up quickly and say so.
      patchJobIfActive(workspaceRoot, jobId, patch, { deadlineMs: PROGRESS_LOCK_DEADLINE_MS });
    } catch (error) {
      noteFailure(error);
    }
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      // Scrubbed like the log and the job record, and for a better reason than either:
      // this text comes off the CLI's own stderr (`grok.mjs`, one progress line per
      // newline), so it is vendor output rather than something the bridge composed. The
      // durable surfaces were redacted and the console was not — which is backwards, since
      // the console is the surface that ends up pasted into a bug report.
      process.stderr.write(`[grok-cc] ${scrubSecrets(stderrMessage)}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function resolveJobKillTargets(job = {}) {
  const targets = [];
  const seen = new Set();
  // Agent first: it is the process doing the work and the one that outlives a half-walked
  // tree, so it is the target worth reaching before the bridge. bridgePid then, with the
  // legacy companionPid accepted for run records written before the rename. (The comment
  // here read "Prefer bridgePid" and had done since before the order was agent-first.)
  for (const value of [job.agentPid, job.bridgePid, job.companionPid, job.pid]) {
    if (value == null || value === "") {
      continue;
    }
    const pid = Number(value);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    targets.push(pid);
  }
  return targets;
}

export async function runTrackedJob(job, runner, options = {}) {
  const bridgePid = process.pid;
  // Injectable so a test can exercise the unwritable-state path without a full disk.
  const claimTerminal = options.claimTerminalImpl ?? claimJobTerminal;
  // Always derive the log path from the job id when a workspace is known — never trust
  // a disk-supplied path that could point outside the jobs directory.
  //
  // This variable is the ONLY log path this function may use. Every claim, append and
  // patch below reads it. The first version of this fix computed it here and then left
  // nine downstream sites on `options.logFile ?? job.logFile ?? null`, so the derived
  // value governed the running patch and the stored one still governed every write that
  // matters — the error paths. Grok's verification of the fix found it (2026-07-31); the
  // accompanying test did not, because it grepped two files and not this one.
  const logFile =
    options.logFile ??
    // No fallback to the stored value. It reached here from state.json, which on the temp
    // state root is not a place only we can write, and everything downstream treats this
    // as a path to append to. Derived or nothing — the callers all handle a null log.
    (job.workspaceRoot && job.id ? resolveJobLogFile(job.workspaceRoot, job.id) : null);
  const bridgeImage = path.basename(process.execPath);
  const runningPatch = {
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    bridgePid,
    bridgeImage,
    pid: bridgePid,
    agentPid: job.agentPid ?? null,
    logFile
  };

  const activated = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
  if (!activated.patched) {
    if (activated.reason === "missing") {
      writeJobFile(job.workspaceRoot, job.id, {
        ...job,
        ...runningPatch,
        id: job.id
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        ...runningPatch,
        kind: job.kind,
        kindLabel: job.kindLabel,
        title: job.title,
        jobClass: job.jobClass,
        summary: job.summary,
        write: job.write,
        sessionId: job.sessionId
      });
      const recheck = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
      if (!recheck.patched && isTerminalJobStatus(recheck.status)) {
        return {
          exitStatus: 1,
          threadId: recheck.job?.threadId ?? null,
          turnId: null,
          payload: recheck.job?.result ?? { status: recheck.status },
          rendered: recheck.job?.rendered ?? `Run ${job.id} is already ${recheck.status}.\n`,
          summary: recheck.job?.summary ?? recheck.status,
          cancelled: recheck.status === "cancelled",
          pruned: false,
          alreadyTerminal: true
        };
      }
    } else if (isTerminalJobStatus(activated.status)) {
      return {
        exitStatus: 1,
        threadId: activated.job?.threadId ?? null,
        turnId: null,
        payload: activated.job?.result ?? { status: activated.status },
        rendered: activated.job?.rendered ?? `Run ${job.id} is already ${activated.status}.\n`,
        summary: activated.job?.summary ?? activated.status,
        cancelled: activated.status === "cancelled",
        pruned: false,
        alreadyTerminal: true
      };
    }
  }

  // Whether some path already recorded a terminal outcome. The finally below is the
  // backstop for the paths nobody thought of.
  let terminalClaimed = false;
  // The original failure, when recording it threw. Carried to the backstop so the record
  // says what went wrong rather than only that nothing was written.
  let unrecordedFailure = null;

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    let claim;
    try {
      claim = claimTerminal(job.workspaceRoot, job.id, completionStatus, {
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        result: execution.payload,
        rendered: execution.rendered,
        // Kept on the record itself so a local budget report never has to reopen or
        // retain full result payloads.
        usage: execution.payload?.usage ?? null,
        costUsd: typeof execution.payload?.costUsd === "number" ? execution.payload.costUsd : null,
        costTicks: Number.isInteger(execution.payload?.costTicks) ? execution.payload.costTicks : null,
        usageIncomplete: execution.payload?.usageIncomplete === true,
        bridgePid,
        // Clearing the kill targets is right when the agent is gone, and wrong when it
        // might not be. A wall-clock timeout kills the process tree, but that kill is
        // not guaranteed to land: on Windows the tree walk runs under a bound and can
        // be cut off, which terminateProcessTree reports as method "kill-partial" — one
        // pid signalled, the tree not. Nulling agentPid in that case points the record
        // at nobody, and `stop` can never reach a survivor afterwards. Keeping a pid
        // that is in fact dead costs nothing: every consumer tests liveness first, and
        // the image fingerprint guards against a recycled pid. Losing a live one is
        // permanent, so the asymmetry decides it.
        // On a timeout, OMIT these keys rather than pass a value. claimJobTerminal merges
        // the patch onto the record it reads under the lock, so an omitted key keeps
        // whatever is stored — and the stored value is the only true one: agentPid is
        // written to the RECORD by the progress updater and never onto this in-memory
        // job object. The first version of this passed `job.agentPid ?? null`, which is
        // always null, so it read like a fix and changed nothing. Found by a follow-up
        // review pass, hours after it shipped with a confident commit message.
        ...(execution.payload?.timedOut ? {} : { agentPid: null, pid: null }),
        phase: completionStatus === "completed" ? "done" : "failed",
        logFile
      });
      // The ordinary path recorded an outcome; the finally backstop must stay out of it.
      //
      // Set regardless of claim.claimed, and that is deliberate rather than an oversight
      // (it has been read as one). The claim only declines when the record is ALREADY
      // terminal — cancelled won, another writer got there first — or when it is missing
      // because retention removed it. The backstop exists for exactly one condition, a
      // record left sitting on "running", and none of those are it. Running it anyway
      // would try to write "failed" over an outcome that is already correct.
      terminalClaimed = true;
    } catch (error) {
      // The work succeeded; only recording it failed — a full or read-only state volume.
      // Throwing here would discard a finished result the caller is still waiting for and
      // leave the record claiming the run is going. Hand the result back and say plainly
      // that it could not be stored.
      //
      // And keep the backstop out of it. Without this the finally below would see an
      // unclaimed run and record "failed" over a run that actually SUCCEEDED and merely
      // could not be written down — turning a storage problem into a wrong outcome. The
      // backstop exists for paths that recorded nothing and know nothing; this path knows
      // exactly what happened and has already said so. (Follow-up review pass.)
      terminalClaimed = true;
      const message = error instanceof Error ? error.message : String(error);
      appendLogLine(
        logFile,
        `Result could not be recorded: ${message}`
      );
      // Put it where the caller actually looks: the JSON payload and the printed text.
      // A flag that only exists on the internal return value tells nobody anything, and
      // the job log lives on the volume that just failed.
      const notice = `Result could not be recorded (${message}). The answer above is complete; only the stored copy is missing.`;
      const rendered = execution.rendered
        ? `${execution.rendered.replace(/\n*$/, "")}\n\n${notice}\n`
        : `${notice}\n`;
      return {
        ...execution,
        payload: {
          ...(execution.payload ?? {}),
          persisted: false,
          persistError: message
        },
        rendered,
        persisted: false,
        persistError: message
      };
    }

    if (!claim.claimed && claim.status === "cancelled") {
      claimTerminal(job.workspaceRoot, job.id, "cancelled", {
        threadId: execution.threadId ?? claim.job?.threadId ?? null,
        turnId: execution.turnId ?? claim.job?.turnId ?? null,
        summary: claim.job?.summary ?? execution.summary,
        result: claim.job?.result ?? execution.payload,
        rendered: claim.job?.rendered ?? execution.rendered,
        partialResult: execution.payload,
        // OMIT the pid keys rather than null them, for the same reason the timeout branch
        // does. Reaching here means stop won the claim while this worker was finishing, and
        // stop's own sequence is: null the pids, kill, and — when the kill was attempted but
        // NOT delivered — put the survivor's pids back so somebody can still aim at it. This
        // write lands after all of that. Nulling here erased exactly the restore that was
        // just performed, and left the one record that knew a live agent's pid pointing at
        // nobody. claimJobTerminal preserves an omitted key, so leaving them out is what
        // "do not touch what stop decided" looks like.
        logFile
      });
      appendLogBlock(logFile, "Final output (after cancel)", execution.rendered);
      return {
        ...execution,
        cancelled: true
      };
    }

    if (!claim.claimed && claim.reason === "missing") {
      appendLogBlock(logFile, "Final output (run missing)", execution.rendered);
      return {
        ...execution,
        pruned: true
      };
    }

    appendLogBlock(logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // The claim itself can throw — an unwritable state volume is a common reason for
    // the run to have failed in the first place. Unguarded, that replaced the real
    // error with a storage error AND left the record non-terminal, which is the state
    // a caller waits on forever.
    try {
      claimTerminal(job.workspaceRoot, job.id, "failed", {
        errorMessage,
        bridgePid: null,
        // Kill targets stay: an exception mid-run is exactly when an agent may have been
        // spawned and then orphaned, and pointing the record at nobody puts a survivor
        // permanently out of stop's reach. Keeping them costs nothing, because every
        // consumer tests liveness first and the image fingerprint guards recycling.
        //
        // OMIT the keys — do not pass `job.agentPid ?? null`. agentPid is written to the
        // disk record by the progress updater and never onto this in-memory object, so
        // that expression is always null and would erase the very value it means to keep.
        // Since the change that made claimJobTerminal merge onto the stored record, an
        // omitted key is preserved, and leaving them out is what "keep" actually looks
        // like.
        phase: "failed",
        logFile
      });
      terminalClaimed = true;
    } catch (claimError) {
      const claimMessage = claimError instanceof Error ? claimError.message : String(claimError);
      // Hand the real cause to the backstop below. Without it, a storage hiccup on this
      // one write turned the record's explanation into "Run ended without recording an
      // outcome" — true, uninformative, and the opposite of what this catch is for.
      unrecordedFailure = errorMessage;
      try {
        appendLogLine(
          logFile,
          `Failure could not be recorded on the job: ${claimMessage}`
        );
      } catch {
      }
    }
    throw error;
  } finally {
    // Last line of defence. Every ordinary path above claims terminal, but "every path
    // I thought of" is how a record ends up stuck on running — which is precisely what
    // stranded three finished runs on 2026-07-28 and made a caller poll for 25 minutes.
    // A hard kill still cannot be caught here, and reclaim remains the answer for that.
    if (!terminalClaimed) {
      try {
        claimTerminal(job.workspaceRoot, job.id, "failed", {
          errorMessage: unrecordedFailure
            ? `Run failed and the outcome could not be recorded on the first attempt: ${unrecordedFailure}`
            : "Run ended without recording an outcome.",
          phase: "failed",
          // Omitted, not nulled — same reason as the catch above: the in-memory job never
          // carries agentPid, so passing it erases the stored one.
          bridgePid: null,
          logFile
        });
      } catch {
      }
    }
  }
}

export { isTerminalJobStatus, claimJobTerminal, patchJobIfActive };
