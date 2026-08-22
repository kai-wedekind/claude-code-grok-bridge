#!/usr/bin/env node
// Gate the documented read-only removal list against the one the code actually ships.
//
// WHY THIS EXISTS. On 2026-08-08 the list gained `scheduler_list` — not for protection, but
// because the CLI's tools declare requirements on each other and removing `scheduler_create`
// without it stops the session from starting at all. The code was fixed and the README was
// not, which left two copy-pasteable `grok --disallowed-tools …` launch lines in the public
// documentation carrying **exactly the combination that cannot start a session**, plus three
// prose claims that thirteen tools are removed when fourteen are.
//
// That is the copy-with-no-way-of-noticing problem, and prose cannot be told to re-read a
// constant. So it gets asked mechanically, the same way `check-test-count.mjs` asks about the
// test count. Exit codes match that script: 0 agree, 1 drift, 2 could not check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");
const DOCS = ["README.md", "SECURITY.md"];

const NUMBER_WORDS = {
  10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
  15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen", 20: "twenty"
};

let tools;
try {
  ({ READ_ONLY_DISALLOWED_TOOLS: tools } = await import(`file:///${BRIDGE.replace(/\\/g, "/")}`));
} catch (error) {
  console.error(`Could not read READ_ONLY_DISALLOWED_TOOLS from the bridge: ${error.message}`);
  process.exit(2);
}
if (!Array.isArray(tools) || tools.length === 0) {
  console.error("READ_ONLY_DISALLOWED_TOOLS is missing or empty — nothing to check against.");
  process.exit(2);
}

const expectedCsv = tools.join(",");
const expectedWord = NUMBER_WORDS[tools.length];
const problems = [];
let listSites = 0;
let countSites = 0;

for (const rel of DOCS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.error(`${rel} is missing — cannot check the documented list.`);
    process.exit(2);
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;

    // Every literal launch line must be the shipped list, in the shipped order. Order matters
    // because the doc is meant to be pasted: a reordered copy is a different command to read.
    const csv = /--disallowed-tools\s+([A-Za-z0-9_,]+)/.exec(line);
    if (csv) {
      listSites += 1;
      if (csv[1] !== expectedCsv) {
        const shown = new Set(csv[1].split(","));
        const missing = tools.filter((t) => !shown.has(t));
        const extra = [...shown].filter((t) => !tools.includes(t));
        problems.push(
          `${at}: documented --disallowed-tools does not match the shipped list` +
            (missing.length ? `\n    missing: ${missing.join(", ")}` : "") +
            (extra.length ? `\n    not in the list: ${extra.join(", ")}` : "") +
            (!missing.length && !extra.length ? " (same ids, different order)" : "")
        );
      }
    }

    // "removes thirteen tools" and friends. Only the spelled-out form is checked, because that
    // is the form the documentation actually uses; a bare digit would match too much prose.
    const word = /remov(?:es|ing)\s+([a-z]+)\s+tools/i.exec(line);
    if (word) {
      countSites += 1;
      if (word[1].toLowerCase() !== expectedWord) {
        problems.push(
          `${at}: says "${word[1]} tools", but the list holds ${tools.length} (${expectedWord})`
        );
      }
    }
  });
}

if (listSites === 0 && countSites === 0) {
  // Silence here would mean "the docs agree", when it actually means the gate found nothing to
  // check — the same false green this repository keeps closing elsewhere.
  console.error("Found no documented tool list and no count claim. The gate is looking in the wrong place.");
  process.exit(2);
}

if (problems.length > 0) {
  console.error(`The documentation disagrees with READ_ONLY_DISALLOWED_TOOLS (${tools.length} ids):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nShipped list:\n  ${expectedCsv}`);
  process.exit(1);
}

console.log(
  `Docs agree with the shipped list: ${tools.length} ids, ` +
    `${listSites} launch line(s) and ${countSites} count claim(s) checked.`
);
