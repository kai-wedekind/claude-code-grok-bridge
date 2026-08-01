import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_SCHEMA = path.join(
  ROOT,
  "plugins",
  "grok-build",
  "schemas",
  "review-output.schema.json"
);

// Imported rather than repeated: this file used to carry its own copy of the number, and
// a budget that lives in two places is a budget that will disagree with itself.
import { MAX_JSON_SCHEMA_CHARS as COMMAND_LINE_BUDGET } from "../plugins/grok-build/scripts/grok-bridge.mjs";

// This happened. On 2026-07-26 three critique runs died 40 seconds apart with
// `spawn ENAMETOOLONG`, because prompts were still passed inline on the command line;
// they travel as files since the fix that moved prompts to files. The schema still does not. The
// guard in grok-bridge covers only the user-supplied --json-schema on `run`; the built-in
// review schema that critique loads goes straight past it. Growing that file by an order
// of magnitude would bring the same failure back, at runtime, in whatever run happened to
// be first. Cheaper to notice here.
test("the built-in review schema stays inside the command-line budget", () => {
  const raw = fs.readFileSync(REVIEW_SCHEMA, "utf8");
  const compact = JSON.stringify(JSON.parse(raw));

  assert.ok(
    compact.length < COMMAND_LINE_BUDGET,
    `review schema is ${compact.length} characters; critique passes it on the command line, ` +
      `which fails with ENAMETOOLONG past roughly ${COMMAND_LINE_BUDGET}. Pass it as a file ` +
      `before growing it further.`
  );
});
