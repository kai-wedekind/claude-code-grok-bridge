/**
 * The reasoning-effort list must not fall behind the CLI, and must not drift from the
 * documents that tell a reader — or Claude — which levels exist.
 *
 * ⚠ THE DEFECT THIS EXISTS FOR. A fixed set in our code silently caps what the CLI can do,
 * and nothing notices when the CLI grows. xAI shipped `xhigh` with grok-4.6 and this bridge
 * rejected it, so the highest reasoning level was unreachable through the plugin for months,
 * with a validation error rather than a warning, which reads like a typo.
 *
 * ⚠ AND THE DEFECT THE FIX ITSELF PRODUCED, which is why the list is pinned by MEASUREMENT
 * here rather than by assertion. Read from the shipped binary you get `none`, `minimal`,
 * `low`, `medium`, `high`, `xhigh`, `max` — seven names that look exactly like the flag's set
 * and are not it. On 2026-08-21 that reading was believed, the list was reported as three
 * short, and the whole allowlist was removed on the strength of it. Then the values were put
 * through the bridge to a real CLI:
 *
 *     grok --effort __probe__ -p x
 *     Error: --effort/--reasoning-effort: unknown effort level '__probe__';
 *            use one of: xhigh, high, medium, low
 *
 * Four, not seven, on grok 1.0.5 (Windows) and grok 1.0.0 (Raspberry Pi) alike, which refuse
 * `max`, `minimal` and `none`. `grok --help` documents no values for the flag whatsoever. So
 * the obvious source misleads and the documented source is silent, and the probe above is the
 * only way to check this list. `NEVER_ACCEPTED_BY_THE_FLAG` below pins that, so a future
 * maintainer who "corrects" the list from the binary goes red instead of shipping it.
 *
 * ⚠ THE STALENESS IS REAL AND UNSOLVED. If xAI adds a level, this list needs a human and
 * nothing here will notice on its own — the same shape as `xhigh`. Automating it is on the
 * 0.4.0 list; until then the probe is the mitigation and it is written down rather than
 * remembered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const BRIDGE_RELATIVE = path.join("plugins", "grok-build", "scripts", "grok-bridge.mjs");
const source = fs.readFileSync(path.join(repoRoot, BRIDGE_RELATIVE), "utf8");

function declaredLevels() {
  const m = source.match(/VALID_REASONING_EFFORTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "could not find VALID_REASONING_EFFORTS — the gate is broken, not the code");
  return (m[1].match(/"([^"]+)"/g) || []).map((x) => x.replace(/"/g, ""));
}

/**
 * Names that appear in the CLI binary beside the real ones and are refused by the flag.
 * Measured, not assumed — see the header. Anything here appearing in the list means someone
 * has read the binary and trusted it.
 */
const NEVER_ACCEPTED_BY_THE_FLAG = ["none", "minimal", "max"];

test("xhigh is accepted, because the CLI has it", () => {
  assert.ok(
    declaredLevels().includes("xhigh"),
    "the CLI offers xhigh; rejecting it makes the best setting unreachable through this bridge"
  );
});

test("the list carries no level the flag was measured to refuse", () => {
  const wrong = declaredLevels().filter((level) => NEVER_ACCEPTED_BY_THE_FLAG.includes(level));
  assert.deepEqual(
    wrong,
    [],
    `${wrong.join(", ")} appears in the binary but the --effort flag refuses it — this list is measured against a running CLI, not read out of the binary. Re-measure with: grok --effort __probe__ -p x`
  );
});

test("the error message lists exactly the levels the validator enforces", () => {
  const levels = declaredLevels();
  const m = source.match(/Unsupported reasoning effort[^`]*Use one of: ([^.`]+)\./);
  assert.ok(m, "could not find the error text");
  const named = m[1].split(",").map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(
    named,
    levels,
    "the message and the validator disagree, so a user is told the wrong set"
  );
});

/**
 * ⚠ THE TWO TESTS ABOVE ARE NOT ENOUGH, and the way they fall short is the reason this one
 * exists. They read `grok-bridge.mjs` and nothing else, so reverting the validator AND the
 * error string together leaves them green — and the widening that added `xhigh` passed both
 * while four user-facing surfaces still said there were three levels. Claude reads the command
 * markdown and the runtime skill BEFORE it builds the bridge argv, so a stale list there
 * refuses a level the bridge would have accepted: the original defect, moved up one layer,
 * with the gate looking straight past it.
 *
 * ⚠ `grok-bridge.mjs` IS ITSELF ONE OF THE SURFACES, which it was not until 2026-08-21. Its
 * three `--effort <…>` usage lines are the fourth place the original defect lived; they were
 * corrected by hand twice with nothing watching them, because a sweep over documents cannot
 * see code.
 *
 * A surface is any line that ENUMERATES levels (names two or more). A line using one as an
 * example — "`--effort high`" — is not an enumeration and is left alone.
 */
const SURFACES = [
  "README.md",
  "SECURITY.md",
  BRIDGE_RELATIVE,
  path.join("docs", "ADOPTION.md"),
  path.join("plugins", "grok-build", "commands", "review.md"),
  path.join("plugins", "grok-build", "commands", "critique.md"),
  path.join("plugins", "grok-build", "commands", "delegate.md"),
  path.join("plugins", "grok-build", "skills", "grok-delegate-runtime", "SKILL.md"),
  path.join("plugins", "grok-build", "skills", "grok-routing", "SKILL.md"),
  path.join("plugins", "grok-build", "agents", "grok-delegate.md")
];

test("every surface that enumerates effort levels lists all of them", () => {
  const levels = declaredLevels();
  const offenders = [];
  let enumerationsSeen = 0;

  for (const relative of SURFACES) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const present = levels.filter((level) => new RegExp(`\\b${level}\\b`).test(line));
      // Two or more names on one line is an enumeration; one is an example.
      if (present.length < 2) return;
      enumerationsSeen += 1;
      const missing = levels.filter((level) => !present.includes(level));
      if (missing.length) {
        offenders.push(`${relative}:${index + 1} omits ${missing.join(", ")} — ${line.trim().slice(0, 90)}`);
      }
    });
  }

  // Without this the test passes trivially if the surface list rots or the files move,
  // which is the failure mode it was written to catch in the first place.
  assert.ok(
    enumerationsSeen >= 4,
    `found only ${enumerationsSeen} effort enumerations across the surfaces — the sweep is not looking where it thinks`
  );
  assert.deepEqual(
    offenders,
    [],
    `these surfaces tell a reader (or Claude) that fewer levels exist than the validator accepts:\n  ${offenders.join("\n  ")}`
  );
});
