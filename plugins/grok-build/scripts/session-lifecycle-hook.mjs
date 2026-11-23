#!/usr/bin/env node
// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { killTargetSettled, terminateProcessTree } from "./lib/process.mjs";
import {
  claimJobTerminal,
  collectJobsFromStateDir,
  listWorkspaceStateDirs,
  resolveStateDir,
  resolveTrustedJobLogFile
} from "./lib/state.mjs";
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
/** Does this line define `name`, in either the shell or the plain form? */
function isLineForVar(name, line) {
  const trimmed = line.trim();
  return trimmed.startsWith(`${name}=`) || trimmed.startsWith(`export ${name}=`);
}

/**
 * ⚠ REWRITE THIS VARIABLE'S LINES, NEVER APPEND.
 *
 * SessionStart fires on every start, resume and compaction, and Claude Code inlines the
 * WHOLE of CLAUDE_ENV_FILE into the `bash -c` argument it builds for every Bash tool call.
 * Appending grew that file without bound — measured 2026-08-06, one session had reached 57
 * copies of each variable, 15 KiB. MSYS2 bash silently truncates a `-c` argument longer than
 * 8186 characters: no error, no warning, everything past the cut simply gone. So once the
 * file crossed that line the user's command was severed and bash reported a parse error at
 * whatever innocent line the cut happened to land in.
 *
 * Six sessions on one machine were dead before the cause was found, and three of them spent
 * a day theorising, because the error names bash and not this plugin — which also means no
 * user would ever have reported it to us. The plugin was degrading its host, invisibly and
 * progressively, and only on long-lived sessions.
 *
 * Only lines for THIS variable are dropped, so a second hook sharing the file keeps its own.
 * Rewriting also repairs a file that an older build already bloated, on the next SessionStart.
 */
/**
 * The lines for ONE variable. Content only — nothing here touches the file.
 *
 * Split out of the writer so that every variable in a SessionStart can be composed into a
 * single read-modify-write (A10). The comments below are the record of three separately
 * measured shell defects and belong with the rule they justify, not with the file handling.
 */
function envBlockFor(name, value) {
  const singleLine = String(value).replace(/\r?\n/g, " ");
  const quoted = shellEscape(singleLine);
  // ⚠ ORDER IS LOAD-BEARING: the bare line FIRST, the quoted export LAST. Both forms are
  // written because two different consumers read this file — Claude Code evaluates it as shell
  // (it is inlined into every `bash -c`), and something also scans it for bare `KEY=value`,
  // which is why a test pins the plain line as unquoted. When a shell runs both, the LAST
  // assignment wins, so the unquoted one used to overwrite the correct one.
  //
  // The consequence was measured, not theorised. Live in a real session on 2026-08-09:
  //   C:\Users\<user>\.claude\projects\…\x.jsonl  arrived as  C:Users…x.jsonl
  // because unquoted bash reads every `\X` as an escape. Sourcing the two orders side by side:
  //   export-then-plain -> C:Users<user>AppDataLocalTempdata      (backslashes eaten)
  //   plain-then-export -> C:\Users\<user>\AppData\Local\Temp\data (correct)
  //
  // So the fix is the order and nothing else. Dropping the bare line would break whatever reads
  // it; quoting the bare line would hand that reader literal quote characters. Swapping costs
  // nothing and satisfies both: the scanner still finds `KEY=value`, and the shell ends up with
  // the escaped value, correctly exported to child processes.
  //
  // This matters most for CLAUDE_PLUGIN_DATA, which IS read — it is the state root. It survives
  // today only because its value happens to arrive with forward slashes; on a host that uses
  // backslashes, the old order sent every job record, log and ledger entry to a mangled path.
  // ⚠ The bare line is EVALUATED, so it is only safe for a value the shell reads as one word.
  // The dual format is inherited, and the ordering fix above made the exported value correct
  // while leaving this untouched: bash still runs the bare line FIRST, and anything in it that
  // is not a plain word takes effect before the export line repairs the variable. Measured
  // 2026-08-09 by sourcing exactly what we write:
  //   CLAUDE_PLUGIN_DATA=C:\Users\John Smith\...   -> `Smith.claudepluginsdata: command not
  //     found` on the stderr of EVERY Bash call, because the tail is run as a command
  //   CLAUDE_SESSION_ID=abc; echo INJECTED         -> INJECTED actually ran
  // A space in the user's name is enough to reach the first one, which is ordinary on Windows.
  //
  // So the bare line is now conditional. For any value that is already a single shell word —
  // every real value on a host without spaces in its paths — the file is byte for byte what it
  // was and the plain-text scanner still finds `KEY=value`. For the rest the shell keeps the
  // correct value through the quoted export and the scanner loses that one line, which is
  // strictly better than the shell executing part of it. Quoting the bare line instead was
  // rejected for the reason above: a plain reader would take the quotes as part of the value.
  //
  // ⚠ AND NOT A TRAILING BACKSLASH, even though the class otherwise admits `\`. A bare line
  // ending in one is a shell LINE CONTINUATION: it swallows the `export` line that follows and
  // is meant to be the authoritative one. `C:\Users\you\data\` is ordinary Windows path
  // spelling, and the variable this most often carries is CLAUDE_PLUGIN_DATA — the state root,
  // whose loss sends every run to an invisible temp directory that `usage`, `runs` and the
  // session-end cleanup never look at.
  //
  // ⚠ I could not reproduce the failure on this host: driving the shipped writer and reading
  // the value back from a CHILD process returned it intact under MSYS2 bash. A reviewer reports
  // reproducing it in Git Bash, and I cannot reconcile the two. The change is made anyway
  // because it costs one condition and the export-only branch handles such values correctly —
  // a trailing backslash inside single quotes is literal. Where a disagreement is unresolved
  // and one side is cheap, take the cheap side. (2026-08-09)
  const shellInert = /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(singleLine) && !singleLine.endsWith("\\");
  return shellInert
    ? `${name}=${singleLine}\nexport ${name}=${quoted}\n`
    : `export ${name}=${quoted}\n`;
}

/**
 * Write every owned variable for this event in ONE read-modify-write.
 *
 * The contract this implements is written down in `docs/env-file-invariants.md`, and the numbers
 * below refer to it. That document exists because four rounds of fixing this function each
 * produced the next defect — every fix was measured against the code it replaced rather than
 * against a stated requirement, so closing the growth opened a truncation window, closing that
 * lost the file's mode and symlink identity, and repairing those hollowed out their own test.
 *
 * ⚠ Deliberately NOT atomic, reversing 0.3.3's temp-file-and-rename. Writing in place keeps the
 * inode, so permissions (D1), symlink identity (D2) and the absence of temp debris (D3) hold by
 * construction instead of by a chmod, a realpath and a cleanup path built to repair what the
 * rename breaks — machinery whose own fallback was the only remaining way this function could
 * expose a torn read. C1, that a reader always sees valid shell, is NOT promised: no read has
 * ever been shown to overlap a write here, and the rename degraded to a truncating write in
 * exactly the contended case where a reader is plausible. What would settle it is measurement,
 * tracked as #57; if it is ever demonstrated, rename is the way back.
 */
export function writeEnvVars(entries) {
  const file = process.env.CLAUDE_ENV_FILE;
  // A8: a null or empty value is not a request to clear anything, so those pairs drop out and
  // whatever the file already holds for them stays. Removing a variable would have to be asked
  // for explicitly; nothing asks today.
  const pairs = (entries ?? []).filter(([, value]) => value != null && value !== "");
  if (!file || pairs.length === 0) {
    return;
  }

  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // B1: only "not there yet" may be read as empty. What follows replaces the whole file, so
      // treating a transient EBUSY or EACCES as "it was empty" would erase every line in it,
      // including the ones other tools keep here.
      //
      // ⚠ B2: and it must SAY so. This path was silent until 2026-08-11, which made it the
      // third separately-discovered silent failure in this one function — the invariant list
      // caught it as a contradiction between B1 and B2 rather than as a bug report.
      try {
        process.stderr.write(
          `[grok-cc] Warning: could not read ${file} (${error?.code ?? "unknown"}); ` +
            "this SessionStart did not update the variables, and any previous values are still in place.\n"
        );
      } catch {
      }
      return;
    }
    existing = "";
  }

  // Drop exactly one trailing empty, the artefact of the split. Dropping every blank instead
  // would delete blank lines another hook wrote into a file we share.
  const lines = existing.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const isOurs = (line) => pairs.some(([name]) => isLineForVar(name, line));
  const kept = lines.filter((line) => !isOurs(line));

  // ⚠ A2b: put the block back where our first line already was, rather than at the end.
  // Appending looks tidier and silently reorders: a line another hook wrote AFTER ours moves in
  // front of it on the next session start, every session start. `at` is a valid index into
  // `kept` because every line before the first of ours is, by definition, kept.
  const firstOurs = lines.findIndex(isOurs);
  const at = firstOurs === -1 ? kept.length : firstOurs;

  const blockLines = pairs.map(([name, value]) => envBlockFor(name, value)).join("").split("\n");
  blockLines.pop();
  const next = `${[...kept.slice(0, at), ...blockLines, ...kept.slice(at)].join("\n")}\n`;

  // F1: SessionStart also fires on resume and on compaction, where the values are usually the
  // ones already in the file. Rewriting then costs a truncation window and an mtime change to
  // produce identical bytes. Comparing the whole computed result is what makes this exact —
  // comparing values one at a time would miss a file whose layout differs from ours.
  if (next === existing) {
    return;
  }

  try {
    fs.writeFileSync(file, next, "utf8");
  } catch (error) {
    // B4: never rethrow. This is called unguarded from handleSessionStart, so a throw exits the
    // hook non-zero and skips whatever else it had to do. B2: say what happened — "did not
    // update" rather than "is unset", because describing the variables as absent is worse than
    // describing them as stale. Do not claim the previous values survived: writeFileSync opens
    // with O_TRUNC, so a failed write after a successful open may already have emptied the file.
    try {
      process.stderr.write(
        `[grok-cc] Warning: could not write ${file} (${error?.code ?? "unknown"}); ` +
          "this SessionStart did not update the variables. The file may be empty or partial.\n"
      );
    } catch {
    }
  }
}

/**
 * One variable, for callers that only have one. Everything a single SessionStart writes should
 * go through `writeEnvVars` in one call instead (A10) — one read, one write, and no moment in
 * which a reader can see one variable updated and another not.
 */
export function appendEnvVar(name, value) {
  writeEnvVars([[name, value]]);
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

/**
 * Tell the user a newer version exists — or say nothing at all.
 *
 * ⚠ THE ORDERING IN handleSessionStart IS NOT NEGOTIABLE, and this is why it lives after the
 * two appendEnvVar calls rather than before them. Any blocking work placed in front of them puts
 * the host's 5-second kill inside a write to CLAUDE_ENV_FILE, which can leave it empty and
 * destroy lines other hooks wrote. That is the 0.3.2 defect's twin, and it would be
 * self-inflicted by the very feature meant to warn people about the first one.
 *
 * ⚠ The mechanism named here has changed twice. It once said this ended in a writeFileSync
 * and therefore O_TRUNC; then that the success path ended in a rename. Both are now wrong:
 * the writer is in place again, and it skips entirely when nothing changed. The ORDERING
 * argument is what survives all three and is the only reason this comment exists — a kill
 * during the write still costs this SessionStart its variables, whatever the write is.
 */
async function maybeEmitUpdateNotice() {
  const mod = await import("./lib/version-check.mjs");
  if (mod.isUpdateCheckDisabled(process.env)) return;

  const running = mod.resolveRunningVersion(import.meta.url);
  if (!running) return;

  const { cache } = await mod.readCacheBounded(mod.CACHE_READ_BUDGET_MS);
  const notice = mod.buildUpdateNotice(mod.evaluateUpdateState(cache, running));
  if (!notice) return;

  // Only `systemMessage`, which Claude Code shows to the USER. Deliberately NOT
  // hookSpecificOutput.additionalContext: that would pipe the contents of a file living under a
  // possibly world-writable state root straight into Claude's context on every session start,
  // which is prompt injection with extra steps.
  process.stdout.write(JSON.stringify({ systemMessage: notice }));
}

export async function handleSessionStart(input) {
  // ⚠ GROK_CC_TRANSCRIPT_PATH was written here until 0.3.3 and is gone. Nothing read it: its
  // only consumer was `/grok-build:import`, removed in 0eed7ce, and it outlived the command by
  // two releases. It was not free — every variable costs TWO lines per SessionStart in a file
  // that Claude Code inlines into every Bash call, and this hook's unbounded growth of that
  // file is what broke people's shells in 0.3.2. Dropping it takes a third off what we write.
  //
  // It was also the one value provably damaged in transit: measured 2026-08-09 in a live
  // session, `C:\Users\…\x.jsonl` arrived as `C:Users…x.jsonl`. See R14 for the remaining half
  // of that — the plain unquoted line still endangers CLAUDE_PLUGIN_DATA on a host whose value
  // carries backslashes.
  // A10: one read, one write, for every variable this event owns. Two separate calls meant two
  // read-modify-write cycles per SessionStart — twice the exposure, and a moment in between
  // where a reader could see the session id updated and the state root not.
  writeEnvVars([
    [SESSION_ID_ENV, input.session_id],
    [PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]]
  ]);

  // Resume and compaction fire this hook too. A version notice is worth one line per real
  // session, not one per compaction.
  const source = input.source;
  if (typeof source === "string" && !["startup", "clear"].includes(source)) return;

  try {
    await maybeEmitUpdateNotice();
  } catch {
  }
}

/**
 * Refresh the cached release version. SessionEnd, because it has a 30-second budget and nobody
 * is waiting on its result — the notice it enables is read by the NEXT session's start.
 *
 * ⚠ Strictly after cleanupSessionJobs, and gated on the time already spent. Reaping is what
 * stops background agents outliving their session, and it takes locks with a per-job deadline;
 * a network call in front of it can eat the budget and leave agents running. So the fetch only
 * happens if reaping left room, and it is skipped rather than rushed.
 *
 * The user learns one session late. That is the correct trade against touching SessionStart's
 * 5-second budget, and it is stated here so nobody later "fixes" it into the start path.
 */
async function maybeRefreshUpdateCache(startedAt) {
  const mod = await import("./lib/version-check.mjs");
  if (mod.isUpdateCheckDisabled(process.env)) return;
  if (Date.now() - startedAt > mod.SESSION_END_FETCH_CUTOFF_MS) return;

  const { cache } = await mod.readCacheBounded(1000);
  if (!mod.isFetchDue(cache, Date.now())) return;

  const running = mod.resolveRunningVersion(import.meta.url);
  const result = await mod.fetchLatestVersion({ timeoutMs: mod.FETCH_TIMEOUT_MS, running });
  const next = mod.recordFetchResult(cache, result, Date.now());
  const { writeFileAtomic } = await import("./lib/state.mjs");
  writeFileAtomic(mod.resolveUpdateCacheFile(), `${JSON.stringify(next, null, 2)}\n`);
}

async function handleSessionEnd(input, startedAt) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  try {
    await maybeRefreshUpdateCache(startedAt);
  } catch {
  }
}

async function main() {
  // Grok 1.0.52 runs this hook inside every bridge-launched session
  // (measured 2026-10-15). SessionEnd falls back to GROK_CC_SESSION_ID, the Claude
  // session id, when the payload has no session_id, which would cancel every active
  // job of that session. The grok child sets the marker (lib/grok.mjs). Exit before
  // any read, write or update check.
  if (process.env.GROK_CC_BRIDGE_CHILD === "1") {
    process.exit(0);
  }
  const startedAt = Date.now();
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    await handleSessionStart(input);
    // ⚠ Exit explicitly. The bounded cache read leaves a losing fs.promises.readFile pending,
    // and that keeps the event loop referenced for as long as the kernel holds the handle —
    // measured at 21 seconds against an unroutable path. Without this the process lingers until
    // the host kills it at 5 seconds and charges that latency to EVERY session start.
    // ⚠ Exit only once stdout has actually drained. The empty write's callback fires after
    // everything queued ahead of it, so it IS the drain signal — but the 200 ms fallback used
    // to race it, and `process.exit` tears down without flushing. On a slow or busy pipe the
    // timer won, and the JSON notice reached Claude Code truncated or not at all: the one
    // message this hook exists to deliver, lost exactly when the host was under load.
    //
    // The fallback still exists, because the reason for it is real — a losing
    // fs.promises.readFile keeps the loop referenced for as long as the kernel holds the
    // handle, measured at 21 seconds against an unroutable path. It is now long enough not to
    // pre-empt a healthy flush, and it is cancelled the moment the drain lands.
    const bail = setTimeout(() => process.exit(0), 2000);
    bail.unref();
    process.stdout.write("", () => {
      clearTimeout(bail);
      process.exit(0);
    });
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input, startedAt);
  }
}

// ⚠ Run the hook only when this file IS the process entry point. Without this it ran on mere
// import, so anything importing `appendEnvVar` — a test, a probe — started the whole hook,
// which then blocked reading a stdin that was never going to deliver a payload. That is why
// the existing shell-safety tests drive this module through spawned subprocesses instead of
// importing it: the obstacle was being routed around rather than named. Found 2026-08-09 when
// a directly-imported test hung for ninety seconds.
//
// ⚠ Compare against the REALPATH, not `path.resolve` alone. `path.resolve` normalises but does
// not resolve links, while `import.meta.url` is the realpath Node loaded — so behind a symlink
// or a Windows junction the two differ, the guard reads false, and the hook silently does
// nothing on every SessionStart. That is exactly the shape that made `grok-bridge.mjs`
// exit 0 having done nothing, and it is far worse here than the hang it replaces: a hook that
// no-ops leaves CLAUDE_PLUGIN_DATA unset and every run billing to an invisible state root.
// `path.resolve` stays only as the fallback for a path that cannot be realpath'd at all.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    // ⚠ FAIL OPEN, matching the rule stated below rather than contradicting it. This returned
    // false — the one outcome the policy three paragraphs down calls unacceptable, because a
    // hook that no-ops leaves CLAUDE_PLUGIN_DATA unset and every run billing to an invisible
    // state root. An absent argv[1] means we cannot classify the invocation, and "cannot
    // classify" must behave like "this is the entry point": a redundant run inside a test costs
    // nothing, a silent no-op in production costs everything. Found by a code review 2026-08-09
    // reading the comment against the code.
    return true;
  }
  const canonical = (target) => {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  try {
    return canonical(entry) === canonical(fileURLToPath(import.meta.url));
  } catch {
    // An entry we cannot classify must still run the hook: failing open costs a redundant run
    // in a test, while failing closed costs a silent no-op in production.
    return true;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
