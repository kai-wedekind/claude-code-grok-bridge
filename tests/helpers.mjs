// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Every directory this process created, so cleanup can remove exactly those.
//
// ⚠ ONLY OUR OWN PATHS, never a glob sweep of the prefix. The prefix is inherited from upstream
// unchanged, so another checkout — or a second suite running concurrently on the same machine —
// creates directories that match it, and deleting those would pull a live run's state out from
// under it. Recording what we made is the only way to know what is ours.
const createdTempDirs = [];
let cleanupHooked = false;

/**
 * Remove a tree, clearing read-only bits first.
 *
 * ⚠ `rmSync({ force: true })` is not enough. `force` swallows ENOENT; it does nothing about
 * EPERM, and git writes its loose objects read-only — so a single such blob makes the recursive
 * delete refuse the WHOLE tree. Measured 2026-08-07: 6,437 directories survived a first sweep
 * for exactly that reason, and every one of them contains an `initGitRepo` fixture.
 *
 * Failures do not fail the suite: a test that leaves a child process holding a handle is a
 * reason to leave the directory behind, not a reason to exit non-zero. ⚠ But they are COUNTED
 * and reported, which they were not before. A swallowed failure with no counter meant the
 * suite could not tell leak-from-bug from leak-from-policy, and that is precisely why the one
 * directory surviving each run went unexplained for two days — nothing recorded which path
 * failed or why. Audit 2026-08-09.
 */
const cleanupFailures = [];

/** Depth bound for `relax`. A tree deeper than this is pathological; recursing into it blows
 * the stack, and that throw used to escape `removeTree` and abort the whole cleanup queue —
 * so one bad tree took every remaining directory with it. */
const MAX_RELAX_DEPTH = 64;

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
    return;
  } catch {
  }
  const relax = (entry, depth) => {
    if (depth > MAX_RELAX_DEPTH) {
      return;
    }
    let stat;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      return;
    }
    try {
      fs.chmodSync(entry, 0o700);
    } catch {
    }
    // lstat, so a symlink is never followed — a loop cannot be walked into.
    if (stat.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(entry);
      } catch {
        return;
      }
      for (const name of names) relax(path.join(entry, name), depth + 1);
    }
  };
  try {
    relax(target, 0);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    // ⚠ The catch spans `relax` too. It used to cover only the second rmSync, so a throw from
    // the recursion escaped into `cleanupTempDirs`, which aborted mid-loop and left every
    // not-yet-popped directory behind.
    cleanupFailures.push({ target, code: error?.code ?? null, message: String(error?.message ?? error) });
  }
}

/**
 * Delete everything this process created. Exported so a test can prove it works.
 *
 * One failure must not cost the others: each removal is independent, and the queue is drained
 * even if some entries refuse.
 */
export function cleanupTempDirs() {
  while (createdTempDirs.length > 0) {
    removeTree(createdTempDirs.pop());
  }
  return cleanupFailures.slice();
}

/** What refused to go, for a test or a human to look at. */
export function tempDirCleanupFailures() {
  return cleanupFailures.slice();
}

function reportCleanupFailures() {
  if (cleanupFailures.length === 0) {
    return;
  }
  // stderr, not a thrown error: the suite's verdict is about the code under test, not about
  // whether Windows would release a handle. But silence here is what made this invisible.
  process.stderr.write(
    `\n[helpers] ${cleanupFailures.length} temp director${cleanupFailures.length === 1 ? "y" : "ies"} could not be removed:\n` +
      cleanupFailures.map((f) => `  ${f.target} — ${f.code ?? "?"}: ${f.message}\n`).join("")
  );
}

export function makeTempDir(prefix = "grok-build-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  if (!cleanupHooked) {
    cleanupHooked = true;
    // `exit` rather than an after() hook: node --test runs each file in its own process, and an
    // exit handler catches the paths regardless of which file, suite or hook created them —
    // including a test that threw. It has to stay synchronous, which rmSync is.
    process.on("exit", () => {
      cleanupTempDirs();
      reportCleanupFailures();
    });
    // ⚠ `exit` does NOT fire when the process is terminated by signal, and nothing here said
    // so — Ctrl+C on a suite, or `node --test` killing a timed-out worker, left every recorded
    // directory on disk. Registering a listener also changes the default disposition, so the
    // re-raise is not optional: clean up, remove the handler, and let the signal kill us the
    // way it would have. Audit 2026-08-09.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
      process.on(signal, () => {
        cleanupTempDirs();
        reportCleanupFailures();
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      });
    }
  }
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout,
    killSignal: options.killSignal,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Grok Build Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
