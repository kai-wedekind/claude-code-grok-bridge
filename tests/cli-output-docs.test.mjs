/**
 * The failure-code tables and the spend section name what the code now does.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("README and the run-output skill name max-turns and the side-model gap", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const skill = fs.readFileSync(
    path.join(ROOT, "plugins", "grok-build", "skills", "grok-run-output", "SKILL.md"),
    "utf8"
  );

  assert.match(readme, /`max-turns`/);
  assert.match(readme, /Raise `--max-turns` or narrow the task/);
  assert.match(readme, /memory Dream consolidation/);
  assert.match(readme, /XAI_API_KEY` in the environment/);
  assert.match(skill, /`max-turns`/);
  assert.match(skill, /not retryable as-is/);
});
