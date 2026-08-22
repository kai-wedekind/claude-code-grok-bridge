/**
 * Containment of the subagent reader. Both cases below were CONFIRMED as live defects on
 * 2026-08-09 by driving the shipped module against a hostile session tree, and both were
 * introduced the same day by the reader itself — the code that exists to report what a run's
 * subagents produced was willing to report things that were not that.
 *
 * 1. A directory junction under `subagents/` escaped the session tree. `isDirectory` uses
 *    `statSync`, which follows links, so the link read as an ordinary child and its target's
 *    `output.json` was loaded and rendered as a strand of this run. Child NAMES cannot escape
 *    (they come from `readdirSync`), which is exactly why a name-based guard is insufficient:
 *    the escape is the link, not the name.
 *
 * 2. `encodeURIComponent` throws `URIError` on a lone UTF-16 surrogate. It sat on the fast
 *    path in front of the fallback scan, unguarded, so one such character in a directory name
 *    turned a lookup that would otherwise have succeeded into an exception that escaped
 *    `collectSubagentEvidence` — and the job then rendered as "no fan-out" rather than as an
 *    error.
 *
 * Each test carries a CONTROL asserting the legitimate path still works. Without it, the fix
 * "reader returns nothing at all" would pass both, which is how a containment test quietly
 * becomes vacuous.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { readSubagentStrands, findSessionDir, collectSubagentEvidence } from "../plugins/grok-build/scripts/lib/subagents.mjs";
import { makeTempDir } from "./helpers.mjs";

const SESSION = "parent-session-1";
const CWD = "C:/some/project";

function meta(id) {
  return JSON.stringify({
    subagent_id: id, child_session_id: id, parent_session_id: SESSION,
    subagent_type: "explore", description: "a strand", prompt: "do the thing",
    status: "completed", started_at: "2026-08-09T00:00:00.000000000Z",
    completed_at: "2026-08-09T00:01:00.000000000Z", duration_ms: 60000,
    tool_calls: 7, turns: 1, capability_mode: "read-only", effective_model_id: "grok-4.5"
  });
}
const output = (text) => JSON.stringify({ schema_version: 1, output: text });

function plantStrandDir(dir, id, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), meta(id), "utf8");
  fs.writeFileSync(path.join(dir, "output.json"), output(text), "utf8");
}

test("an entry resolving outside the session tree is not read as a strand", (t) => {
  const root = makeTempDir();
  const grokHome = path.join(root, "grokhome");
  const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(CWD), SESSION);
  const subagents = path.join(sessionDir, "subagents");
  fs.mkdirSync(subagents, { recursive: true });

  plantStrandDir(path.join(subagents, "child-good"), "child-good", "LEGITIMATE-STRAND");

  const outside = path.join(root, "outside-the-session");
  plantStrandDir(outside, "child-link", "ESCAPED-CONTENT-FROM-OUTSIDE");

  try {
    fs.symlinkSync(outside, path.join(subagents, "child-link"), "junction");
  } catch {
    // Creating a junction needs no elevation on Windows and none on Linux/macOS for a
    // symlink, but if the filesystem refuses it there is nothing to test — and a silent pass
    // would be worse than a loud skip, so say why.
    t.skip("could not create a directory junction from subagents/ to a path outside the session tree; without the escape this test would certify nothing");
    return;
  }

  const stats = {};
  const strands = readSubagentStrands(sessionDir, { stats });
  const blob = JSON.stringify(strands);

  // CONTROL FIRST: if the legitimate strand stopped being read, every assertion below would
  // pass for the wrong reason.
  assert.ok(blob.includes("LEGITIMATE-STRAND"), "the legitimate strand must still be read");
  assert.equal(strands.length, 1, "only the contained strand is a strand of this run");
  assert.ok(!blob.includes("ESCAPED-CONTENT-FROM-OUTSIDE"), "content from outside the session tree must not be read");
  assert.equal(stats.droppedOutsideTree, 1, "the escaping entry is counted, not silently skipped");
});

test("a cwd containing a lone surrogate falls back to the scan instead of throwing", () => {
  const root = makeTempDir();
  const grokHome = path.join(root, "grokhome");
  const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(CWD), SESSION);
  fs.mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
  plantStrandDir(path.join(sessionDir, "subagents", "child-good"), "child-good", "LEGITIMATE-STRAND");

  // `\uD800` is a high surrogate with no low surrogate after it: encodeURIComponent throws.
  const hostileCwd = "C:\\proj\uD800";

  const found = findSessionDir(SESSION, { grokHome, cwd: hostileCwd });
  assert.equal(found, sessionDir, "the fallback scan must still find the session by id");

  const evidence = collectSubagentEvidence(SESSION, { grokHome, cwd: hostileCwd });
  assert.ok(evidence, "evidence must be returned, not lost to a URIError");
  assert.equal(evidence.strands.length, 1);

  // CONTROL: the ordinary fast path is unaffected.
  assert.equal(findSessionDir(SESSION, { grokHome, cwd: CWD }), sessionDir);
});

test("a directory of nothing but an escaping link still reports the escape", (t) => {
  // ⚠ THE DARK PATH OF THIS WHOLE FEATURE, and the test above cannot reach it. That one plants
  // a legitimate strand first — correctly, as the control that makes it valid — which means
  // `strands.length` is never zero, which means it never exercises the gate in
  // `collectSubagentEvidence` that used to `return null` whenever no strand survived.
  //
  // So a subagents directory holding ONLY a junction produced: reader counts one escape,
  // collect returns null, caller attaches no evidence, and the warning added for exactly this
  // case never runs. `show` said "no fan-out" while something had planted a link in the CLI's
  // session directory. Measured 2026-08-09; found by a code review of the containment fix.
  const root = makeTempDir();
  const grokHome = path.join(root, "grokhome");
  const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(CWD), SESSION);
  const subagents = path.join(sessionDir, "subagents");
  fs.mkdirSync(subagents, { recursive: true });

  const outside = path.join(root, "outside-the-session");
  plantStrandDir(outside, "child-link", "ESCAPED-CONTENT-FROM-OUTSIDE");
  try {
    fs.symlinkSync(outside, path.join(subagents, "child-link"), "junction");
  } catch {
    t.skip("could not create a directory junction from subagents/ to a path outside the session tree; without the escape this test would certify nothing");
    return;
  }

  const evidence = collectSubagentEvidence(SESSION, { grokHome, cwd: CWD });
  assert.ok(evidence, "evidence must be returned even when nothing survived containment");
  assert.equal(evidence.strands.length, 0);
  assert.equal(evidence.droppedOutsideTree, 1, "the escape is the whole finding here");
  assert.ok(
    !JSON.stringify(evidence).includes("ESCAPED-CONTENT-FROM-OUTSIDE"),
    "and still nothing from outside the tree is read"
  );
});
