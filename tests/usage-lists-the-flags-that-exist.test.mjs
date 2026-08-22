/**
 * `printUsage` is what someone reads when they run the bridge with no arguments, and it drifts
 * silently: a flag gets added, wired up, documented in the README and in the command markdown,
 * and the usage block never learns about it. Found 2026-08-09 by an audit that compared the
 * README's "Bridge CLI surface" section against the code and found three flags live in the
 * parser and absent from both — `check --verify-tools`, `check --fetch-update` and
 * `show --strands`, the last of which had shipped that same day.
 *
 * The guard is derived rather than listed: it reads the flags the PARSER actually accepts for
 * each command and requires the usage text to mention them. A hand-written list would be one
 * more copy to drift, which is the defect rather than the fix.
 */
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const BRIDGE = path.resolve("plugins/grok-build/scripts/grok-bridge.mjs");

function usageText() {
  const run = spawnSync(process.execPath, [BRIDGE], { encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, `bridge with no arguments must print usage: ${run.stderr}`);
  return run.stdout;
}

// Collect the option names the argument parser is configured with. Both list forms are
// used in this file: `booleanOptions: ["a", "b"]` and `valueOptions: [...]`.
function harvestDeclaredFlags(source) {
  const declared = new Set();
  for (const match of source.matchAll(/(?:boolean|value)Options:\s*\[([^\]]*)\]/gs)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^["'`]|["'`]$/g, "");
      if (/^[a-z][a-z0-9-]*$/.test(name)) declared.add(name);
    }
  }
  return declared;
}

test("every long flag the parser accepts appears in the usage block", () => {
  const source = fs.readFileSync(BRIDGE, "utf8");
  const declared = harvestDeclaredFlags(source);
  assert.ok(declared.size > 10, `expected to find the parser's option lists, found ${declared.size}`);

  const usage = usageText();

  // ⚠ Not every declared option belongs in the usage block: some are internal test knobs and
  // some are aliases. Anything deliberately omitted is listed HERE, with a reason, so that
  // omission is a decision on the record rather than an oversight that looks like one.
  const deliberatelyUnlisted = new Map([
    ["include-test-workspaces", "listed on the usage line for `usage` already; kept out of others"],
    ["job-id", "internal to run-worker, the entry point the bridge spawns itself with"],
    ["workspace-root", "internal to run-worker, the entry point the bridge spawns itself with"]
  ]);

  const missing = [...declared]
    .filter((name) => !usage.includes(`--${name}`))
    .filter((name) => !deliberatelyUnlisted.has(name));

  assert.deepEqual(
    missing,
    [],
    `these flags are accepted by the parser but never mentioned in the usage block: ${missing.join(", ")}`
  );
});

test("the usage block does not advertise flags that do not exist", () => {
  // The mirror of the test above, and the more embarrassing direction: telling someone about a
  // flag that was removed sends them to an error message instead of a result.
  const source = fs.readFileSync(BRIDGE, "utf8");
  const declared = harvestDeclaredFlags(source);
  const usage = usageText();

  const advertised = new Set(
    [...usage.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1])
  );
  // `--cwd` and `--json` are described in prose rather than per line, and the env section
  // names variables rather than flags; both are real. Membership is the harvested
  // booleanOptions/valueOptions set, not a raw-source substring — a leftover quote in
  // printUsage or a comment would otherwise keep a removed flag looking accepted.
  const phantom = [...advertised].filter((name) => !declared.has(name));

  assert.deepEqual(phantom, [], `usage advertises flags the code does not accept: ${phantom.join(", ")}`);
});
