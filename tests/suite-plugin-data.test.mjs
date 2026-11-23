// A suite process that inherited CLAUDE_PLUGIN_DATA wrote job files into the live plugin
// data. helpers.mjs drops that name, and GROK_BUILD_PLUGIN_DATA with it, before any test
// runs (upstream #52, 2026-10-24).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Only the workspace directory this test's own saveState created under the temp fallback.
// The shared grok-cc-runs root is older than this test and is not ours to remove.
function removeOwnedFallbackDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    return;
  }
  const resolved = path.resolve(dir);
  if (!inside(os.tmpdir(), resolved) || resolved === path.resolve(os.tmpdir())) {
    return;
  }
  const parts = resolved.split(path.sep);
  if (!parts.some((part) => part.startsWith("grok-cc-runs"))) {
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

test("a suite state write ignores plugin-data variables set in the parent", () => {
  const inherited = makeTempDir();
  const workspace = makeTempDir();
  const scriptDir = makeTempDir();
  const scriptPath = path.join(scriptDir, "write-state.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      'import fs from "node:fs";',
      "const helpersUrl = process.argv[2];",
      "const stateUrl = process.argv[3];",
      "const workspace = process.argv[4];",
      "const inherited = process.argv[5];",
      "let stateDir = null;",
      "try {",
      "  await import(helpersUrl);",
      "  const state = await import(stateUrl);",
      "  stateDir = state.resolveStateDir(workspace);",
      "  state.saveState(workspace, { version: 1, config: {}, jobs: [] });",
      "  const stateFile = state.resolveStateFile(workspace);",
      "  process.stdout.write(JSON.stringify({",
      "    claude: process.env.CLAUDE_PLUGIN_DATA ?? null,",
      "    grok: process.env.GROK_BUILD_PLUGIN_DATA ?? null,",
      "    stateDir,",
      "    stateFile,",
      "    wrote: fs.existsSync(stateFile),",
      "    inheritedNames: fs.readdirSync(inherited)",
      "  }));",
      "} catch (error) {",
      "  process.stdout.write(JSON.stringify({ failed: String(error && error.stack ? error.stack : error), stateDir }));",
      "  process.exitCode = 1;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  const env = { ...process.env };
  env.CLAUDE_PLUGIN_DATA = inherited;
  env.GROK_BUILD_PLUGIN_DATA = path.join(inherited, "grok-build-plugin-data");

  let stateDir = null;
  try {
    const result = run(process.execPath, [
      scriptPath,
      pathToFileURL(path.join(ROOT, "tests", "helpers.mjs")).href,
      pathToFileURL(path.join(ROOT, "plugins", "grok-build", "scripts", "lib", "state.mjs")).href,
      workspace,
      inherited
    ], { env });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    stateDir = payload.stateDir;

    assert.equal(payload.claude, null);
    assert.equal(payload.grok, null);
    assert.equal(payload.wrote, true);
    assert.equal(inside(os.tmpdir(), payload.stateDir), true);
    assert.equal(inside(inherited, payload.stateDir), false);
    assert.equal(inside(workspace, payload.stateFile), false);
    assert.ok(
      payload.stateDir.split(path.sep).some((part) => part.startsWith("grok-cc-runs")),
      payload.stateDir
    );
    assert.deepEqual(payload.inheritedNames, []);
    assert.equal(fs.existsSync(path.join(inherited, "state")), false);
    assert.equal(fs.existsSync(path.join(inherited, "grok-build-plugin-data")), false);
    const written = JSON.parse(fs.readFileSync(payload.stateFile, "utf8"));
    assert.equal(written.version, 1);
  } finally {
    removeOwnedFallbackDir(stateDir);
  }
});
