/**
 * Auto scope decides between the working-tree diff and the branch diff from whether the tree is
 * dirty. `git ls-files --others` lists only untracked files under the directory it runs in, so a
 * review started in a subdirectory missed new files elsewhere and reviewed the branch diff
 * instead (upstream #67).
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function makeRepoWithSubdirectory() {
  const root = makeTempDir();
  initGitRepo(root);
  fs.mkdirSync(path.join(root, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "web", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  run("git", ["add", "."], { cwd: root });
  run("git", ["commit", "-m", "init"], { cwd: root });
  return { root, subdir: path.join(root, "packages", "web") };
}

test("auto scope from a subdirectory sees an untracked file at the repository root", () => {
  const { root, subdir } = makeRepoWithSubdirectory();
  fs.writeFileSync(path.join(root, "new-at-root.js"), "console.log('new');\n");

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "working-tree");
  assert.deepEqual(collectReviewContext(subdir, target).changedFiles, ["new-at-root.js"]);
});

test("auto scope from a subdirectory sees an untracked file in a sibling directory", () => {
  const { root, subdir } = makeRepoWithSubdirectory();
  fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "api", "server.js"), "console.log('api');\n");

  assert.equal(resolveReviewTarget(subdir, {}).mode, "working-tree");
});

test("auto scope from a subdirectory still sees an untracked file inside it", () => {
  const { subdir } = makeRepoWithSubdirectory();
  fs.writeFileSync(path.join(subdir, "extra.js"), "console.log('extra');\n");

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "working-tree");
  assert.deepEqual(collectReviewContext(subdir, target).changedFiles, ["packages/web/extra.js"]);
});

test("auto scope from a subdirectory of a clean repository still picks the branch diff", () => {
  const { subdir } = makeRepoWithSubdirectory();

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});
