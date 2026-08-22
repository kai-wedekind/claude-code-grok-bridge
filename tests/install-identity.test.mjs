// A01. `check` used to describe a build without ever saying WHICH build.
//
// Three places name a version and they can disagree: the directory the code was loaded
// from, the manifest inside it, and Claude Code's registry. `deploy-local.sh` copies a
// working tree's `*.json` over an installed plugin, which moves the manifest and nothing
// else — so the loaded code and its stated version drift apart silently. Measured on this
// machine 2026-08-09 and reproduced below: install path and registry `0.3.0`, manifest
// `0.3.2`. Five days and three versions of divergence that `check` could not see.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { describeInstallIdentity } from "../plugins/grok-build/scripts/lib/version-check.mjs";

/**
 * Plant an install whose layout matches a real one: `<root>/<version>/scripts/` with the
 * manifest at `<version>/.claude-plugin/plugin.json`. Returns the metaUrl a script inside
 * it would see, because that is the only input this function takes.
 */
function plantInstall(root, dirVersion, manifestVersion) {
  const installDir = path.join(root, dirVersion);
  fs.mkdirSync(path.join(installDir, "scripts"), { recursive: true });
  if (manifestVersion) {
    fs.mkdirSync(path.join(installDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "grok-build", version: manifestVersion }),
      "utf8"
    );
  }
  return {
    installDir,
    metaUrl: pathToFileURL(path.join(installDir, "scripts", "grok-bridge.mjs")).href
  };
}

function plantRegistry(root, installPath, version, key = "grok-build@claude-code-grok-bridge") {
  const file = path.join(root, "installed_plugins.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 2, plugins: { [key]: [{ scope: "user", installPath, version }] } }),
    "utf8"
  );
  return file;
}

test("a cosmetic version difference is not a divergence", () => {
  // The three sources arrive by different routes — a directory NAME, a manifest field, and
  // whatever an installer wrote into the registry — so `v0.3.3`, `0.3.3` and `0.3.3+build.7`
  // all naming the same build is ordinary, not pathological. A raw string compare reported
  // each of them as a disagreement, in the one command people run when they already suspect
  // their install is broken. Audit 2026-08-09.
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.3.3", "0.3.3");
  const registryFile = plantRegistry(root, installDir, "v0.3.3");

  const identity = describeInstallIdentity(metaUrl, { registryFile });

  assert.equal(identity.registryVersion, "v0.3.3", "the raw value is still reported as found");
  assert.deepEqual(identity.disagreements, [], "but v0.3.3 and 0.3.3 are the same version");
});

test("build metadata and a missing patch component are also not divergences", () => {
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.4", "0.4.0");
  const registryFile = plantRegistry(root, installDir, "0.4.0+build.7");

  const identity = describeInstallIdentity(metaUrl, { registryFile });

  assert.deepEqual(identity.disagreements, [], "0.4, 0.4.0 and 0.4.0+build.7 are one version");
});

test("a prerelease is NOT the same version as its release", () => {
  // The counterweight to the two above: normalising must not become "everything matches".
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.4.0", "0.4.0-rc.1");
  const registryFile = null;

  const identity = describeInstallIdentity(metaUrl, { registryFile });

  assert.equal(identity.disagreements.length, 1, "0.4.0 and 0.4.0-rc.1 are different builds");
  assert.match(identity.disagreements[0], /0\.4\.0-rc\.1/);
});

test("two unreadable versions that differ are still reported", () => {
  // Nothing parses, so the literal comparison is all the meaning available — and a difference
  // is still worth saying rather than swallowing.
  //
  // ⚠ The unparseable case can only arrive through the MANIFEST or the REGISTRY, which are
  // read as written. A directory NAME that is not a version yields `directoryVersion: null`
  // (`version-check.mjs:186`), which means "no version information here" rather than "a
  // strange version" — so an install directory called `nightly` is silent by design, not by
  // oversight. The first version of this test used exactly that and failed against correct
  // code; the premise was wrong, not the behaviour.
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.4.0", "experimental");
  const registryFile = plantRegistry(root, installDir, "nightly");

  const identity = describeInstallIdentity(metaUrl, { registryFile });

  const pair = identity.disagreements.find((d) => d.includes("manifest") && d.includes("registry"));
  assert.ok(pair, `expected a manifest/registry disagreement, got ${JSON.stringify(identity.disagreements)}`);
  assert.match(pair, /experimental.*nightly/);
});

test("the real divergence is reported: directory 0.3.0, manifest 0.3.2, registry 0.3.0", () => {
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.3.0", "0.3.2");
  const registryFile = plantRegistry(root, installDir, "0.3.0");

  const identity = describeInstallIdentity(metaUrl, { registryFile });

  assert.equal(identity.installDir, installDir);
  assert.equal(identity.directoryVersion, "0.3.0");
  assert.equal(identity.manifestVersion, "0.3.2");
  assert.equal(identity.registryVersion, "0.3.0");
  assert.equal(identity.disagreements.length, 2);
  assert.match(identity.disagreements[0], /install directory says 0\.3\.0, manifest says 0\.3\.2/);
  assert.match(identity.disagreements[1], /manifest says 0\.3\.2, registry says 0\.3\.0/);
});

test("agreement is silent — no disagreement is invented when all three match", () => {
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.3.3", "0.3.3");
  const registryFile = plantRegistry(root, installDir, "0.3.3");

  const identity = describeInstallIdentity(metaUrl, { registryFile });
  assert.deepEqual(identity.disagreements, []);
  assert.equal(identity.directoryVersion, "0.3.3");
});

test("a checkout stays quiet instead of crying wolf", () => {
  // A developer running from a clone has no version-named directory and no registry entry.
  // Reporting that as a disagreement would put a warning on every single `check` run, and
  // a warning that is always on is one nobody reads.
  const root = makeTempDir();
  const { metaUrl } = plantInstall(root, "grok-build", "0.3.3");

  const identity = describeInstallIdentity(metaUrl, { registryFile: null });
  assert.equal(identity.directoryVersion, null, "an unparseable basename is not a version");
  assert.equal(identity.manifestVersion, "0.3.3");
  assert.equal(identity.registryVersion, null);
  assert.deepEqual(identity.disagreements, [], "absence must never read as disagreement");
});

test("a missing or unreadable registry is absence, not disagreement", () => {
  const root = makeTempDir();
  const { metaUrl } = plantInstall(root, "0.3.3", "0.3.3");

  const absent = describeInstallIdentity(metaUrl, { registryFile: path.join(root, "nope.json") });
  assert.equal(absent.registryVersion, null);
  assert.deepEqual(absent.disagreements, []);

  const broken = path.join(root, "broken.json");
  fs.writeFileSync(broken, "{ not json", "utf8");
  const unreadable = describeInstallIdentity(metaUrl, { registryFile: broken });
  assert.equal(unreadable.registryVersion, null);
  assert.deepEqual(unreadable.disagreements, []);
});

test("the registry is matched by install path, not by its key", () => {
  // The marketplace was renamed once already (xai-grok-build → claude-code-grok-bridge).
  // A key-based lookup would have gone quietly blind that day and reported no registry
  // version at all — which, under the rule above, reads as agreement.
  const root = makeTempDir();
  const { installDir, metaUrl } = plantInstall(root, "0.3.0", "0.3.2");
  const registryFile = plantRegistry(root, installDir, "0.3.0", "grok-build@some-future-name");

  const identity = describeInstallIdentity(metaUrl, { registryFile });
  assert.equal(identity.registryVersion, "0.3.0", "the key must not decide whether we can see it");
  assert.equal(identity.disagreements.length, 2);
});

test("an entry for a different install is not mistaken for this one", () => {
  const root = makeTempDir();
  const { metaUrl } = plantInstall(root, "0.3.3", "0.3.3");
  const registryFile = plantRegistry(root, path.join(root, "somewhere", "else"), "9.9.9");

  const identity = describeInstallIdentity(metaUrl, { registryFile });
  assert.equal(identity.registryVersion, null, "a foreign install path must not answer for us");
  assert.deepEqual(identity.disagreements, []);
});

test("a garbage metaUrl degrades to silence rather than throwing", () => {
  const identity = describeInstallIdentity("not-a-url-at-all", { registryFile: null });
  assert.equal(identity.installDir, null);
  assert.deepEqual(identity.disagreements, []);
});
