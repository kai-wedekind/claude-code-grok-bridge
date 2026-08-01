// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeVersionFixture() {
  const root = makeTempDir();

  writeJson(path.join(root, "package.json"), {
    name: "@xai/grok-build-plugin-cc",
    version: "0.1.0"
  });
  writeJson(path.join(root, "plugins", "grok-build", ".claude-plugin", "plugin.json"), {
    name: "grok-build",
    version: "0.1.0"
  });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: {
      version: "0.1.0"
    },
    plugins: [
      {
        name: "grok-build",
        version: "0.1.0"
      }
    ]
  });

  return root;
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "1.2.3"], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "grok-build", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), {
    name: "@xai/grok-build-plugin-cc",
    version: "0.2.0"
  });

  const result = run("node", [SCRIPT, "--root", root, "--check"], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/grok-build\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
});

test("repo manifests agree with package.json, whatever the version is", () => {
  // The version used to be written in here as a literal, which made the guard against
  // version drift itself a copy that drifts: bumping 0.2.0 → 0.3.0 turned a passing test
  // red without anything being wrong. Ask package.json, which is the one the bump script
  // treats as the source, and this checks the property that matters — that the four
  // manifests agree — instead of pinning a number that is expected to change.
  const version = readJson(path.join(ROOT, "package.json")).version;
  assert.match(version, /^\d+\.\d+\.\d+/, "package.json must carry a semver version");

  const result = run("node", [SCRIPT, "--check", version], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});
