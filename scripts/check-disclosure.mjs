#!/usr/bin/env node
/**
 * Which release-note entries are also vulnerability disclosures against upstream?
 *
 * WHY THIS EXISTS. A hardened fork's changelog is a disclosure channel for its parent's
 * bugs, and nobody sees it coming, because documenting your own security fixes is exactly
 * what a good maintainer does. Every line saying "we fixed X" also says "they still ship X".
 *
 * It has already cost something real. `CHANGELOG.md` has described the argument-parsing
 * defect since 2026-08-01 — "an unquoted `--write` inside a task description cannot grant
 * write access" — which is a working exploit summary for code we inherited. The finding was
 * therefore publicly disclosed six days before it was reported privately, and xAI's bug
 * bounty requires that a reporter has not publicly disclosed before the report is closed.
 * Ineligible before anyone thought to file it.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT. The rule is a judgement — describe the
 * fix without describing the defect, or report privately first — and no script can make that
 * call. What a script CAN do is say which entries the judgement applies to, which is the part
 * that gets forgotten. An entry is a disclosure exactly when the code it fixes was inherited
 * and upstream has not fixed it. So: for every file changed in the release, compare the
 * version we started from against upstream's current version of the same file.
 *
 *   identical  -> we are fixing inherited code that upstream still ships. The entry is a
 *                 disclosure. Write it carefully or report privately first.
 *   differs    -> we already diverged here; the entry is about our own code.
 *   absent     -> the file does not exist upstream. Ours entirely.
 *
 * ⚠ "Differs" is not a clean bill of health. We may have diverged for an unrelated reason
 * while the defect itself is still present upstream in another form. This narrows the set to
 * read; it does not decide anything. A file listed INHERITED definitely needs the judgement;
 * a file listed OURS probably does not.
 *
 * EXIT CODES, matching check-upstream.mjs and check-test-count.mjs:
 *   0  no changed file was inherited — no entry needs a disclosure decision
 *   1  at least one did — read those entries before publishing
 *   2  the check could not run
 *
 * ⚠ 2 IS NOT AN ALL-CLEAR. A missing upstream ref, an unreadable tree or a bad range lands
 * here rather than passing quietly.
 *
 * USAGE
 *   node scripts/check-disclosure.mjs --since v0.3.2
 *   node scripts/check-disclosure.mjs --since v0.3.2 --upstream 92b76a6
 *
 * `--upstream` defaults to whatever check-upstream.mjs last marked as reviewed, so the two
 * checks agree on what "upstream" means instead of each keeping its own idea.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = path.join(ROOT, "scripts", "check-upstream-state.json");

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitQuiet(args) {
  // stdio must silence git's own stderr, not merely catch the throw. "Path exists on disk
  // but not in <sha>" is the EXPECTED answer here — it is how we learn a file is ours — and
  // letting a dozen lines beginning `fatal:` scroll past above a green verdict teaches the
  // reader to distrust the verdict. A check whose normal operation looks like failure gets
  // ignored, which costs more than the check is worth.
  try {
    return {
      ok: true,
      out: execFileSync("git", args, {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      })
    };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message || "") };
  }
}

function parseArgs(argv) {
  const options = { since: null, upstream: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--since") options.since = argv[++i] ?? null;
    else if (argv[i] === "--upstream") options.upstream = argv[++i] ?? null;
    else fail(2, `Unknown argument: ${argv[i]}`);
  }
  if (!options.since) fail(2, "--since <tag-or-sha> is required: the release you are writing notes for");
  return options;
}

function markedUpstream() {
  // Read the sha check-upstream.mjs last marked reviewed, so both checks mean the same thing
  // by "upstream". Silence here is not fatal — the caller can pass --upstream explicitly.
  try {
    const state = JSON.parse(fs.readFileSync(MARKER, "utf8"));
    return state.reviewedSha || state.sha || state.marker || null;
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
const upstream = options.upstream || markedUpstream();

if (!upstream) {
  fail(2, `No upstream ref. Pass --upstream <sha>, or let ${MARKER} supply one.`);
}

const sinceCheck = gitQuiet(["rev-parse", "--verify", `${options.since}^{commit}`]);
if (!sinceCheck.ok) fail(2, `--since ${options.since} is not a commit: ${sinceCheck.out.trim()}`);

const upstreamCheck = gitQuiet(["rev-parse", "--verify", `${upstream}^{commit}`]);
if (!upstreamCheck.ok) {
  fail(2, `Upstream ${upstream} is not a commit here. Fetch it first: ${upstreamCheck.out.trim()}`);
}

const changed = git(["diff", "--name-only", `${options.since}..HEAD`])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (changed.length === 0) {
  console.log(`No files changed between ${options.since} and HEAD. Nothing to disclose.`);
  process.exit(0);
}

const inherited = [];
const ours = [];

for (const file of changed) {
  // The question is about the version we STARTED from, not what we have now: the entry
  // describes a defect that existed in the code as it was before this release.
  const before = gitQuiet(["rev-parse", `${options.since}:${file}`]);
  const theirs = gitQuiet(["rev-parse", `${upstream}:${file}`]);

  if (!theirs.ok) {
    ours.push({ file, why: "not present upstream" });
    continue;
  }
  if (!before.ok) {
    // New file in this release, and upstream has one by that name. Worth a human look.
    inherited.push({ file, why: "new here, but upstream has a file at this path" });
    continue;
  }
  if (before.out.trim() === theirs.out.trim()) {
    inherited.push({ file, why: "byte-identical to upstream before this release" });
  } else {
    ours.push({ file, why: "already diverged" });
  }
}

console.log(`Release range : ${options.since}..HEAD  (${changed.length} file(s) changed)`);
console.log(`Upstream ref  : ${upstream}\n`);

if (inherited.length === 0) {
  console.log("No changed file was inherited from upstream unchanged.");
  console.log("No release-note entry is a disclosure on that basis.");
  console.log("\n⚠ Still your judgement: a file we had already diverged from can carry a defect");
  console.log("  that upstream still ships in another form. This narrows what to read, not what to think.");
  process.exit(0);
}

console.log("INHERITED — any note describing a defect in these files also tells the world");
console.log("upstream still ships it. Describe the FIX, not the DEFECT, or report privately first:\n");
for (const entry of inherited) {
  console.log(`  ${entry.file}`);
  console.log(`      ${entry.why}`);
}

if (ours.length > 0) {
  console.log("\nOurs (already diverged or absent upstream):\n");
  for (const entry of ours) console.log(`  ${entry.file}  — ${entry.why}`);
}

console.log("\nRead the notes for the files above before publishing.");
process.exit(1);
