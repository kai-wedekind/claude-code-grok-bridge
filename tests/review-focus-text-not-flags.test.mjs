/**
 * Focus text handed to `review`/`critique` is text, not a place to hide flags.
 *
 * `run` learned this when "--write" inside a task description was found to grant the agent
 * write access. review and critique share the parser and the shape — trailing positionals
 * joined into a prompt — and were left on the default, where option parsing continues to the
 * end of the line.
 *
 * The three that matter, in order of quietness:
 *
 *   --json      flips the output format out from under a caller that parses text
 *   --base X    swallows the next word AND reviews a different range than the user asked for
 *   --cwd P     points the entire review at another directory
 *
 * None of them announce themselves. A user writing "check the --json output path" gets a
 * review of something else, formatted differently, with a word missing from their question.
 *
 * Found 2026-07-31 by a review pass asked to compare sibling code paths against each other.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../plugins/grok-build/scripts/lib/args.mjs";

// The exact configuration handleReviewCommand passes. Kept in sync by the last test below,
// which reads the source: a copy that drifts would pass while the real parser regressed.
const REVIEW_PARSE_CONFIG = {
  valueOptions: ["base", "scope", "model", "effort", "cwd", "timeout-ms", "max-turns"],
  booleanOptions: ["json", "background", "wait"],
  stopAtFirstPositional: true,
  aliasMap: { m: "model" }
};

function parseReview(argv) {
  const { options, positionals } = parseArgs(argv, REVIEW_PARSE_CONFIG);
  return { options, focusText: positionals.join(" ").trim() };
}

test("a flag-shaped word inside focus text stays in the focus text", () => {
  const { options, focusText } = parseReview([
    "focus", "on", "the", "--json", "flag", "and", "--base", "handling"
  ]);

  assert.equal(focusText, "focus on the --json flag and --base handling");
  assert.equal(options.json, undefined, "--json inside focus text must not change the format");
  assert.equal(options.base, undefined, "--base inside focus text must not change the range");
});

test("a --cwd hidden in focus text cannot redirect the review", () => {
  const { options, focusText } = parseReview(["why", "does", "--cwd", "C:\\elsewhere", "differ"]);

  assert.equal(options.cwd, undefined, "the review must stay where the user ran it");
  assert.equal(focusText, "why does --cwd C:\\elsewhere differ");
});

test("flags before the first focus word still work exactly as documented", () => {
  const { options, focusText } = parseReview([
    "--base", "main", "--effort", "high", "--json", "the", "retry", "path"
  ]);

  assert.equal(options.base, "main");
  assert.equal(options.effort, "high");
  assert.equal(options.json, true);
  assert.equal(focusText, "the retry path");
});

test("the configuration above is the one the review command actually uses", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = fs.readFileSync(
    path.join(root, "plugins/grok-build/scripts/grok-bridge.mjs"),
    "utf8"
  );
  const body = source.slice(source.indexOf("async function handleReviewCommand"));
  const call = body.slice(0, body.indexOf("});"));

  assert.match(
    call,
    /stopAtFirstPositional:\s*true/,
    "handleReviewCommand must opt into first-positional-ends-options; without it the tests " +
      "above pass against a local copy while the real command still reads focus text as flags"
  );
});
