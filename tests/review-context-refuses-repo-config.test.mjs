/**
 * Review context collection must not run commands the reviewed repository names.
 *
 * `--no-textconv` closed ONE key. Three more were measured executing through the real
 * `collectReviewContext` on git 2.49.0, each with a live control:
 *
 *   core.fsmonitor        `git status` runs it to list changed files
 *   filter.<name>.clean   any worktree read converts through it; --no-textconv is
 *                         irrelevant, and so is core.attributesFile
 *   diff.<name>.textconv  via the CHILD git that `--submodule=diff` starts, which does
 *                         not inherit the parent's --no-textconv
 *
 * ⚠ EVERY CASE ASSERTS ITS CONTROL FIRST. A marker that fails to appear because the
 * fixture is dead is indistinguishable from a defence that works, and this repository
 * has produced that false green more than once. If the control does not fire, the test
 * fails rather than passes — a broken fixture is a broken test, not a clean bill.
 *
 * The payload is a `node` script rather than a shell one-liner so the same command works
 * on Windows and Linux, and it is written to a file rather than passed with `-e` because
 * the interpreter path contains a space on this host and inline quoting loses it.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { collectReviewContext, resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";
import { makeTempDir } from "./helpers.mjs";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function newRepo() {
  const dir = makeTempDir();
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

/** A command string git will run, which drops a marker file and passes content through. */
function markerCommand(scratch, marker) {
  const script = path.join(scratch, `payload-${path.basename(marker)}.js`);
  fs.writeFileSync(
    script,
    `const fs = require("fs");\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, "fired");\n` +
      `try { process.stdout.write(fs.readFileSync(process.argv[2])); } catch {}\n`
  );
  const q = (v) => `"${String(v).replace(/\\/g, "/")}"`;
  return `${q(process.execPath)} ${q(script)}`;
}

/**
 * ⚠ WAIT FOR THE MARKER; DO NOT CHECK ONCE. A hook is a separate process, and a single
 * `existsSync` immediately after the git call can win the race against it — which under a
 * loaded machine reports "the defence held" when the payload was merely slow. That is a
 * FALSE GREEN on a security gate, and it is the more dangerous half of the flake: the
 * visible half was two hook cases failing their own control under the full parallel suite
 * while passing in isolation and three times in a row on their own.
 *
 * So both directions poll, and their deadlines are DIFFERENT LENGTHS on purpose.
 *
 * A case expecting the marker returns the moment it lands, so a generous deadline costs
 * nothing and buys immunity to a loaded machine. A single fixed 2500 ms was not enough: under
 * the full parallel suite both hook controls timed out while passing in isolation, and a
 * control that times out fails the test — correct, but red for no reason.
 *
 * A case expecting silence pays its whole deadline, so that one is DERIVED from what the
 * control just measured. If the payload needed three seconds to land here, then waiting two
 * and a half for it not to land proves nothing at all — it certifies a defence on a machine
 * that was merely slower than the stopwatch. Scaling to the observed latency is the only
 * version of this that stays honest on hardware whose speed is not known in advance.
 */
const CONTROL_WAIT_MS = 20000;
const MIN_SILENCE_WAIT_MS = 2500;
const SILENCE_LATENCY_FACTOR = 4;

function waitForMarker(marker, fn, waitMs) {
  if (fs.existsSync(marker)) fs.rmSync(marker);
  const started = Date.now();
  try { fn(); } catch {}
  const deadline = started + waitMs;
  let hit = fs.existsSync(marker);
  while (!hit && Date.now() < deadline) {
    // Synchronous sleep: node:test gives no async slot here, and Atomics.wait is the
    // portable way to block a worker thread without spinning a busy loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    hit = fs.existsSync(marker);
  }
  const elapsed = Date.now() - started;
  if (fs.existsSync(marker)) fs.rmSync(marker);
  return { hit, elapsed };
}

/** Asserts the fixture is live, and returns how long its payload took on this machine. */
function controlFires(marker, fn, message) {
  const { hit, elapsed } = waitForMarker(marker, fn, CONTROL_WAIT_MS);
  assert.ok(hit, message);
  return elapsed;
}

/** True if the marker appeared. The window is scaled to the control's measured latency. */
function firedBy(marker, fn, controlMs = 0) {
  return waitForMarker(
    marker,
    fn,
    Math.max(MIN_SILENCE_WAIT_MS, controlMs * SILENCE_LATENCY_FACTOR)
  ).hit;
}

test("collectReviewContext does not run a repository fsmonitor hook", () => {
  const repo = newRepo();
  const scratch = makeTempDir();
  const marker = path.join(scratch, "FSMONITOR_FIRED");

  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  git(repo, ["config", "core.fsmonitor", markerCommand(scratch, marker)]);

  const controlMs = controlFires(
    marker,
    () => git(repo, ["status", "--short"]),
    "control: a bare `git status` must run the hook, or this fixture proves nothing"
  );

  const target = resolveReviewTarget(repo, {});
  assert.equal(
    firedBy(marker, () => collectReviewContext(repo, target, { includeDiff: true }), controlMs),
    false,
    "collectReviewContext ran the repository's fsmonitor hook"
  );
});

test("collectReviewContext does not run a repository clean filter", () => {
  const repo = newRepo();
  const scratch = makeTempDir();
  const marker = path.join(scratch, "FILTER_FIRED");

  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=pwn\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  git(repo, ["config", "filter.pwn.clean", markerCommand(scratch, marker)]);
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

  const controlMs = controlFires(
    marker,
    () => git(repo, ["diff"]),
    "control: a bare `git diff` must run the clean filter, or this fixture proves nothing"
  );

  const target = resolveReviewTarget(repo, {});
  assert.equal(
    firedBy(marker, () => collectReviewContext(repo, target, { includeDiff: true }), controlMs),
    false,
    "collectReviewContext ran the repository's clean filter"
  );
});

/**
 * ⚠ EACH HOOK CASE GETS ITS OWN FRESH REPOSITORY, and that is not tidiness. The hook fires
 * when the index is REWRITTEN; a control run in the same repository consumes the trigger, so
 * the real call afterwards finds nothing to fire and looks blocked when it is not. That false
 * green was hit during the investigation and is the reason for the split.
 */
function hookRepo(scratch, marker, { viaHooksPath }) {
  const repo = newRepo();
  const plainNode = path.join(scratch, "n.exe");
  if (!fs.existsSync(plainNode)) fs.copyFileSync(process.execPath, plainNode);
  const payload = path.join(scratch, `hook-payload-${path.basename(marker)}.js`);
  fs.writeFileSync(payload, `require("fs").writeFileSync(${JSON.stringify(marker)}, "fired");\n`);

  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  fs.writeFileSync(path.join(repo, "stat-only.txt"), "keep\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);

  const fwd = (v) => String(v).replace(/\\/g, "/");
  const body = `#!/bin/sh\n"${fwd(plainNode)}" "${fwd(payload)}"\n`;
  let hookFile;
  if (viaHooksPath) {
    const dir = path.join(repo, ".githooks");
    fs.mkdirSync(dir, { recursive: true });
    hookFile = path.join(dir, "post-index-change");
    git(repo, ["config", "core.hooksPath", ".githooks"]);
  } else {
    hookFile = path.join(repo, ".git", "hooks", "post-index-change");
  }
  fs.writeFileSync(hookFile, body);
  fs.chmodSync(hookFile, 0o755);

  // The change a reviewer would actually look at.
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

  // ⚠ AND THE THING THAT MAKES THE HOOK FIRE AT ALL, which the modified file above does not.
  //
  // `post-index-change` runs only when git REWRITES the index, and a file whose CONTENT
  // differs gives it no reason to: git reports it modified and leaves the stat cache alone.
  // Whether the index gets written at all then comes down to incidental racily-clean
  // handling, which is nondeterministic. Measured 2026-08-21 across three sets of fifteen
  // fresh repositories, the content-only fixture fired 13/15, 14/15 and 9/15 — and every
  // silent round had left the index file byte-for-byte unchanged, so the hook was never going
  // to run and no amount of waiting could have rescued it. That is what a control timing out
  // against a full twenty-second window was really reporting.
  //
  // ⚠ AND IT WAS ALSO A FALSE-GREEN PATH, not merely a flake. The control and the guarded
  // call deliberately use SEPARATE repositories (see above), so a control that fired said
  // nothing about whether the guarded repository had a live trigger. In the runs where the
  // guarded one happened to need no index write, `collectReviewContext` was blocked by
  // nothing and the assertion passed on an absence. That is the failure this whole file is
  // built to refuse.
  //
  // A file whose content is IDENTICAL but whose mtime has moved is the deterministic trigger:
  // git must re-stat it, finds the recorded stat stale, refreshes it, and writing that
  // refreshed index is what fires the hook. 35/35 across the same three conditions.
  const statOnly = path.join(repo, "stat-only.txt");
  fs.writeFileSync(statOnly, "keep\n");
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(statOnly, past, past);

  return repo;
}

for (const viaHooksPath of [true, false]) {
  const how = viaHooksPath ? "core.hooksPath" : "the default .git/hooks directory";
  test(`collectReviewContext does not run a post-index-change hook from ${how}`, () => {
    // ⚠ THE DEFAULT-DIRECTORY CASE NEEDS NO CONFIG ENTRY AT ALL, which is why every sweep of
    // command-valued config keys missed it and a prior audit stated outright that these
    // commands do not run hooks. `git status` rewrites the index, and that fires the hook.
    const scratch = makeTempDir();
    const controlMarker = path.join(scratch, `HOOK_CTL_${viaHooksPath}`);
    const collectMarker = path.join(scratch, `HOOK_RUN_${viaHooksPath}`);

    const controlMs = controlFires(
      controlMarker,
      () =>
        git(hookRepo(scratch, controlMarker, { viaHooksPath }), ["status", "--short", "--untracked-files=all"]),
      "control: a bare `git status` must run the hook, or this fixture proves nothing"
    );

    // ⚠ `resolveReviewTarget` MUST BE INSIDE THE MEASUREMENT. It runs git itself, which
    // rewrites the index and fires the hook — outside `firedBy` that happens before the
    // marker is cleared, so the trigger is spent and the real call finds nothing left to
    // fire. This test passed under its own mutation until that was moved inside, which is
    // the whole reason mutations get run rather than assumed.
    const repo = hookRepo(scratch, collectMarker, { viaHooksPath });
    assert.equal(
      firedBy(
        collectMarker,
        () => {
          const target = resolveReviewTarget(repo, {});
          collectReviewContext(repo, target, { includeDiff: true });
        },
        controlMs
      ),
      false,
      `collectReviewContext ran a post-index-change hook from ${how}`
    );
  });
}

test("collectReviewContext does not run a clean filter hidden behind include.path", () => {
  // ⚠ THIS IS THE ONE THAT GOT THROUGH. The first version of the hardening enumerated
  // filters with `git config --local --name-only --list`, which does NOT resolve
  // `include.path` — respect_includes defaults off once a scope is named — while `status`
  // and `diff` DO resolve it. So a `.git/config` containing nothing but an include, with
  // the filter in the included file, was invisible to the enumerator and ran anyway.
  // Measured with a live control before the flag was added, and again after.
  const repo = newRepo();
  const scratch = makeTempDir();
  const marker = path.join(scratch, "INCLUDE_FIRED");

  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=pwn\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);

  // ⚠ Written into a config FILE rather than through `git config`, so the command cannot
  // be quoted: git's parser strips the quotes and the interpreter path breaks at its first
  // space, which killed this fixture's control on the first attempt. Copy the interpreter
  // somewhere without a space instead of trying to escape it.
  const plainNode = path.join(scratch, "n.exe");
  fs.copyFileSync(process.execPath, plainNode);
  const script = path.join(scratch, "include-payload.js");
  fs.writeFileSync(
    script,
    `const fs = require("fs");\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, "fired");\n` +
      `try { process.stdout.write(fs.readFileSync(process.argv[2])); } catch {}\n`
  );
  const fwd = (v) => String(v).replace(/\\/g, "/");

  // The filter lives ONLY in an included file — never in .git/config itself.
  fs.writeFileSync(
    path.join(repo, ".git-extra"),
    `[filter "pwn"]\n\tclean = ${fwd(plainNode)} ${fwd(script)}\n`
  );
  fs.appendFileSync(path.join(repo, ".git", "config"), "[include]\n\tpath = ../.git-extra\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

  // Two controls. The first proves the fixture is live at all; the second proves the
  // bypass is the one this test is named for — the plain listing must NOT see the key,
  // or the enumerator would have caught it without `--includes` and this test is testing
  // nothing.
  const controlMs = controlFires(
    marker,
    () => git(repo, ["diff"]),
    "control: a bare `git diff` must run the included clean filter, or this fixture proves nothing"
  );
  const plainList = git(repo, ["config", "--local", "--name-only", "--list"]).stdout || "";
  assert.ok(
    !plainList.includes("filter.pwn.clean"),
    "control: a plain --local listing must NOT show the included key, or this is not the include bypass"
  );

  const target = resolveReviewTarget(repo, {});
  assert.equal(
    firedBy(marker, () => collectReviewContext(repo, target, { includeDiff: true }), controlMs),
    false,
    "collectReviewContext ran a clean filter declared through include.path"
  );
});

test("collectReviewContext does not run a submodule's textconv driver", (t) => {
  const outer = newRepo();
  const inner = newRepo();
  const scratch = makeTempDir();
  const marker = path.join(scratch, "SUBMODULE_FIRED");

  fs.writeFileSync(path.join(inner, "a.c"), "int a;\n");
  git(inner, ["add", "-A"]);
  git(inner, ["commit", "-qm", "inner"]);
  fs.writeFileSync(path.join(outer, "top.txt"), "top\n");
  git(outer, ["add", "-A"]);
  git(outer, ["commit", "-qm", "outer"]);

  // Newer git refuses a file-protocol submodule unless asked; if the host refuses
  // anyway there is no attack to build, and a silent pass would certify nothing.
  const added = git(outer, [
    "-c", "protocol.file.allow=always",
    "submodule", "add", "-q", inner.replace(/\\/g, "/"), "sub"
  ]);
  if (added.status !== 0) {
    t.skip(`could not create the submodule that is the attack (${(added.stderr || "").trim().slice(0, 120)}); without it this test would certify nothing`);
    return;
  }
  git(outer, ["commit", "-qm", "add submodule"]);

  const sub = path.join(outer, "sub");
  fs.writeFileSync(path.join(sub, ".gitattributes"), "*.c diff=pwn\n");
  git(sub, ["config", "diff.pwn.textconv", markerCommand(scratch, marker)]);
  fs.writeFileSync(path.join(sub, "a.c"), "int a; int b;\n");

  const controlMs = controlFires(
    marker,
    () => git(outer, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=diff"]),
    "control: --submodule=diff must run the child's textconv despite the parent's --no-textconv, or this fixture proves nothing"
  );

  const target = resolveReviewTarget(outer, {});
  assert.equal(
    firedBy(marker, () => collectReviewContext(outer, target, { includeDiff: true }), controlMs),
    false,
    "collectReviewContext ran a textconv driver from inside a submodule"
  );
});
