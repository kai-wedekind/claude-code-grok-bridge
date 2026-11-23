#!/usr/bin/env node
/**
 * Keep the test count the README advertises in step with the suite that exists.
 *
 * WHY THIS EXISTS. The README once claimed 316 unit tests while the suite was 333, and an
 * outside reviewer found it before we did — the number had been typed, and a typed number
 * is a copy of a fact owned somewhere else. A copy cannot notice that the original moved.
 * It was later "fixed" by deleting the claim, which removes the drift by removing the
 * statement; that is a loss, because the number is worth advertising.
 *
 * So: state it, and make drift a failure rather than an embarrassment.
 *
 * WHAT IT DOES NOT DO. It is deliberately not wired into `npm test`. The number is a
 * published claim and only has to be true at publication, and doubling every local test
 * run to verify a marketing string would be a bad trade. It belongs in the release
 * procedure, next to `check-version` and `check-upstream`.
 *
 * EXIT CODES, matching check-upstream.mjs so a caller can branch the same way:
 *   0  the README agrees with the suite
 *   1  they disagree — the README is stale, or the suite changed
 *   2  the check itself could not run
 *
 * ⚠ 2 IS NOT AN ALL-CLEAR. A missing anchor phrase, an unparseable TAP summary or a suite
 * that never produced a count all land here rather than silently passing. A checker that
 * reports success when it could not check is the exact defect this repository exists to
 * argue against, and it would be absurd to ship one.
 *
 * USAGE
 *   node scripts/check-test-count.mjs                     run the suite, then compare
 *   node scripts/check-test-count.mjs --tap <file>        reuse a TAP file already produced
 *   node scripts/check-test-count.mjs --write             update the README instead of failing
 *
 * `--tap` matters during a release: the suite has already run, and running it again to
 * count what it just counted wastes minutes and invites the two runs to disagree.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = path.join(ROOT, "README.md");

// The anchor is ordinary prose rather than a marker comment, because the number exists to
// be read. Every occurrence is updated: the count is quotable and will end up in more than
// one sentence, and updating only the first is how half a document goes stale.
const ANCHOR = /(\d[\d,]*)(\s+unit tests)/g;

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { write: false, tap: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--tap") options.tap = argv[++i] ?? null;
    else fail(2, `Unknown argument: ${arg}`);
  }
  if (options.tap === null && argv.includes("--tap")) fail(2, "--tap needs a file path");
  return options;
}

/**
 * Read the total from a TAP summary. Node's runner prints `# tests N` for the total and
 * `# pass N` for those that passed; the README advertises the size of the suite, so the
 * total is the honest number — a suite of 335 with one skip is still 335 tests.
 */
function countFromTap(tap) {
  const match = /^# tests (\d+)$/m.exec(tap);
  if (!match) return null;
  return Number(match[1]);
}

function runSuite() {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "run-tests.mjs"), "--test-reporter=tap"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error) fail(2, `Could not run the suite: ${result.error.message}`);
  // A failing suite still reports its totals, and the count is what we are after. Say that
  // the suite failed, but do not turn a red suite into a count of zero.
  if (result.status !== 0) {
    console.error(`Note: the suite exited ${result.status}. Counting anyway; fix the suite separately.`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const options = parseArgs(process.argv.slice(2));

let tap;
if (options.tap) {
  if (!fs.existsSync(options.tap)) fail(2, `No TAP file at ${options.tap}`);
  tap = fs.readFileSync(options.tap, "utf8");
} else {
  tap = runSuite();
}

const actual = countFromTap(tap);
if (actual === null) {
  fail(2, "No `# tests N` line in the TAP output — the count could not be determined. This is NOT an all-clear.");
}
if (actual === 0) {
  fail(2, "The suite reported 0 tests. That is a broken run, not a small suite.");
}

// ⚠ EVERY DOCUMENT THAT STATES THE NUMBER, not only the README. This gate watched one file, so
// the count drifted in the other: on 2026-08-09 it auto-corrected README.md to 437 in the same
// commit that left CHANGELOG.md claiming 429, and nothing objected — the release notes were the
// one place no gate read. A drift check that covers some of the copies produces exactly the
// confidence that stops anyone checking the rest. Found by adversarial verification of the
// release's own claims.
//
// CHANGELOG entries for OLD releases are deliberately not touched: "429 unit tests" in the
// 0.3.2 notes is a record of what was true then, not a claim about now. Only the topmost
// release section is checked, because that is the one being written.
//
// ⚠ AND ONLY WHILE IT IS BEING WRITTEN. Between releases the topmost section IS the last
// published one, and this gate's own `--write` advice would then rewrite its "Verified" count
// — a published record silently falsified by the check meant to keep counts honest. A section
// whose version already has a `v<version>` tag is released and is skipped; assemble the next
// release's section first, then run this.
//
// A failed tag lookup must not count as "not released", or `--write` would rewrite the
// published section whenever git could not be asked. A checkout with no tags at
// all does the same — every section looks unreleased — and that is not an all-clear either.
function isReleased(version) {
  const tags = spawnSync("git", ["-C", ROOT, "tag", "-l"], { encoding: "utf8" });
  if (tags.error || tags.status !== 0) {
    const why = tags.error ? tags.error.message : `git exited ${tags.status}`;
    fail(2, `Could not ask git whether ${version} is already released (${why}). This is NOT an all-clear.`);
  }
  const names = tags.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (names.length === 0) {
    fail(
      2,
      `Could not ask git whether ${version} is already released: this checkout has no tags, so a released section cannot be told from an unreleased one. This is NOT an all-clear.`
    );
  }
  return names.includes(`v${version}`);
}

const TARGETS = [
  { label: "README.md", file: README, scope: (text) => ({ start: 0, end: text.length }) },
  {
    label: "CHANGELOG.md (current release section)",
    file: path.join(ROOT, "CHANGELOG.md"),
    scope: (text) => {
      const first = text.indexOf("## [");
      if (first === -1) return null;
      const version = /^## \[([^\]]+)\]/.exec(text.slice(first))?.[1];
      if (version && isReleased(version)) {
        console.log(`CHANGELOG.md: topmost section ${version} is already released (tag v${version}); not checked`);
        return null;
      }
      const next = text.indexOf("## [", first + 4);
      return { start: first, end: next === -1 ? text.length : next };
    }
  }
];

let anyClaim = false;
let anyStale = false;
let wrote = 0;

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) continue;
  const text = fs.readFileSync(target.file, "utf8");
  const scope = target.scope(text);
  if (!scope) continue;
  const region = text.slice(scope.start, scope.end);
  const found = [...region.matchAll(ANCHOR)].map((m) => Number(m[1].replace(/,/g, "")));
  if (found.length === 0) continue;
  anyClaim = true;
  const bad = found.filter((n) => n !== actual);
  if (bad.length === 0) {
    console.log(`${target.label}: agrees at ${actual} (${found.length} place(s))`);
    continue;
  }
  anyStale = true;
  if (options.write) {
    const fixed = region.replace(ANCHOR, (_all, _n, tail) => `${actual}${tail}`);
    fs.writeFileSync(target.file, text.slice(0, scope.start) + fixed + text.slice(scope.end));
    wrote += bad.length;
    console.log(`${target.label}: updated ${bad.length} claim(s) to ${actual}`);
  } else {
    console.error(`${target.label}: claims ${bad.join(", ")} but the suite has ${actual}`);
  }
}

if (!anyClaim) {
  fail(
    2,
    `The suite has ${actual} tests, but no document makes a claim to check.\n` +
      `Add a sentence containing "${actual} unit tests" to README.md or the current CHANGELOG section.\n` +
      `--write only updates an existing claim; it does not invent a place to put one.`
  );
}

if (options.write) {
  console.log(wrote === 0 ? `Everything already says ${actual}.` : `Updated ${wrote} claim(s).`);
  process.exit(0);
}

if (anyStale) {
  fail(1, `Documentation disagrees with the suite (${actual} tests). Run with --write to fix.`);
}

console.log(`Documentation agrees with the suite: ${actual} unit tests.`);
process.exit(0);
