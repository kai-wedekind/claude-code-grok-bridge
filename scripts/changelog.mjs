#!/usr/bin/env node
/**
 * Changelog fragments: capture the entry when the change is made, assemble at release.
 *
 * The `towncrier` / `changesets` / `reno` convention, implemented in one file with no
 * dependencies, because this project installs nothing from a registry.
 *
 * ⚠ WHY IT EXISTS. The 0.3.3 notes were written at release time from memory of the work, then
 * filtered by "was this code public before?". That filter is correct for a BUG — one introduced
 * and fixed inside a single cycle was never anyone's problem — and useless for a FEATURE, which
 * is never public before. So the churn was cut correctly and the features were invisible: the
 * update notifier, this plugin's first outbound network request, went missing along with eight
 * other user-visible items, and two rounds of human review were what found them.
 *
 * A release-time checker (`check-changelog-covers-roadmap.mjs`) can catch that, and does — but
 * it catches it at the moment when memory is worst. A fragment is written while you still know
 * what you changed and why, which is the actual fix. The roadmap checker stays as the backstop.
 *
 *   node scripts/changelog.mjs check
 *   node scripts/changelog.mjs assemble --version 0.4.0 [--date 2026-09-01]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, "changelog.d");
const CHANGELOG = path.join(REPO, "CHANGELOG.md");

/** Order is the order they appear in a release section; `internal` is never rendered. */
const TYPES = ["added", "changed", "removed", "fixed", "security", "internal"];
const HEADINGS = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security"
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fragments() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((file) => {
      const parts = file.replace(/\.md$/, "").split(".");
      const type = parts.length > 1 ? parts.pop() : null;
      return { file, slug: parts.join("."), type, body: fs.readFileSync(path.join(DIR, file), "utf8").trim() };
    });
}

function check() {
  const all = fragments();
  const bad = [];
  for (const f of all) {
    if (!TYPES.includes(f.type)) {
      bad.push(`${f.file}: type "${f.type}" is not one of ${TYPES.join(", ")}`);
    }
    if (!f.body) {
      // An empty fragment is worse than none: it satisfies a file-exists check while saying
      // nothing, which is the shape of every silent-pass defect this project has found.
      bad.push(`${f.file}: empty — a fragment that says nothing cannot become an entry`);
    }
  }

  console.log(`Fragments: ${all.length}`);
  for (const type of TYPES) {
    const n = all.filter((f) => f.type === type).length;
    if (n) console.log(`  ${type.padEnd(9)} ${n}`);
  }

  if (bad.length) {
    console.error("\nMalformed fragments:\n");
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
  }
  if (all.length === 0) {
    console.log("\nNo fragments pending. That is correct immediately after a release, and a");
    console.log("warning sign at any other time — every change to shipped code should leave one,");
    console.log("even if only to record that it was `internal`.");
  }
  process.exit(0);
}

function assemble() {
  const version = arg("version");
  if (!version) {
    console.error("Need --version, e.g. --version 0.4.0");
    process.exit(1);
  }
  const date = arg("date", new Date().toISOString().slice(0, 10));
  const all = fragments();
  if (all.length === 0) {
    console.error("No fragments to assemble.");
    process.exit(1);
  }

  const lines = [`## [${version}] — ${date}`, ""];
  let rendered = 0;
  for (const type of TYPES) {
    if (type === "internal") continue;
    const group = all.filter((f) => f.type === type);
    if (!group.length) continue;
    lines.push(`### ${HEADINGS[type]}`, "");
    for (const f of group) {
      lines.push(`- ${f.body.replace(/^-\s*/, "")}`, "");
      rendered += 1;
    }
  }

  const dropped = all.filter((f) => f.type === "internal");
  const existing = fs.readFileSync(CHANGELOG, "utf8");
  const anchor = existing.indexOf("## [");
  if (anchor === -1) {
    console.error("Could not find an existing release section to insert above.");
    process.exit(1);
  }
  fs.writeFileSync(CHANGELOG, existing.slice(0, anchor) + lines.join("\n") + "\n" + existing.slice(anchor), "utf8");

  for (const f of all) fs.rmSync(path.join(DIR, f.file));

  console.log(`Wrote ${rendered} entr(y/ies) into CHANGELOG.md as [${version}].`);
  console.log(`Dropped ${dropped.length} internal fragment(s), by design:`);
  for (const f of dropped) console.log(`  ${f.slug}`);
  console.log("\nNow edit the prose. The fragments were a capture mechanism, not a format.");
}

const command = process.argv[2];
if (command === "check") check();
else if (command === "assemble") assemble();
else {
  console.error("Usage: changelog.mjs check | assemble --version <x.y.z> [--date <yyyy-mm-dd>]");
  process.exit(1);
}
