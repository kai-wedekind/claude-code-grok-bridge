/**
 * The documented surface and the code agree.
 *
 * Five divergences, found 2026-07-31 by a review pass whose whole question was "does the surface
 * keep its promises?". Individually small; together they are the answer, and the answer
 * matters to exactly one person: whoever read the documentation and scripted against it.
 *
 *   (a) the plain-review payload had no `rawOutput` — the field the README names as where
 *       the auth remedy survives, in the row about authentication
 *   (b) a critique that failed on `not-authenticated` was headed "Grok did not return valid
 *       structured JSON", sending the reader to debug a schema over a lapsed login
 *   (c) two exit-table rows claimed "Applies to: all"
 *   (d) `stop --json` returned different keys depending on which branch it took
 *   (e) printUsage and the README knew different flags, in both directions
 *
 * (c) and (e) are documentation-only and are asserted here against the code, so the next
 * flag that appears on one side has to appear on the other.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { renderReviewResult } from "../plugins/grok-build/scripts/lib/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Normalised: the working copy is CRLF on Windows and LF in the repository, so any anchor
// written with "\n" matches on one machine and silently not on the other.
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const BRIDGE = read("plugins/grok-build/scripts/grok-bridge.mjs");
const README = read("README.md");

/* (a) --------------------------------------------------------------------------------- */

test("the plain-review payload carries rawOutput, which the README promises", () => {
  // Reading the source rather than running a review: the assertion is about the payload's
  // shape, and a full review needs a repository, a fake CLI and a state root to produce one.
  const plainPayload = BRIDGE.slice(BRIDGE.indexOf("  const payload = {\n    review: reviewName"));
  const body = plainPayload.slice(0, plainPayload.indexOf("\n  };"));

  assert.match(body, /rawOutput:/, "the field the README names as where the remedy survives");
  assert.match(README, /remedy \(`grok login --device-code`, or `XAI_API_KEY`\) is preserved in `rawOutput`/);
});

/* (b) --------------------------------------------------------------------------------- */

test("an unauthenticated critique says so instead of blaming the JSON", () => {
  const rendered = renderReviewResult(
    { parsed: null, parseError: null, rawOutput: "" },
    {
      reviewLabel: "Critique",
      targetLabel: "working tree diff",
      failureCode: "not-authenticated",
      failureMessage: "Not authenticated. Run `grok login --device-code`."
    }
  );

  assert.doesNotMatch(
    rendered,
    /did not return valid structured JSON/,
    "the schema is not the problem and saying so costs the reader a debugging session"
  );
  assert.match(rendered, /signed in/i);
  assert.match(rendered, /grok login --device-code/);
});

test("every failure class that cannot be retried has a headline of its own", () => {
  // The property, rather than a list that drifts: RETRY_CANNOT_HELP names the failures where
  // doing the same thing again cannot work, so those are exactly the ones whose headline has
  // to tell the reader to do something else.
  const declared = BRIDGE.match(/const RETRY_CANNOT_HELP = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, "RETRY_CANNOT_HELP must still be a literal set to read");
  const codes = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(codes.length >= 2);

  for (const code of codes) {
    const rendered = renderReviewResult(
      { parsed: null, parseError: null, rawOutput: "" },
      { reviewLabel: "Critique", targetLabel: "t", failureCode: code, failureMessage: "m" }
    );
    assert.doesNotMatch(
      rendered,
      /did not return valid structured JSON/,
      `${code} falls through to the default headline`
    );
  }
});

/* (c) --------------------------------------------------------------------------------- */

test("no exit-table row claims to apply to every command", () => {
  const rows = README.split("\n").filter((line) => /^\| (`(0|2|3)`|non-zero)/.test(line.trim()));
  assert.ok(rows.length >= 8, `the exit table must still be findable (found ${rows.length} rows)`);

  for (const row of rows) {
    const appliesTo = row.split("|")[3] ?? "";
    assert.doesNotMatch(
      appliesTo,
      /^\s*all\s*$/,
      `"${row.trim()}" claims to apply to all commands; import, check, runs, show, stop, ` +
        `threads, clean and usage never call Grok and produce no failureCode`
    );
  }
});

/* (d) --------------------------------------------------------------------------------- */

test("both stop payloads carry the same keys", () => {
  const keysOf = (anchor) => {
    const start = BRIDGE.indexOf(anchor);
    assert.notEqual(start, -1, `payload not found: ${anchor}`);
    const body = BRIDGE.slice(start, BRIDGE.indexOf("};", start));
    return new Set([...body.matchAll(/^\s{4,6}([A-Za-z][\w]*):/gm)].map((match) => match[1]));
  };

  const gated = keysOf("      jobId: job.id,\n      status: claim.status,");
  const killed = keysOf("  const payload = {\n    jobId: job.id,\n    status: \"cancelled\",");

  assert.deepEqual(
    [...gated].sort(),
    [...killed].sort(),
    "a caller cannot branch on a field that is present on one path and absent on the other"
  );
});

/* (e) --------------------------------------------------------------------------------- */

test("printUsage and the README know the same flags", () => {
  const usageBlock = BRIDGE.slice(BRIDGE.indexOf("function printUsage()"));
  const usageText = usageBlock.slice(0, usageBlock.indexOf("].join"));
  const usageFlags = new Set([...usageText.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0]));
  const readmeFlags = new Set([...README.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0]));

  // Flags the usage screen lists but the README never mentions anywhere. The reverse
  // direction is not asserted: the README documents CLI flags of the grok binary itself
  // (--agent, --deny, --output-format) that this bridge's own usage screen has no business
  // listing.
  const missingFromReadme = [...usageFlags].filter((flag) => !readmeFlags.has(flag));

  assert.deepEqual(
    missingFromReadme,
    [],
    "every flag the usage screen offers has to be documented somewhere in the README"
  );
});
