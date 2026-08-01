// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessGone } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// Namespaced per user: on a shared temp root, unrelated users must not be able to
// read, steal or delete each other's locks, slot files and run state.
function currentUserSuffix() {
  try {
    const name = os.userInfo().username;
    const slug = String(name ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return slug ? `-${slug}` : "";
  } catch {
    return "";
  }
}
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), `grok-cc-runs${currentUserSuffix()}`);
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

function resolveBridgePidField(existing = {}, patch = {}) {
  if (patch.bridgePid !== undefined) {
    return patch.bridgePid;
  }
  if (patch.companionPid !== undefined) {
    return patch.companionPid;
  }
  return existing.bridgePid ?? existing.companionPid ?? null;
}

export function resolveStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
}

/**
 * Where this process keeps its run records, and whether that is the shared location.
 *
 * The fallback is deliberate — the bridge has to work when nobody set the variable — but
 * its silence was not. Claude Code sets CLAUDE_PLUGIN_DATA for the plugin; a bridge
 * started from a plain shell does not have it, and its runs then land somewhere nothing
 * else looks: not `runs`, not the spend ledger, and — the one that matters — not the
 * SessionEnd reaping that is supposed to stop background agents outliving their session.
 * An agent started that way is never collected by anything.
 *
 * Measured on 2026-07-31: two waiters polled the shared root for forty minutes while
 * their finished runs sat in the fallback, and that real spend was missing from the ledger
 * altogether. None of it was visible at the time, because nothing said a word.
 */
export function describeStateRootOrigin(env = process.env) {
  const pluginDataDir = env[PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    return {
      root: path.join(pluginDataDir, "state"),
      source: "plugin-data",
      disclosure: null
    };
  }
  return {
    root: FALLBACK_STATE_ROOT_DIR,
    source: "fallback",
    disclosure:
      `${PLUGIN_DATA_ENV} is not set, so this run is recorded under ${FALLBACK_STATE_ROOT_DIR} ` +
      "instead of the shared plugin state. Runs kept there are invisible to /grok-build:runs, " +
      "to the spend ledger, and to the SessionEnd cleanup that stops background agents — " +
      `set ${PLUGIN_DATA_ENV} before calling the bridge from a foreign shell.`
  };
}

/**
 * Every per-workspace state directory under the state root (excludes global-slots).
 * Used by SessionEnd to reap this session's jobs across workspaces that were started
 * with --cwd pointing elsewhere during the same Claude session.
 */
export function listWorkspaceStateDirs() {
  const root = resolveStateRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SLOTS_DIR_NAME) {
      continue;
    }
    const dir = path.join(root, entry.name);
    // A jobs/ directory counts as well. Requiring state.json alone made a workspace
    // invisible to every cross-workspace consumer — SessionEnd's reaping, the relocation
    // lookup, the ledger — in exactly the case where visibility matters most: the index
    // was corrupt and its repair had failed, so the job records were on disk and nothing
    // was going to look at them.
    if (
      fs.existsSync(path.join(dir, STATE_FILE_NAME)) ||
      fs.existsSync(path.join(dir, JOBS_DIR_NAME))
    ) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Collect job records from a workspace state directory (index + on-disk job files).
 * Job files win on field merge so workspaceRoot/logFile/pids survive a thin index.
 */
export function collectJobsFromStateDir(stateDir) {
  const byId = new Map();
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      for (const job of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
        if (job?.id) {
          byId.set(job.id, { ...job });
        }
      }
    } catch {
    }
  }
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  if (fs.existsSync(jobsDir)) {
    let names;
    try {
      names = fs.readdirSync(jobsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const fullPath = path.join(jobsDir, name);
      try {
        // Use the shared reader so corrupt files surface as damaged, not vanish.
        const job = readJobFile(fullPath);
        if (job?.id) {
          byId.set(job.id, { ...(byId.get(job.id) ?? {}), ...job });
        }
      } catch {
      }
    }
  }
  return [...byId.values()];
}

function stateDirForPath(root) {
  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {
    canonical = root;
  }
  const slugSource = path.basename(root) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

/**
 * Where this workspace's state lives.
 *
 * Sticky on purpose. The identity comes from resolveWorkspaceRoot, which answers with
 * the git root — and that answer is not stable over the life of a run: a --write agent
 * that runs `git init` at or above its cwd moves it. Measured 2026-07-28: three
 * background runs were created under `<cwd>` while no repository existed, the agent
 * created one 43 seconds in, and from then on every write — progress, and above all the
 * terminal claim — addressed the parent's directory instead. The records stayed
 * "running" forever, no reader could find them by id, and three finished results sat
 * unnoticed on disk. Nothing malicious; the agent had simply been asked to set up a
 * project.
 *
 * So: a state directory that already exists for the path as given wins over deriving a
 * new one. A run keeps the home it was created in, whatever git does around it. New
 * workspaces are unaffected — nothing exists for them yet, and they resolve as before.
 */
export function resolveStateDir(cwd) {
  const direct = stateDirForPath(cwd);
  if (fs.existsSync(direct)) {
    return direct;
  }
  return stateDirForPath(resolveWorkspaceRoot(cwd));
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// Restrictive mode for state/jobs/logs on POSIX; Windows ignores mode bits but still
// keeps the files under the per-user plugin data / temp root.
const STATE_FILE_MODE = 0o600;
const RENAME_RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
const RENAME_MAX_ATTEMPTS = 8;

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: STATE_FILE_MODE });
  try {
    fs.chmodSync(tempPath, STATE_FILE_MODE);
  } catch {
  }
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      try {
        fs.chmodSync(filePath, STATE_FILE_MODE);
      } catch {
      }
      return;
    } catch (error) {
      lastError = error;
      if (!RENAME_RETRYABLE_CODES.has(error?.code) || attempt === RENAME_MAX_ATTEMPTS - 1) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
        }
        throw error;
      }
      sleepMs(20 + attempt * 15);
    }
  }
  try {
    fs.unlinkSync(tempPath);
  } catch {
  }
  throw lastError ?? new Error(`Failed to rename ${tempPath} to ${filePath}`);
}

// On Windows, contended open/unlink of the lock file surfaces not only as EEXIST but
// also as EPERM/EACCES/EBUSY (racing unlink, AV scanners). All of these are transient
// and must be retried, not thrown — a thrown EPERM was killing concurrent runs outright.
const LOCK_RETRYABLE_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
// The acquisition deadline MUST exceed the staleness threshold: otherwise a waiter can
// time out before it is ever allowed to reclaim a lock orphaned by a crashed holder.
// Reclaim thresholds. Liveness decides first; age is only a backstop:
//  - ORPHAN: lock file carries no usable owner (holder died before writing its token).
//  - LIVE_MAX: the recorded pid still resolves, but the lock is far older than any
//    legitimate critical section (these are a few file writes, i.e. milliseconds).
//    Without this ceiling a hard-killed holder whose pid gets RECYCLED by an unrelated
//    long-lived process would wedge the workspace permanently.
// The acquisition deadline must exceed BOTH thresholds, otherwise a waiter can give up
// before it is ever allowed to reclaim a lock it is entitled to take.
const LOCK_ORPHAN_MS = 120000;
const LOCK_LIVE_MAX_MS = 180000;
const LOCK_DEADLINE_MS = 210000;
const LOCK_BACKOFF_MIN_MS = 40;
const LOCK_BACKOFF_JITTER_MS = 80;

function readHolderToken(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

function holderPidFromToken(token) {
  const pid = Number.parseInt(String(token ?? "").split(/[:\s]/)[0], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** true only when the pid is known AND provably gone (ESRCH). */
/**
 * Is the process holding this lock gone?
 *
 * Delegates rather than deciding, because this was the THIRD place in the codebase
 * answering the same question with its own code, and the three had drifted: process.mjs
 * knew that a zombie is a corpse, job-control's caller went through that one, and this
 * copy asked `kill(pid, 0)` alone — which a zombie answers just as a live process does.
 * A lock whose holder had died but not yet been reaped therefore stayed unreclaimable,
 * and on posix that is not a rare state: it lasts until the holder's parent gets round
 * to it, which is exactly as long as that parent is busy. Found on Linux, invisible on
 * Windows, where zombies do not exist. (Same shape as the hasKillTargets divergence found
 * hours earlier — one question, one answer, or they drift.)
 */
function pidIsGone(pid) {
  if (!pid) {
    return false;
  }
  return isProcessGone(pid);
}

/**
 * Exclusive per-workspace lock. NOT re-entrant: never call withStateLock from
 * inside another withStateLock for the same cwd (it would block until the deadline).
 *
 * Ownership is tokenised: the holder writes "<pid>:<uuid>" into the lock file and
 * releases only if that exact token is still there. A process that was stolen from
 * therefore cannot delete its successor's lock — without this, one steal cascaded
 * into permanently broken mutual exclusion.
 */
export function withStateLock(cwd, fn, options = {}) {
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + (options.deadlineMs ?? LOCK_DEADLINE_MS);

  while (Date.now() < deadline) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx", STATE_FILE_MODE);
    } catch (error) {
      if (!LOCK_RETRYABLE_CODES.has(error?.code)) {
        throw error;
      }
      // Reclaim when the holder is provably dead — and, as a backstop, when the lock is
      // old enough that a live holder is no longer a credible explanation.
      //
      // ⚠ Be clear about what that second half costs, because this comment used to deny
      // it existed. The mtime is stamped once at acquisition and never refreshed, so age
      // measures time since the lock was TAKEN, not time since the holder last did
      // anything. A critical section that ran past LOCK_LIVE_MAX_MS would therefore be
      // evicted mid-flight and two processes would run it at once. That is a deliberate
      // trade of safety for liveness: without it, one wedged holder blocks the workspace
      // permanently, and a wedged holder is the case that actually happens.
      //
      // The margin is what makes the trade sound, not the absence of the risk. A real
      // critical section here is a few file reads and one write — milliseconds — against
      // a 180 s threshold. Anything approaching that is already pathological.
      const holder = readHolderToken(lockPath);
      const holderPid = holderPidFromToken(holder);
      let reclaimable = pidIsGone(holderPid);
      if (!reclaimable) {
        // Age backstop: generous for an identified (possibly recycled) pid, shorter for
        // a lock with no usable owner at all. A real critical section is milliseconds,
        // so neither threshold can evict a genuinely working holder.
        const limit = holderPid === null ? LOCK_ORPHAN_MS : LOCK_LIVE_MAX_MS;
        try {
          reclaimable = Date.now() - fs.statSync(lockPath).mtimeMs > limit;
        } catch {
          reclaimable = false;
        }
      }
      if (reclaimable) {
        try {
          // Only remove the exact file we inspected; if it changed underneath us the
          // new holder is fresh and must not be disturbed.
          if (readHolderToken(lockPath) === holder) {
            fs.unlinkSync(lockPath);
          }
        } catch {
        }
      }
      sleepMs(LOCK_BACKOFF_MIN_MS + Math.floor(Math.random() * LOCK_BACKOFF_JITTER_MS));
      continue;
    }

    try {
      fs.writeSync(fd, token);
    } catch {
      // An unwritable lock cannot be released safely (no token to match) — drop it
      // and retry rather than entering the critical section unidentifiable.
      try {
        fs.closeSync(fd);
      } catch {
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
      sleepMs(LOCK_BACKOFF_MIN_MS);
      continue;
    }

    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
      }
      try {
        if (readHolderToken(lockPath) === token) {
          fs.unlinkSync(lockPath);
        }
      } catch {
      }
    }
  }

  throw new Error(`Timed out acquiring state lock at ${lockPath}`);
}

// ---------------------------------------------------------------------------
// Named threads: a per-workspace name -> Grok session id registry so callers
// can hold several independent, continuable Grok conversations ("--thread x").
// Stored in its own file to leave the main state schema untouched.
// ---------------------------------------------------------------------------
const NAMED_THREADS_FILE = "named-threads.json";
// Align thread locks with the state lock: short empty-orphan reclaim, minutes-not-hours
// live-max. (Same measured thresholds as LOCK_ORPHAN_MS / LOCK_LIVE_MAX_MS.)
const THREAD_LOCK_ORPHAN_MS = LOCK_ORPHAN_MS;
const THREAD_LOCK_LIVE_MAX_MS = LOCK_LIVE_MAX_MS;
// Thread locks are held for entire agent runs (often 4–6 min). Refresh mtime several
// times inside the live-max window so a live holder is never mistaken for a recycled PID.
const THREAD_LOCK_HEARTBEAT_MS = Math.floor(THREAD_LOCK_LIVE_MAX_MS / 6);
const THREAD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_THREAD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
// Grok session ids are UUIDs or similarly boring opaque tokens; reject path-like values
// so a tampered named-threads.json cannot redirect resume into an attacker-chosen path.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Thread names land in a JSON object and in a file name — keep them boring. */
export function assertValidThreadName(name) {
  const value = String(name ?? "").trim();
  if (!THREAD_NAME_PATTERN.test(value) || RESERVED_THREAD_NAMES.has(value)) {
    throw new Error(
      `Invalid thread name "${name}". Use 1-64 characters: letters, digits, dot, dash or underscore, starting alphanumeric.`
    );
  }
  return value;
}

/** Validate a Grok session id before storing or resuming a named thread. */
export function assertValidSessionId(sessionId) {
  const value = String(sessionId ?? "").trim();
  if (!SESSION_ID_PATTERN.test(value) || value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid session id "${sessionId}".`);
  }
  return value;
}

function namedThreadsPath(cwd) {
  return path.join(resolveStateDir(cwd), NAMED_THREADS_FILE);
}

/**
 * @param {{ strict?: boolean }} options strict=true surfaces a corrupt registry
 *   instead of silently behaving as if no thread had ever been registered.
 */
function readNamedThreads(cwd, options = {}) {
  const filePath = namedThreadsPath(cwd);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.create(null);
    }
    if (options.strict) {
      throw new Error(`Could not read the named-thread registry at ${filePath}: ${error?.message ?? error}`);
    }
    return Object.create(null);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("registry is not an object");
    }
    return Object.assign(Object.create(null), parsed);
  } catch (error) {
    if (options.strict) {
      throw new Error(
        `The named-thread registry at ${filePath} is corrupt (${error?.message ?? error}). Delete the file to start over.`
      );
    }
    return Object.create(null);
  }
}

export function getNamedThread(cwd, name) {
  const key = assertValidThreadName(name);
  // Read under the lock and strictly: resolving a thread decides whether a
  // conversation continues, so a corrupt registry must not silently start fresh.
  const threads = withStateLock(cwd, () => readNamedThreads(cwd, { strict: true }));
  const entry = Object.prototype.hasOwnProperty.call(threads, key) ? threads[key] : null;
  if (!entry || typeof entry.sessionId !== "string") {
    return null;
  }
  try {
    assertValidSessionId(entry.sessionId);
  } catch {
    // Tampered or legacy garbage: treat as missing so resume cannot be redirected.
    return null;
  }
  return entry;
}

export function setNamedThread(cwd, name, sessionId) {
  const key = assertValidThreadName(name);
  const safeSessionId = assertValidSessionId(sessionId);
  return withStateLock(cwd, () => {
    // Strict on write too: a tolerant read would treat a corrupt registry as empty and
    // the atomic replace below would then destroy every other registered thread.
    const threads = readNamedThreads(cwd, { strict: true });
    const entry = { sessionId: safeSessionId, updatedAt: nowIso() };
    threads[key] = entry;
    writeFileAtomic(namedThreadsPath(cwd), `${JSON.stringify(threads, null, 2)}\n`);
    return entry;
  });
}

export function listNamedThreads(cwd) {
  // Strict, like every other reader of this file. Non-strict turned an unparseable
  // registry into an empty one, so `threads` answered "you have none" while resume
  // through the same names kept throwing — the listing was the one place a person would
  // look to find out what was wrong, and it was the one place that hid it.
  return withStateLock(cwd, () => readNamedThreads(cwd, { strict: true }));
}

/** Remove a named thread from the registry. Returns true when an entry was deleted. */
export function deleteNamedThread(cwd, name) {
  const key = assertValidThreadName(name);
  return withStateLock(cwd, () => {
    const threads = readNamedThreads(cwd, { strict: true });
    if (!Object.prototype.hasOwnProperty.call(threads, key)) {
      return false;
    }
    delete threads[key];
    writeFileAtomic(namedThreadsPath(cwd), `${JSON.stringify(threads, null, 2)}\n`);
    return true;
  });
}

/**
 * Drop terminal job records (and their job/log files) that are no longer useful.
 * Active (queued/running) jobs are never removed.
 * @returns {{ removed: string[], kept: number }}
 */
export function cleanTerminalJobs(cwd, options = {}) {
  const keep = Math.max(0, Number(options.keep) || 0);
  const olderThanMs = Number(options.olderThanMs);
  const hasAgeFilter = Number.isFinite(olderThanMs) && olderThanMs > 0;
  const now = Date.now();

  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const jobs = Array.isArray(state.jobs) ? [...state.jobs] : [];
    const active = [];
    const terminal = [];
    for (const job of jobs) {
      if (job.status === "queued" || job.status === "running") {
        active.push(job);
      } else {
        terminal.push(job);
      }
    }
    terminal.sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );

    const removed = [];
    const retainedTerminal = [];
    for (let index = 0; index < terminal.length; index += 1) {
      const job = terminal[index];
      let tooOld = false;
      if (hasAgeFilter) {
        const stamp = Date.parse(job.updatedAt ?? job.completedAt ?? job.createdAt ?? "");
        tooOld = Number.isFinite(stamp) && now - stamp >= olderThanMs;
      }
      // keep: retain newest N terminal jobs; olderThan: drop aged terminal jobs;
      // both: drop when either criterion matches; neither: drop all terminal history.
      let drop = false;
      if (keep > 0 && hasAgeFilter) {
        drop = index >= keep || tooOld;
      } else if (keep > 0) {
        drop = index >= keep;
      } else if (hasAgeFilter) {
        drop = tooOld;
      } else {
        drop = true;
      }
      if (drop) {
        removed.push(job);
      } else {
        retainedTerminal.push(job);
      }
    }

    // Index first, files second — the invariant the rest of this module holds to, and the
    // one place that broke it. Deleting first leaves a window in which the index still
    // names a job whose file is gone, and a crash inside that window makes it permanent;
    // every reader then has to treat "listed but unreadable" as a state it can be in.
    // The other order fails safe: an orphaned file nothing points at is invisible and gets
    // swept the next time this runs.
    saveStateUnlocked(cwd, {
      ...state,
      jobs: [...active, ...retainedTerminal]
    });
    for (const job of removed) {
      removeJobFile(resolveJobFile(cwd, job.id));
      removeFileIfExists(job.logFile, resolveStateDir(cwd));
    }
    return { removed: removed.map((job) => job.id), kept: active.length + retainedTerminal.length };
  });
}

/**
 * Refresh a held thread lock's mtime so the age backstop does not steal it from a
 * live multi-minute run. Returns true when the lock file was touched.
 */
export function touchThreadLock(cwd, name) {
  const key = assertValidThreadName(name);
  const lockPath = path.join(resolveStateDir(cwd), `thread-${key}.lock`);
  try {
    if (!fs.existsSync(lockPath)) {
      return false;
    }
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-thread mutual exclusion: two runs continuing the same named conversation
 * would interleave turns in one Grok session and corrupt its history.
 * Returns null when the thread is already busy (caller decides how to report).
 *
 * Ownership is tokenised like the state lock: never return a handle without a
 * durable token, and never release a successor's lock.
 *
 * While held, a heartbeat refreshes the lock file mtime (thread locks span whole
 * agent runs; the age backstop alone would otherwise reclaim after LIVE_MAX_MS).
 */
export function acquireThreadLock(cwd, name, options = {}) {
  const key = assertValidThreadName(name);
  // Only tests set this: a heartbeat measured in minutes cannot be observed firing
  // inside a test run, and an interval that never starts would otherwise go unnoticed.
  const heartbeatMs =
    Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0
      ? options.heartbeatMs
      : THREAD_LOCK_HEARTBEAT_MS;
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), `thread-${key}.lock`);
  const token = `${process.pid}:${randomUUID()}`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx", STATE_FILE_MODE);
    } catch (error) {
      if (!LOCK_RETRYABLE_CODES.has(error?.code)) {
        throw error;
      }
      const holder = readHolderToken(lockPath);
      const holderPid = holderPidFromToken(holder);
      let reclaimable = pidIsGone(holderPid);
      if (!reclaimable) {
        // Empty/orphan vs live-max: same policy as withStateLock (minutes, not hours).
        const limit = holderPid === null || !String(holder ?? "").trim()
          ? THREAD_LOCK_ORPHAN_MS
          : THREAD_LOCK_LIVE_MAX_MS;
        try {
          reclaimable = Date.now() - fs.statSync(lockPath).mtimeMs > limit;
        } catch {
          reclaimable = false;
        }
      }
      if (!reclaimable) {
        return null;
      }
      try {
        if (readHolderToken(lockPath) === holder) {
          fs.unlinkSync(lockPath);
        }
      } catch {
      }
      continue;
    }

    try {
      fs.writeSync(fd, token);
    } catch {
      // Without a token we cannot release safely — drop the file and retry.
      try {
        fs.closeSync(fd);
      } catch {
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
      continue;
    }

    try {
      fs.closeSync(fd);
    } catch {
    }

    // A heartbeat that fails every time is a lock about to be stolen from a live run, and
    // this loop used to swallow that in silence — including the `false` that touchThreadLock
    // returns for a lock file that has already vanished. One failure is noise (a transient
    // EBUSY on Windows is ordinary); three in a row is the condition, and it gets said once.
    // Saying it every tick would bury the run's own output under a message it cannot act on.
    let consecutiveFailures = 0;
    let warned = false;
    const heartbeat = setInterval(() => {
      let refreshed = false;
      try {
        if (readHolderToken(lockPath) !== token) {
          // Somebody else holds it. Not our failure to report, and the release path already
          // refuses to unlink a successor's lock.
          consecutiveFailures = 0;
          return;
        }
        refreshed = touchThreadLock(cwd, key);
      } catch {
        refreshed = false;
      }
      consecutiveFailures = refreshed ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= 3 && !warned) {
        warned = true;
        try {
          process.stderr.write(
            `Warning: could not refresh the lock for thread "${key}" ${consecutiveFailures} times in a row. ` +
              `Another run may reclaim it while this one is still going.\n`
          );
        } catch {
        }
      }
    }, heartbeatMs);
    // Do not keep the process alive solely for lock heartbeats.
    if (typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    let released = false;
    return {
      name: key,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(heartbeat);
        try {
          if (readHolderToken(lockPath) === token) {
            fs.unlinkSync(lockPath);
          }
        } catch {
        }
      }
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Machine-wide concurrency slots: bounds the number of simultaneous Grok
// agent processes across ALL workspaces and Claude sessions (file-based
// semaphore in the shared state root). Slot files carry the holder pid so
// dead holders can be stolen immediately.
// ---------------------------------------------------------------------------
const SLOTS_DIR_NAME = "global-slots";
// Measured 2026-07-26 (every run correct at every level, no
// throttling from the service, ~50 MB resident per agent): 8 concurrent = single-run speed
// (10s), 20 concurrent = slowest 25s, 32 concurrent = slowest 38s. Degradation is
// gradual CPU contention with no cliff, so the bound is a runaway guard for unbounded
// fan-out, NOT a correctness mechanism — same-workspace collisions are handled by the
// state lock. Default is 2x the core count; GROK_CC_MAX_CONCURRENCY=0 removes it.
const SLOT_MIN_DEFAULT = 8;
const SLOT_CPU_FACTOR = 2;
// Short on purpose: a typical run is 10-40s, so a slot usually frees within this window.
// If it does not, the caller starts anyway (see the end of acquireGlobalSlot) — waiting
// minutes for a slot would be its own kind of stall.
const SLOT_DEFAULT_WAIT_MS = 90 * 1000;
// A slot older than this is reclaimed even if its recorded pid still resolves:
// pids are recycled, and a live-but-unrelated pid must not wedge a slot forever.
const SLOT_STALE_MS = 60 * 60 * 1000;
const SLOT_EMPTY_STALE_MS = 15000;
const SLOT_POLL_MIN_MS = 300;
const SLOT_POLL_JITTER_MS = 400;

function sleepAsync(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

/** Monotonic milliseconds for wait deadlines (immune to wall-clock skew). */
function monotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/** Reclaimable = holder provably dead, or unowned/ancient beyond any plausible run. */
function slotReclaimable(slotPath, holder) {
  const holderPid = holderPidFromToken(holder);
  if (pidIsGone(holderPid)) {
    return true;
  }
  if (holderPid !== null) {
    // Owner is alive. Only a slot far older than any plausible run may be reclaimed —
    // this covers pid recycling without evicting a genuinely running agent.
    try {
      return Date.now() - fs.statSync(slotPath).mtimeMs > SLOT_STALE_MS;
    } catch {
      return false;
    }
  }
  // No owner recorded: the creator died in the gap between create and token write.
  try {
    return Date.now() - fs.statSync(slotPath).mtimeMs > SLOT_EMPTY_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Machine-wide semaphore bounding concurrent Grok agent processes across ALL
 * workspaces and Claude sessions. Async so the caller's event loop keeps turning
 * while queued (progress reporting, signals, cancellation stay alive).
 *
 * Note: the semaphore lives under the resolved state root, so processes started
 * with a different CLAUDE_PLUGIN_DATA form their own independent pool.
 */
export async function acquireGlobalSlot(options = {}) {
  const envMax = Number.parseInt(process.env.GROK_CC_MAX_CONCURRENCY ?? "", 10);
  const configured = options.maxSlots ?? (Number.isFinite(envMax) ? envMax : null);
  let cpuCount = SLOT_MIN_DEFAULT;
  try {
    cpuCount = os.cpus()?.length || SLOT_MIN_DEFAULT;
  } catch {
  }
  const maxSlots = configured ?? Math.max(SLOT_MIN_DEFAULT, cpuCount * SLOT_CPU_FACTOR);
  if (maxSlots <= 0) {
    // Explicitly unbounded: hand back a no-op handle so callers stay unchanged.
    return { slot: 0, unbounded: true, release: () => {} };
  }
  const envWait = Number.parseInt(process.env.GROK_CC_SLOT_WAIT_MS ?? "", 10);
  const waitMs = options.waitMs ?? (Number.isFinite(envWait) && envWait > 0 ? envWait : SLOT_DEFAULT_WAIT_MS);
  const dir = path.join(resolveStateRoot(), SLOTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });

  const token = `${process.pid}:${randomUUID()}`;
  // Monotonic clock for wait deadlines: wall-clock jumps (sleep/resume, NTP) must not
  // skip the queue wait or stretch it unboundedly. Age-based reclaim still uses mtime
  // + Date.now() (documented sleep risk for that backstop only).
  const startedAt = monotonicMs();
  // Progress may extend the soft deadline, but never past this absolute ceiling —
  // otherwise reclaim churn on a busy machine could keep a waiter alive forever.
  const hardDeadline = startedAt + Math.max(waitMs, waitMs * 2);
  let deadline = startedAt + waitMs;
  let announcedWait = false;

  while (monotonicMs() < Math.min(deadline, hardDeadline)) {
    // At most one reclaim attempt per slot per acquisition: a slot whose stale file
    // cannot be removed must never send this loop spinning without a sleep.
    const reclaimTried = new Set();
    for (let index = 1; index <= maxSlots; index += 1) {
      const slotPath = path.join(dir, `slot-${index}`);
      let fd = null;
      try {
        fd = fs.openSync(slotPath, "wx", STATE_FILE_MODE);
      } catch (error) {
        if (!LOCK_RETRYABLE_CODES.has(error?.code)) {
          throw error;
        }
        if (!reclaimTried.has(index)) {
          reclaimTried.add(index);
          const holder = readHolderToken(slotPath);
          if (slotReclaimable(slotPath, holder)) {
            try {
              if (readHolderToken(slotPath) === holder) {
                fs.unlinkSync(slotPath);
                // Reclaiming is progress: do not let a busy machine time us out
                // (bounded by hardDeadline so this can never livelock).
                deadline = Math.max(deadline, monotonicMs() + Math.min(waitMs, 60000));
                index -= 1;
              }
            } catch {
            }
          }
        }
        continue;
      }

      let owned = true;
      try {
        fs.writeSync(fd, token);
      } catch {
        // Without our token in the file we could never release it again, and another
        // waiter would eventually reclaim it while we still believe we hold it.
        owned = false;
      }
      try {
        fs.closeSync(fd);
      } catch {
      }
      if (!owned) {
        try {
          fs.unlinkSync(slotPath);
        } catch {
        }
        continue;
      }
      return {
        slot: index,
        // Ownership-checked release: never delete a slot another process now owns.
        release: () => {
          try {
            if (readHolderToken(slotPath) === token) {
              fs.unlinkSync(slotPath);
            }
          } catch {
          }
        }
      };
    }

    if (!announcedWait) {
      announcedWait = true;
      try {
        options.onWait?.(maxSlots);
      } catch {
      }
    }
    await sleepAsync(SLOT_POLL_MIN_MS + Math.floor(Math.random() * SLOT_POLL_JITTER_MS));
  }

  // Backpressure, never data loss: callers must be able to offload without tracking how
  // much else is running, so an exhausted queue proceeds unbounded instead of failing
  // the run. The bound paces a busy machine; it must never destroy queued work.
  try {
    options.onOverflow?.(maxSlots);
  } catch {
  }
  return { slot: 0, unbounded: true, overflow: true, release: () => {} };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function readJobFileIfPresent(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveJobFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`);
}

function upsertJobInState(state, jobPatch) {
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...jobPatch
    });
    return;
  }
  state.jobs[existingIndex] = {
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  };
}

/** Claim terminal status for job file + index under one lock. cancelled wins. */
export function claimJobTerminal(cwd, jobId, nextStatus, patch = {}, options = {}) {
  if (!isTerminalJobStatus(nextStatus)) {
    throw new Error(`claimJobTerminal requires a terminal status, got: ${nextStatus}`);
  }

  // The lock deadline is generous by default because a waiter must outlast the reclaim
  // thresholds. A caller running under its own shorter budget — a lifecycle hook the host
  // kills after 30s — has to be able to give up sooner and still finish its work.
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;

    if (!existing) {
      return { claimed: false, status: null, job: null, reason: "missing" };
    }

    const currentStatus = existing.status;
    if (isTerminalJobStatus(currentStatus)) {
      if (currentStatus === "cancelled" && nextStatus !== "cancelled") {
        return { claimed: false, status: "cancelled", job: existing, reason: "cancelled-wins" };
      }
      if (nextStatus === "cancelled" && currentStatus !== "cancelled") {
        return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
      }
      if (currentStatus === "cancelled" && nextStatus === "cancelled") {
        const merged = {
          ...existing,
          ...patch,
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          // Omit semantics, exactly as in the claim path below: an omitted key preserves
          // what is stored, only an explicit null clears it. Nulling unconditionally here
          // undid the single thing `stop` does to keep a survivor reachable. The sequence
          // is: claim (clears the targets), kill, and if the kill did not land, restore
          // the targets onto the record — then a SECOND claim writes the outcome, lands
          // in this branch because the record is already cancelled, and wiped them again
          // a moment later. The record ended up reading cancelled with no pids while the
          // agent was still running, and nothing could reach it afterwards.
          pid: patch.pid !== undefined ? patch.pid : (existing.pid ?? null),
          agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
          bridgePid: resolveBridgePidField(existing, patch),
          updatedAt: nowIso()
        };
        writeJobFileUnlocked(cwd, jobId, merged);
        upsertJobInState(state, {
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          summary: merged.summary ?? existing.summary,
          threadId: merged.threadId ?? existing.threadId ?? null,
          // The index has to agree with the file it indexes; hard-coded nulls here meant
          // a restored target lived in the job file and was invisible to every reader
          // that goes through the index.
          pid: merged.pid ?? null,
          agentPid: merged.agentPid ?? null,
          bridgePid: merged.bridgePid ?? null,
          errorMessage: merged.errorMessage ?? existing.errorMessage
        });
        saveStateUnlocked(cwd, state);
        return { claimed: false, status: "cancelled", job: merged, reason: "cancelled-merge" };
      }
      return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
    }

    const completedAt = patch.completedAt ?? nowIso();
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      status: nextStatus,
      phase: patch.phase ?? (nextStatus === "completed" ? "done" : nextStatus),
      // An omitted key PRESERVES what is stored; only an explicit null clears it. This
      // was the opposite until 2026-07-28, and the inversion silently neutralised three
      // separate fixes written the same day: the timeout path, the SessionEnd hook and
      // the exception path all deliberately omitted these keys to keep a survivor's pid
      // reachable, and all three had it nulled out from under them here. Every comment
      // claiming "omitted key keeps whatever is stored" was describing an intention the
      // merge did not honour. patchJobIfActive already behaves this way (see below), so
      // the two functions were also contradicting each other on the same fields.
      //
      // Callers that want the targets gone still say so explicitly, and all of them do:
      // the reclaim paths, the stop path and the ordinary success path pass null.
      pid: patch.pid !== undefined ? patch.pid : (existing.pid ?? null),
      agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
      bridgePid: resolveBridgePidField(existing, patch),
      completedAt,
      updatedAt: nowIso()
    };
    if (nextStatus === "cancelled") {
      nextJob.cancelledAt = patch.cancelledAt ?? completedAt;
    }

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextStatus,
      phase: nextJob.phase,
      summary: nextJob.summary ?? existing.summary,
      threadId: nextJob.threadId ?? existing.threadId ?? null,
      turnId: nextJob.turnId ?? existing.turnId ?? null,
      // Honour patch-supplied kill targets (abandoned-while-alive reclaim keeps them).
      pid: nextJob.pid ?? null,
      agentPid: nextJob.agentPid ?? null,
      bridgePid: nextJob.bridgePid ?? null,
      errorMessage: nextJob.errorMessage,
      completedAt,
      logFile: nextJob.logFile ?? existing.logFile ?? null,
      sessionId: nextJob.sessionId ?? existing.sessionId,
      kind: nextJob.kind ?? existing.kind,
      kindLabel: nextJob.kindLabel ?? existing.kindLabel,
      title: nextJob.title ?? existing.title,
      jobClass: nextJob.jobClass ?? existing.jobClass,
      write: nextJob.write ?? existing.write,
      abandonedWhileAlive: nextJob.abandonedWhileAlive ?? existing.abandonedWhileAlive
    });
    saveStateUnlocked(cwd, state);
    return { claimed: true, status: nextStatus, job: nextJob, reason: "claimed" };
  }, options);
}

/**
 * The completion sentinel used to be written here, and is gone.
 *
 * It was a one-line `<job>.done` marker written on every terminal claim, so that a caller
 * could `fs.watch` for it instead of polling — built after a caller waited 25 minutes for a
 * result that was already complete on disk (2026-07-28). Two things were true of it a full
 * read of the module turned up on 2026-07-31, and neither is visible from the code around
 * it:
 *
 *   - **nothing ever read it.** No production path, no command, no hook. `resolveJobDoneFile`
 *     was exported and used only by its own test. A signal with no receiver cannot be relied
 *     on and cannot be maintained — and the incident it was built for turned out to have a
 *     different cause: the record was being written to a second workspace directory after an
 *     agent ran `git init`, which the sealed `--workspace-root` fixed.
 *   - **nothing ever deleted it.** Retention prunes records and logs; the markers accumulated
 *     one per run, forever.
 *
 * `removeJobFile` now sweeps any marker left behind by an older version. If a watch-based
 * waiter is wanted later, it should arrive together with the code that watches.
 */

/** Patch non-terminal job under lock; no-op if missing/terminal. */
/**
 * Patch a non-terminal job under the lock.
 *
 * `options.deadlineMs` matters more here than anywhere else. withStateLock waits
 * synchronously — `Atomics.wait` in a plain loop — so nothing else on the event loop
 * runs while it waits, including the wall-clock timeout timer of the very run whose
 * progress is being written. With the default deadline a contended lock could hold the
 * loop for minutes. Callers that write progress while a run is in flight therefore pass
 * a short deadline: a dropped progress line costs nothing and is now logged, while a
 * blocked timer costs the deadline the run promised its caller.
 */
export function patchJobIfActive(cwd, jobId, patch = {}, options = {}) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;
    if (!existing) {
      return { patched: false, status: null, job: null, reason: "missing" };
    }
    if (isTerminalJobStatus(existing.status)) {
      return { patched: false, status: existing.status, job: existing, reason: "terminal" };
    }

    const bridgePid = resolveBridgePidField(existing, patch);
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      bridgePid,
      agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
      pid:
        patch.pid !== undefined
          ? patch.pid
          : (bridgePid ?? existing.pid ?? null),
      updatedAt: nowIso()
    };

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextJob.status,
      phase: nextJob.phase,
      summary: nextJob.summary,
      lastMessage: nextJob.lastMessage,
      threadId: nextJob.threadId,
      turnId: nextJob.turnId,
      pid: nextJob.pid,
      agentPid: nextJob.agentPid,
      bridgePid: nextJob.bridgePid,
      logFile: nextJob.logFile,
      errorMessage: nextJob.errorMessage
    });
    saveStateUnlocked(cwd, state);
    return { patched: true, status: nextJob.status, job: nextJob, reason: "patched" };
  }, options);
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let raw = "";
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read bridge state file ${stateFile}: ${error.message}`);
  }

  if (!raw.trim()) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(stateFile, quarantinePath);
    } catch {
    }
    // The index is a convenience over the per-job files, which are the durable record.
    // Rebuilding from them keeps running work visible and manageable; throwing here
    // used to guard against a silent wipe, but it also made every command fail —
    // including `runs`, which is what an operator reaches for to see what is going on.
    // The wipe concern is met by rebuilding rather than starting empty, and by saying
    // out loud that the file was corrupt.
    const rebuilt = collectJobsFromStateDir(resolveStateDir(cwd));
    const repaired = {
      ...defaultState(),
      jobs: pruneJobs(rebuilt)
    };
    // Persist the repair, otherwise every later read starts from no index at all and
    // the recovery only helps the caller that happened to trip over the corruption.
    // Written directly rather than through saveState, which would re-enter loadState.
    try {
      writeFileAtomic(stateFile, `${JSON.stringify({ ...repaired, version: STATE_VERSION }, null, 2)}\n`);
    } catch {
    }
    process.stderr.write(
      `[grok-cc] Bridge state file was corrupt and was quarantined to ${quarantinePath}: ` +
        `${error.message}. Rebuilt ${rebuilt.length} record(s) from the job files.\n`
    );
    return repaired;
  }
}

function positivePid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Does this record still name an AGENT process — the thing a survivor actually is?
 *
 * Not "does it carry any kill target". That was the first version of this predicate and
 * it was too wide by exactly the field that matters least: the ordinary completion path
 * writes `bridgePid: process.pid` onto every terminal record and only clears agentPid and
 * pid, so a finished, fully accounted run keeps a dead bridge pid forever. Measured
 * against a real ledger on 2026-07-31: completed and failed records alike carried one.
 *
 * Treating those as survivors does not just retain junk — it lets ordinary finished runs
 * crowd a genuine survivor out of the survivor bucket, which is the one record that must
 * not be lost. The bridge pid is this worker's own; on a terminal record the worker that
 * held it is gone by definition. The agent is the process that outlives a half-walked
 * tree and keeps spending, so the agent is what retention protects.
 */
function hasSurvivingAgent(job) {
  if (positivePid(job?.agentPid) !== null) {
    return true;
  }
  // Older records recorded the agent as `pid`; the bridge's own pid lives in bridgePid, so
  // a `pid` that differs from it is an agent by another name.
  //
  // `companionPid` is the pre-rename name for bridgePid, and six other read sites accept
  // it. This one did not, so on a record old enough to use it the bridge's own pid failed
  // the comparison and was counted as an agent. That is the direction that costs something:
  // the bogus survivor takes a slot in a bucket capped at MAX_JOBS, and the record it
  // crowds out is a real one. Found 2026-07-31 by an audit pass that compared every read
  // site of the same field against the others.
  const bare = positivePid(job?.pid);
  return bare !== null && bare !== positivePid(job?.bridgePid ?? job?.companionPid);
}

/**
 * Cap finished history at MAX_JOBS while never dropping in-flight work.
 * Active (queued/running) records are always retained — even if they alone
 * exceed MAX_JOBS. Independently, the newest MAX_JOBS terminal jobs are kept.
 * Total records may therefore exceed MAX_JOBS; that is intended. A retention
 * policy must never delete a result at the moment it becomes available.
 *
 * A terminal record that still names an agent process is kept in its own bucket. An agent
 * pid is only left behind when a kill was tried and could not be confirmed, which means a
 * process is probably still running and this record is the only thing that knows its pid.
 * Pruning it away would delete the sole pointer to a live agent — and the moment stop and
 * SessionEnd started keeping those pids on purpose, the fifty-record cap became the way
 * that pointer got lost anyway.
 *
 * That bucket is capped too, at MAX_JOBS of its own. Letting it grow with the always-kept
 * active records looked harmless and is not: a pid is only ever cleared by a LATER
 * successful kill, so a record whose agent is never stopped again — the user forgets it,
 * or the process died on its own and nobody ran stop a second time — keeps its pid for
 * good. Unbounded retention was the one new failure all three reviewers of that change
 * found independently.
 *
 * But the cap they agreed on was ordered by time, and time is a poor proxy for the question
 * actually being asked. The justification ran "the oldest survivor is least likely to still
 * point at anything" — likely, not certain, and the record it drops is by construction the
 * only thing that knows a possibly-live agent's pid. So ask the real question instead: when
 * the bucket is over the cap, probe the pids and let the DEAD ones fall through to ordinary
 * retention. Nothing swept a dead-but-not-nulled pid before; this is that sweep, and with it
 * the bucket is bounded by the number of agents genuinely still running.
 *
 * The probe only runs when the cap would otherwise bite. It costs a syscall per survivor —
 * and on POSIX a `ps` for the zombie check — inside the state lock, which is not something
 * to pay on every save for a bucket that is almost always empty.
 *
 * The slice stays as a last backstop for the pathological case of more than MAX_JOBS agents
 * genuinely alive at once. Total records stay bounded by active + 2 × MAX_JOBS.
 */
export function pruneJobs(jobs, options = {}) {
  const isGone = options.isGone ?? ((pid) => isProcessGone(pid));
  const list = Array.isArray(jobs) ? [...jobs] : [];
  const active = [];
  let survivors = [];
  const terminal = [];
  for (const job of list) {
    if (job?.status === "queued" || job?.status === "running") {
      active.push(job);
    } else if (hasSurvivingAgent(job)) {
      survivors.push(job);
    } else {
      terminal.push(job);
    }
  }

  if (survivors.length > MAX_JOBS) {
    const live = [];
    for (const job of survivors) {
      if (survivorPidsAllGone(job, isGone)) {
        terminal.push(job);
      } else {
        live.push(job);
      }
    }
    survivors = live;
  }

  const newestFirst = (left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
  survivors.sort(newestFirst);
  terminal.sort(newestFirst);
  return [...active, ...survivors.slice(0, MAX_JOBS), ...terminal.slice(0, MAX_JOBS)];
}

/**
 * Is every agent pid on this record verifiably gone?
 *
 * Gone, not "not alive": a probe that cannot answer must leave the record in the survivor
 * bucket. The whole point of that bucket is to hold the records we are unsure about.
 */
function survivorPidsAllGone(job, isGone) {
  const pids = [positivePid(job?.agentPid), positivePid(job?.pid)].filter(
    (pid) => pid !== null && pid !== positivePid(job?.bridgePid ?? job?.companionPid)
  );
  if (pids.length === 0) {
    return false;
  }
  return pids.every((pid) => {
    try {
      return isGone(pid) === true;
    } catch {
      return false;
    }
  });
}

/**
 * Delete a job's log file — but only if it is actually inside that job's state directory.
 *
 * `job.logFile` is read back out of `state.json`, and state.json is not always somewhere
 * only we can write. With `CLAUDE_PLUGIN_DATA` unset the state root falls back to
 * `os.tmpdir()/grok-cc-runs-<user>`, and on Linux and macOS that parent is world-writable
 * `/tmp`. A local attacker who creates that directory before the first run — the name is
 * derived from the username, so it is predictable — owns its contents, and every path in
 * the state file becomes an argument to `fs.unlinkSync` running as the victim. Pruning
 * terminal history would then delete whatever the file names: an ssh key, a password
 * store, anything the user can remove. Windows is unaffected (its temp directory is
 * per-user), which is exactly the kind of asymmetry that keeps a defect invisible to
 * anyone developing on Windows.
 *
 * Found 2026-07-31 by an audit that read the runtime source. The fallback path is not
 * hypothetical: it is taken whenever the bridge is invoked outside Claude Code, which
 * happened repeatedly on the day it was found.
 *
 * Containment rather than sanitisation: resolve both sides and require the file to sit
 * under the directory we own. A path that does not is left alone — refusing to delete
 * something is always recoverable, deleting the wrong thing is not.
 *
 * ⚠ The containment must be REAL, not lexical, and for a while it was not. `path.resolve`
 * normalises `..` but follows nothing, so a symlinked directory component *inside* the
 * state root passed the string prefix test while the unlink landed wherever the link
 * pointed. Same attacker, same world-writable fallback root, same primitive — one
 * directory component further up than the hole this comment was written for. Demonstrated
 * with a Windows junction, which needs no elevation to create: `<root>/jobs` → `../victim`,
 * a `state.json` naming `<root>/jobs/id_rsa`, and the next retention prune removes the
 * victim's key as the victim.
 *
 * So realpath the file's PARENT — the parent, because the file itself may legitimately
 * already be gone, and because unlinking a symlink removes the link rather than its
 * target, which makes the last component the harmless one. `stateDirForPath` above already
 * uses `realpathSync.native` for exactly this reason; this is the same idiom.
 *
 * What remains, stated rather than hidden: a TOCTOU window between the check and the
 * unlink. Closing it needs an openat/O_NOFOLLOW-style API Node does not expose portably.
 * The window is microseconds against an attacker who must already own the state root.
 */
export function removeFileIfExists(filePath, stateDir) {
  if (!filePath) {
    return;
  }
  if (stateDir) {
    let realFile;
    let realRoot;
    try {
      // `.native`, not plain `realpathSync`: on Windows the plain form resolves links but
      // does not canonicalise case, so a root spelled with different capitalisation from
      // the file made the prefix test fail on a case-insensitive filesystem. That fails in
      // the safe direction — refusing a legitimate delete rather than allowing an escape —
      // but never cleaning up a log file is still a defect, and the comment above claimed
      // `.native` while the code did not use it.
      const absolute = path.resolve(filePath);
      realFile = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
      realRoot = fs.realpathSync.native(path.resolve(stateDir));
    } catch {
      // A parent that cannot be resolved is a parent that does not exist, and nothing can
      // live under it. Refusing is the safe direction here as everywhere in this function.
      return;
    }
    const withSeparator = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!realFile.startsWith(withSeparator)) {
      return;
    }
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  // Index first, files second. The other order left a crash window in which the index
  // still advertised runs whose job file and log had already been deleted — a run you can
  // see and cannot read, which is the failure a person notices. Crashing the other way
  // round leaks a job file nothing references: invisible, and it costs disk rather than
  // trust.
  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile, resolveStateDir(cwd));
  }

  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  // Not Math.random(): the id names a log file in a predictable directory, and a guessable
  // name is what a symlink attack needs. randomUUID is already imported for other ids here.
  const random = randomUUID().replace(/-/g, "").slice(0, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

/**
 * Merge index entry with on-disk job file. The durable job file is preferred when
 * the two disagree (e.g. completed file vs still-running index after a crash
 * between the two writes in claimJobTerminal). Optionally records whether the
 * index needs healing.
 */
function mergeIndexJobWithFile(cwd, indexJob) {
  if (!indexJob?.id) {
    return { job: indexJob, heal: false };
  }
  const jobFile = resolveJobFile(cwd, indexJob.id);
  if (!fs.existsSync(jobFile)) {
    return { job: indexJob, heal: false };
  }
  const fileJob = readJobFile(jobFile);
  if (fileJob?.damaged) {
    return {
      job: {
        ...indexJob,
        ...fileJob,
        id: indexJob.id,
        damaged: true
      },
      heal: false
    };
  }
  // Job file wins on field merge; status disagreement means the index is stale.
  const merged = { ...indexJob, ...fileJob, id: indexJob.id };
  const heal =
    fileJob &&
    typeof fileJob.status === "string" &&
    fileJob.status !== indexJob.status &&
    isTerminalJobStatus(fileJob.status);
  return { job: merged, heal };
}

/**
 * When the durable job file is terminal and the index still says otherwise, rewrite
 * the index entry from the file so later reads stay consistent.
 */
function healIndexFromJobFiles(cwd, heals) {
  if (!heals.length) {
    return;
  }
  withStateLock(cwd, () => {
    const state = loadState(cwd);
    let changed = false;
    for (const fileJob of heals) {
      if (!fileJob?.id || !isTerminalJobStatus(fileJob.status)) {
        continue;
      }
      const index = state.jobs.findIndex((entry) => entry.id === fileJob.id);
      if (index === -1) {
        continue;
      }
      const current = state.jobs[index];
      if (current.status === fileJob.status) {
        continue;
      }
      state.jobs[index] = {
        ...current,
        status: fileJob.status,
        phase: fileJob.phase ?? current.phase,
        summary: fileJob.summary ?? current.summary,
        errorMessage: fileJob.errorMessage ?? current.errorMessage,
        completedAt: fileJob.completedAt ?? current.completedAt,
        threadId: fileJob.threadId ?? current.threadId ?? null,
        turnId: fileJob.turnId ?? current.turnId ?? null,
        pid: fileJob.pid ?? null,
        agentPid: fileJob.agentPid ?? null,
        bridgePid: fileJob.bridgePid ?? null,
        logFile: fileJob.logFile ?? current.logFile ?? null,
        sessionId: fileJob.sessionId ?? current.sessionId,
        kind: fileJob.kind ?? current.kind,
        kindLabel: fileJob.kindLabel ?? current.kindLabel,
        title: fileJob.title ?? current.title,
        jobClass: fileJob.jobClass ?? current.jobClass,
        write: fileJob.write ?? current.write,
        updatedAt: fileJob.updatedAt ?? current.updatedAt ?? nowIso()
      };
      changed = true;
    }
    if (changed) {
      saveStateUnlocked(cwd, state);
    }
  });
}

export function listJobs(cwd) {
  const state = loadState(cwd);
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const heals = [];
  const merged = jobs.map((indexJob) => {
    const { job, heal } = mergeIndexJobWithFile(cwd, indexJob);
    if (heal && job) {
      heals.push(job);
    }
    return job;
  });
  if (heals.length > 0) {
    try {
      healIndexFromJobFiles(cwd, heals);
    } catch {
      // Healing is best-effort; the merged read result still prefers the job file.
    }
  }
  return merged;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  // All job-file writes go through the state lock so claim/patch cannot race an
  // unlocked overwrite (enqueue vs stop, worker vs reclaim).
  return withStateLock(cwd, () => {
    writeJobFileUnlocked(cwd, jobId, payload);
    return resolveJobFile(cwd, jobId);
  });
}

/**
 * Read a job record. Corrupt / non-JSON content degrades to a damaged marker
 * for that one id rather than throwing — a single crash mid-write must not make
 * the whole workspace unlistable.
 */
export function readJobFile(jobFile) {
  let raw = "";
  try {
    raw = fs.readFileSync(jobFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read job file ${jobFile}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const id = path.basename(String(jobFile), ".json");
    return {
      id,
      status: "failed",
      phase: "damaged",
      damaged: true,
      errorMessage: `Damaged job record: ${error.message}`,
      jobFile: String(jobFile)
    };
  }
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
  // Sweep the completion marker an older version wrote next to this record. Nothing
  // writes one any more (see the note above claimJobTerminal's helpers), but nothing ever
  // deleted them either, so an existing installation is carrying one per run it has ever
  // completed. The path is derived from the record's own, so it cannot point elsewhere.
  const marker = `${jobFile}.done`;
  try {
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker);
    }
  } catch {
    // Best-effort litter collection; never a reason to fail the deletion that matters.
  }
}

// Job ids reach these helpers from the command line (`show <id>`, `runs <id>`, `stop
// <id>`), so they must never be able to escape the jobs directory.
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidJobId(jobId) {
  const value = String(jobId ?? "").trim();
  if (!JOB_ID_PATTERN.test(value) || value.includes("..")) {
    throw new Error(`Invalid run id "${jobId}".`);
  }
  return value;
}

/**
 * A job's log path, derived — never the value stored on the record.
 *
 * `job.logFile` is read back out of `state.json`, and state.json is not always somewhere
 * only we can write: with `CLAUDE_PLUGIN_DATA` unset the state root is
 * `os.tmpdir()/grok-cc-runs-<user>`, and on Linux and macOS that parent is world-writable.
 * A local attacker who creates that directory first owns its contents, and every consumer
 * of the stored path becomes a primitive: `appendLogLine` writes there, the progress
 * preview reads there, the sentinel's failure path appends there.
 *
 * The deletion path was contained by checking the path against the state directory. This
 * is the better shape for the rest, and it is what `runTrackedJob` already did: do not
 * validate the attacker's value, do not use it. The log lives at a place that follows from
 * the workspace and the job id, both of which are validated (`assertValidJobId`), so ask
 * for that place instead. A record that cannot say which workspace it belongs to gets
 * null, and every caller already handles a null log path by doing nothing.
 *
 * Found 2026-07-31 by an audit pass that asked what a hostile local user could do — as the
 * sibling of an arbitrary-deletion defect fixed the same day, in exactly the place the fix
 * had not looked.
 */
export function resolveTrustedJobLogFile(job) {
  const workspaceRoot = job?.workspaceRoot;
  const jobId = job?.id;
  if (!workspaceRoot || !jobId) {
    return null;
  }
  try {
    return resolveJobLogFile(workspaceRoot, jobId);
  } catch {
    // Invalid id, unwritable state dir — the caller's fallback is "no log", which is the
    // correct outcome here rather than reaching for the stored value.
    return null;
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${assertValidJobId(jobId)}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${assertValidJobId(jobId)}.json`);
}
