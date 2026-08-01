import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { removeFileIfExists } from "../plugins/grok-build/scripts/lib/state.mjs";
import { createProgressReporter, scrubSecrets } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

/**
 * Two guards for defects an audit of the published tree found on 2026-08-01. Both are
 * about a promise being kept on the durable surfaces and broken on one other.
 */

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `grok-cc-${name}-`));
  return fs.realpathSync(dir);
}

/** A directory symlink that needs no elevation on Windows either. */
function linkDirectory(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

test("a symlinked directory component cannot carry a deletion outside the state root", () => {
  const base = scratch("containment");
  const stateDir = path.join(base, "stateroot");
  const victimDir = path.join(base, "victim");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(victimDir);

  const victimFile = path.join(victimDir, "id_rsa");
  fs.writeFileSync(victimFile, "PRIVATE KEY", "utf8");

  // The attacker owns the state root (world-writable temp, predictable name) and points a
  // directory INSIDE it at something valuable. The path handed to the deleter is a string
  // that sits under the state root; only following the link shows where it lands.
  const jobsLink = path.join(stateDir, "jobs");
  try {
    linkDirectory(victimDir, jobsLink);
  } catch (error) {
    // Some CI images refuse symlink creation outright. Skipping is honest; passing on a
    // machine that could not build the attack would not be.
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return;
    }
    throw error;
  }

  const throughLink = path.join(jobsLink, "id_rsa");
  assert.ok(fs.existsSync(throughLink), "the attack path must reach the victim file");
  // `path.resolve` alone says yes to this — that was the defect.
  assert.ok(path.resolve(throughLink).startsWith(stateDir + path.sep));

  removeFileIfExists(throughLink, stateDir);

  assert.ok(
    fs.existsSync(victimFile),
    "containment must follow symlinks; a lexical prefix test lets the unlink escape"
  );

  fs.rmSync(base, { recursive: true, force: true });
});

test("an ordinary file inside the state root is still deleted", () => {
  const base = scratch("containment-ok");
  const stateDir = path.join(base, "stateroot");
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const logFile = path.join(stateDir, "jobs", "run-abc.log");
  fs.writeFileSync(logFile, "line", "utf8");

  removeFileIfExists(logFile, stateDir);

  assert.equal(fs.existsSync(logFile), false, "the containment must not break normal cleanup");
  fs.rmSync(base, { recursive: true, force: true });
});

test("progress written to stderr is scrubbed like the log and the job record", () => {
  // The text reaching this reporter comes off the CLI's own stderr, one line per newline,
  // so it is vendor output rather than something the bridge composed. The durable surfaces
  // were redacted and the console — the surface that ends up in a bug report — was not.
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const report = createProgressReporter({ stderr: true });
    report({ message: "progress", stderrMessage: "auth failed for sk-abcdefghijklmnop0123" });
    report({ message: "progress", stderrMessage: "sending Bearer abcdefghijklmnop0123" });
    report("XAI_API_KEY=xai-abcdefghijklmnop0123 rejected");
  } finally {
    process.stderr.write = original;
  }

  const all = written.join("");
  assert.equal(written.length, 3);
  assert.doesNotMatch(all, /sk-abcdefghijklmnop0123/);
  assert.doesNotMatch(all, /Bearer abcdefghijklmnop0123/);
  assert.doesNotMatch(all, /xai-abcdefghijklmnop0123/);
  assert.match(all, /REDACTED/);
  // Same function the durable surfaces use, so the three cannot drift apart again.
  assert.equal(scrubSecrets("sk-abcdefghijklmnop0123"), "sk-[REDACTED]");
});
