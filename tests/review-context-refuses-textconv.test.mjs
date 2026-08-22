/**
 * Review context collection must not honour a repository's textconv driver.
 *
 * `--no-ext-diff` disables external diff *drivers*. It does not disable
 * `diff.<driver>.textconv`, which `git diff` applies by default. A prepared
 * working tree can therefore make `collectReviewContext` execute an attacker
 * command inside our process, before the agent, the tool-removal list, the
 * deny rules or the sandbox exist.
 *
 * The converter is a `node -e` one-liner so the same command works on Windows
 * and Linux. It must create a marker file we can see; writing converted text
 * to stdout is what git expects of a textconv program.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { collectReviewContext } from "../plugins/grok-build/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function gitNoShell(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
}

function quoteForGitShell(value) {
  return `"${String(value).replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

test("collectReviewContext does not run a repository textconv driver", () => {
  const repo = makeTempDir();
  const scratch = makeTempDir();
  const marker = path.join(scratch, "TEXTCONV_FIRED");

  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "sample.c"), "int main(void) { return 0; }\n", "utf8");
  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.c diff=pwn\n", "utf8");
  run("git", ["add", "sample.c", ".gitattributes"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });

  const markerLiteral = JSON.stringify(marker.replace(/\\/g, "/"));
  const code = `require("fs").writeFileSync(${markerLiteral},"");process.stdout.write("converted")`;
  const textconv = `${quoteForGitShell(process.execPath)} -e ${quoteForGitShell(code)}`;
  const configured = gitNoShell(repo, ["config", "diff.pwn.textconv", textconv]);
  assert.equal(
    configured.status,
    0,
    `git config failed: ${configured.stderr || configured.stdout || configured.error}`
  );

  fs.writeFileSync(path.join(repo, "sample.c"), "int main(void) { return 1; }\n", "utf8");
  run("git", ["add", "sample.c"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.c"), "int main(void) { return 2; }\n", "utf8");

  const live = gitNoShell(repo, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]);
  assert.equal(
    live.status,
    0,
    `fixture git diff failed, so the converter never had a chance to run: ${live.stderr || live.error}`
  );
  assert.equal(
    fs.existsSync(marker),
    true,
    "fixture is dead: a raw git diff without --no-textconv did not fire the converter, so a green result would not mean the bridge is safe"
  );
  fs.rmSync(marker, { force: true });

  collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" }, { includeDiff: true });

  assert.equal(
    fs.existsSync(marker),
    false,
    "collectReviewContext ran the repository textconv driver"
  );
});
