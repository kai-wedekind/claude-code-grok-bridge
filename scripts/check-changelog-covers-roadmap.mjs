#!/usr/bin/env node
/**
 * Does the changelog cover every roadmap item that shipped in this release?
 *
 * ⚠ WHY THIS EXISTS. The 0.3.3 notes were written from memory of the work, then filtered by
 * "was this code public before the last release?". That filter is right for BUGS — a defect
 * introduced and fixed inside one cycle was never anyone's problem and does not belong in
 * release notes. It is useless for FEATURES, because a new feature is by definition not public
 * before, so the filter can never surface one. The result: the churn was correctly cut, and
 * the release's headline addition — an update notifier that makes the plugin's first ever
 * outbound network request — was silently absent, along with eight other user-visible items.
 * It took two rounds of human correction to find that.
 *
 * The rule, from Kai, 2026-08-09: **everything on the roadmap goes into the changelog, except a
 * bug freshly introduced by that same roadmap work. A new feature can never be missed.**
 *
 * So the source of truth is the roadmap, not recollection, and this makes that mechanical.
 * The roadmap is an internal artifact and lives outside this repository, so the path is passed
 * in; with no path this SKIPS LOUDLY rather than passing, because "I could not check" and
 * "I checked and it was fine" are the two states this project keeps proving must stay apart.
 *
 *   node scripts/check-changelog-covers-roadmap.mjs --roadmap <file.html> [--version 0.3.3]
 *
 * It cannot judge whether an entry is well written — only whether each shipped id is accounted
 * for, either by a changelog entry or by an explicit exclusion here with a reason. That is the
 * part that was failing.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const roadmapPath = arg("roadmap");
const changelogPath = path.join(REPO, "CHANGELOG.md");

if (!roadmapPath) {
  console.error(
    "SKIPPED: no --roadmap given, so changelog coverage was NOT checked.\n" +
      "  This is a gap, not a pass. Pass the internal roadmap:\n" +
      "  node scripts/check-changelog-covers-roadmap.mjs --roadmap <path-to-roadmap.html>"
  );
  process.exit(2);
}
if (!fs.existsSync(roadmapPath)) {
  console.error(`SKIPPED: roadmap not found at ${roadmapPath} — coverage NOT checked.`);
  process.exit(2);
}

const html = fs.readFileSync(roadmapPath, "utf8");
const changelog = fs.readFileSync(changelogPath, "utf8");

const version = arg("version", (changelog.match(/## \[([0-9.]+)\]/) ?? [])[1]);
if (!version) {
  console.error("Could not determine the release version from CHANGELOG.md.");
  process.exit(1);
}
const start = changelog.indexOf(`## [${version}]`);
const next = changelog.indexOf("## [", start + 4);
const section = changelog.slice(start, next === -1 ? undefined : next);

/**
 * Ids whose roadmap work is deliberately NOT in the notes, each with the reason. An entry here
 * is a decision on the record; an id missing from both is the failure this script exists for.
 */
const EXCLUDED = new Map([
  ["P00", "the roadmap board itself — a maintainer artifact, not shipped"],
  ["P00a", "the disclosure rule — process, not product"],
  ["A02", "deploy-local.sh — maintainer tool, never installed"],
  ["A03", "a stale test count in the README, folded into the documentation entry"],
  ["A07", "tests that did not reach their own assertion — test-only"],
  ["R02a", "a bug introduced BY R02 inside this cycle; never public"],
  ["R03", "a source comment that overstated what was proven — no user-visible effect"],
  ["R04", "guard tests — test-only"],
  ["R09a", "docs left behind by R09, folded into the documentation entry"],
  ["R10", "two comments that overstated what was proven — no user-visible effect"],
  ["R11", "test temp-directory cleanup — test-only"]
]);

const built = [];
for (const row of html.match(/<tr[^>]*data-id="[^"]+"[\s\S]*?<\/tr>/g) ?? []) {
  const id = row.match(/data-id="([^"]+)"/)[1];
  const isBuilt = /data-stage="built"[^>]*checked/.test(row);
  if (isBuilt) built.push(id);
}

if (built.length === 0) {
  console.error("No roadmap rows are marked built — is this the right file?");
  process.exit(1);
}

const missing = built.filter((id) => !EXCLUDED.has(id) && !section.includes(id) && !mentioned(id));

/**
 * A changelog is written for users, so it does not carry roadmap ids. Coverage is therefore
 * asserted by a keyword each item is required to name — deliberately narrow, so a vague entry
 * cannot satisfy it. Anything not listed here must be in EXCLUDED with a reason, which is what
 * makes "I forgot" impossible to express: a new id fails until somebody decides which it is.
 */
function mentioned(id) {
  const keywords = {
    A01: ["which build is actually running", "install directory"],
    A04: ["headline twice", "Details:"],
    A05: ["because a message said so", "operating system agreed"],
    A06: ["identify the process it killed"],
    R01: ["symlink or junction"],
    R02: ["removes fourteen", "four tools"],
    R05: ["web_fetch"],
    R06: ["blank lines"],
    R08: ["--strands", "subagents"],
    R09: ["--verify-tools"],
    R12: ["newer release exists", "GROK_CC_UPDATE_CHECK"],
    R13: ["import"],
    R14: ["backslashes"]
  }[id];
  if (!keywords) return false;
  return keywords.some((k) => section.includes(k));
}

console.log(`Roadmap items marked built: ${built.length}`);
console.log(`Excluded with a stated reason: ${EXCLUDED.size}`);
console.log(`Checked against CHANGELOG [${version}]`);

if (missing.length) {
  console.error(`\nNOT COVERED by the ${version} notes, and not excluded with a reason:\n`);
  for (const id of missing) console.error(`  ${id}`);
  console.error(
    "\nEvery roadmap item that shipped belongs in the notes, except a bug this same cycle\n" +
      "introduced. If one of these is such a bug — or is genuinely not user-visible — add it to\n" +
      "EXCLUDED with the reason, so the decision is recorded rather than forgotten."
  );
  process.exit(1);
}

console.log("\nEvery shipped roadmap item is either in the notes or excluded with a reason.");
