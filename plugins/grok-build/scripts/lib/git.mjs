// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

/**
 * ⚠ GIT RUNS WHATEVER THE TARGET REPOSITORY'S OWN CONFIG NAMES. That is by design, not a
 * git defect: a `.git/config` inside a directory you point git at is trusted. Adding
 * `--no-textconv` closed ONE key of several. Measured on this host against git 2.49.0,
 * each with a live control, through the real `collectReviewContext`:
 *
 *   core.fsmonitor         `git status` runs it to list changed files. EXECUTED.
 *   filter.<name>.clean    any worktree read converts through it. EXECUTED.
 *                          `--no-textconv` is irrelevant to it; so is core.attributesFile.
 *   diff.<name>.textconv   still EXECUTED via the CHILD git that `--submodule=diff`
 *                          starts, which does not inherit the parent's --no-textconv.
 *
 * So the hardening belongs HERE, at the two funnels every git call in this file passes
 * through, instead of at individual argv where the next call site added will forget it.
 *
 * 🚫 DEFENCE IN DEPTH, NOT A GUARANTEE — and the documentation must not say otherwise.
 * Neutralising known command-valued keys is whack-a-mole by construction: a future git
 * may add another and this list will not know. The only complete defence is to point the
 * tool at a repository whose `.git` you created yourself.
 */
const COMMAND_VALUED_CONFIG_KEYS = [
  // `git status` execs this to enumerate changes. An empty value blocks it (measured).
  "core.fsmonitor"
];

/**
 * ⚠ GIT RUNS HOOKS FROM THE REVIEWED REPOSITORY, and `git status` is enough to trigger one.
 *
 * `post-index-change` fires whenever the index is rewritten, which a status refresh does.
 * Measured 2026-08-20 on git 2.49.0, each on a FRESH repository and each with a live
 * control, through the real `collectReviewContext`: it executes both when the repository
 * sets `core.hooksPath`, and from the default `.git/hooks` directory with no configuration
 * at all. The second form is why every sweep of command-valued CONFIG KEYS missed it —
 * there is no key to find. A prior audit's table stated flatly that these commands do not
 * run hooks; it was wrong, and only an experiment caught it.
 *
 * `core.hooksPath` pointed at a directory that cannot exist disables the lot: git looks for
 * the hook there and nowhere else, so the default directory stops being consulted too.
 * ⚠ An EMPTY value does not work here the way it does for `core.fsmonitor` — empty makes git
 * fall back to the default `$GIT_DIR/hooks`, which is precisely the path we are closing.
 */
/**
 * ⚠ THIS PATH MUST BE ABSOLUTE, and the first version of it was not.
 *
 * A bare name is resolved by git relative to the WORKTREE, so `core.hooksPath=some-name`
 * simply points at `<repo>/some-name` — a directory the repository can create and fill.
 * Measured 2026-08-20: `rev-parse --git-path hooks` returned the bare name, a
 * `post-index-change` placed there ran through `collectReviewContext`, and the same trick
 * worked inside a submodule because the `-c` is inherited by the child git. The defence was
 * a directory name the attacker was free to occupy.
 *
 * An absolute path that cannot exist does stop it (measured, same fixture). Anchored at a
 * filesystem root so it cannot be reinterpreted relative to anything the repository owns.
 */
const HOOKS_DISABLED_PATH =
  process.platform === "win32"
    ? "C:/grok-cc-hooks-intentionally-absent"
    : "/nonexistent/grok-cc-hooks-intentionally-absent";

const declaredFilterKeyCache = new Map();

/**
 * The filter NAME is attacker-chosen — `.gitattributes` says `filter=<name>` — so no
 * fixed flag can name it. git will however say which ones the repository declares.
 * Measured: enumerating and passing `-c filter.<name>.clean=` took a three-filter
 * fixture from 9 executions to 0. `filter.<name>.required=false` does NOT help (9 → 9).
 */
/**
 * ⚠ `--includes` IS LOad-BEARING, AND ITS ABSENCE WAS A LIVE BYPASS. Measured 2026-08-17
 * with a control: `git config --local --list` does NOT resolve `include.path`, because
 * respect_includes defaults off once a scope is named — while `git status` and `git diff`
 * DO resolve it. So a `.git/config` holding nothing but
 *
 *     [include]
 *         path = ../.git-extra
 *
 * with `filter.pwn.clean` in that included file was invisible here and executed anyway.
 * Confirmed end to end through `collectReviewContext`, and closed by this one flag.
 *
 * ⚠ Scopes this still does NOT see, so do not read it as complete:
 *   - `$GIT_DIR/config.worktree` when `extensions.worktreeConfig` is on — `--local` excludes it
 *   - the operator's own `~/.gitconfig`: a committed `.gitattributes` naming `filter=lfs`
 *     runs the reviewer's git-lfs, and a clone DOES carry `.gitattributes`, so "clone it
 *     first" is not a defence against that one
 *   - a submodule's own config, reached by the dirty-check child `git status`
 */
function declaredFilterKeys(cwd) {
  if (declaredFilterKeyCache.has(cwd)) {
    return declaredFilterKeyCache.get(cwd);
  }
  const keySet = new Set();
  let keys = [];
  try {
    // Deliberately RAW calls — hardening these would recurse forever.
    //
    // ⚠ TWO SCOPES, because one does not imply the other. `--local` reads `$GIT_DIR/config`
    // and resolves its includes; it does NOT read `$GIT_DIR/config.worktree`, which git
    // honours whenever `extensions.worktreeConfig` is on. Measured 2026-08-20 with a live
    // control: a filter placed only in the worktree file was invisible to `--local
    // --includes`, and `git diff` and `collectReviewContext` both ran it.
    for (const scope of ["--local", "--worktree"]) {
      const listed = runCommand(
        "git",
        ["config", scope, "--includes", "--name-only", "--list"],
        { cwd }
      );
      // `--worktree` exits non-zero when the extension is off, which is the ordinary case
      // and not an error worth reporting.
      if (listed.status === 0 && typeof listed.stdout === "string") {
        for (const line of listed.stdout.split(/\r?\n/)) {
          const key = line.trim();
          if (/^filter\..*\.(clean|process|smudge)$/.test(key)) {
            keySet.add(key);
          }
        }
      }
    }
    keys = [...keySet];
  } catch {
    // A repository whose config we cannot read is one we cannot fully harden. Failing
    // OPEN is deliberate: refusing to review because `git config` stumbled would trade a
    // certain loss of function for an uncertain gain in safety.
    // ⚠ The empty result is then cached for this cwd for the life of the process, so a
    // later call does not silently retry. That is the same trade, held consistently.
  }
  declaredFilterKeyCache.set(cwd, keys);
  return keys;
}

function hardeningFlags(cwd) {
  const flags = [];
  // Hooks first: this one needs no config entry in the repository to fire, so it is the
  // only member of the set that a key-based sweep can never find.
  flags.push("-c", `core.hooksPath=${HOOKS_DISABLED_PATH}`);
  for (const key of COMMAND_VALUED_CONFIG_KEYS) {
    flags.push("-c", `${key}=`);
  }
  for (const key of declaredFilterKeys(cwd)) {
    flags.push("-c", `${key}=`);
  }
  return flags;
}

function git(cwd, args, options = {}) {
  return runCommand("git", [...hardeningFlags(cwd), ...args], { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", [...hardeningFlags(cwd), ...args], { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

/**
 * Read a git file list without letting git reformat the names on the way out.
 *
 * Plain `--name-only` is not a list of paths, it is a list of *renderings* of paths. Two
 * things happen to a name that is not plain ASCII with no separators:
 *
 *   - a path containing a newline, quote or backslash comes back C-quoted — `"a\nb.txt"` —
 *     so splitting on newlines produces two entries, neither of which is a file;
 *   - `core.quotePath` is on by default, so `café.txt` arrives as `"caf\303\251.txt"`.
 *
 * Either way the name we then look up on disk does not exist, and the failure is silent:
 * the file drops out of the review, or a `lstat` on the mangled name throws and takes the
 * whole listing with it. `-z` turns off both behaviours and separates with NUL, which is
 * the one byte a path cannot contain.
 *
 * Trailing separator, not terminator-per-entry: git ends the last record with NUL too, so
 * the split leaves an empty string at the end. `.filter(Boolean)` is load-bearing.
 */
function gitPathList(cwd, args) {
  return gitChecked(cwd, [...args, "-z"]).stdout.split("\0").filter(Boolean);
}

export function getWorkingTreeState(cwd) {
  const staged = gitPathList(cwd, ["diff", "--cached", "--name-only", "--ignore-submodules=all"]);
  const unstaged = gitPathList(cwd, ["diff", "--name-only", "--ignore-submodules=all"]);
  const untracked = gitPathList(cwd, ["ls-files", "--others", "--exclude-standard"]);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  // A base ref reaches git POSITIONALLY, with no option terminator, so a value beginning with a
  // dash is read as an OPTION rather than as a revision. Rejecting that shape costs nothing:
  // git refnames may not begin with a dash, so no legitimate ref is turned away.
  //
  // ⚠ SCOPE, stated honestly, because the first version of this comment claimed more. The raw
  // value reaches exactly ONE git call: `merge-base HEAD <ref>` at buildBranchComparison. Every
  // later `diff`/`log` consumes `comparison.commitRange`, which is `<mergeBase>..HEAD` built
  // from git's own stdout — a SHA, never the user's string. `reviewRange` does carry the raw
  // value and is never read. So this is DEFENCE IN DEPTH plus a clear error message; it is not
  // plugging a reachable write primitive. An earlier version of this comment said `git diff`
  // would see the value and could be turned into `--output=<file>`; that was wrong, and an
  // audit caught it (2026-08-08).
  //
  // ⚠ It is also not a complete gate. `collectReviewContext` is exported and takes a target
  // object directly, so a library caller can pass a hostile baseRef without ever reaching this
  // function. Today that still dies at `merge-base`; the guard is at the CLI door, not at the
  // module boundary. And the check is `typeof baseRef === "string"`, so a non-string that
  // stringifies to a dash-leading token is not refused — argv only ever yields strings, but a
  // programmatic caller is not covered.
  if (typeof baseRef === "string" && baseRef.startsWith("-")) {
    throw new Error(
      `Refusing the base ref "${baseRef}": a ref may not begin with "-", and git would read it as an option rather than a revision.`
    );
  }

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

// Exported with injectable syscalls because this is a disclosure control and has to be
// provably exercised: creating a real symlink needs elevation or developer mode on
// Windows, so an integration test alone would silently skip on the machine it was written
// for. Same injection style as process.mjs (runCommandImpl, killImpl, isAliveImpl).
export function formatUntrackedFile(cwd, relativePath, options = {}) {
  const lstatImpl = options.lstatImpl ?? ((target) => fs.lstatSync(target));
  const readFileImpl = options.readFileImpl ?? ((target) => fs.readFileSync(target));
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    // lstat, not stat: an untracked entry may be a SYMLINK, and statSync and readFileSync
    // both follow one. `git ls-files --others` lists the link itself, so a link pointing
    // anywhere — an ssh key, a token file, a document outside the repository — had its
    // target's contents read and inlined into the context sent to the model. Nothing
    // about a code review asks for a file outside the repo, and someone who put a
    // convenience link in their own working tree cannot be expected to read it as a
    // disclosure. (xai-org/grok-build-plugin-cc issue #4, opened 2026-07-16; PR #10,
    // opened 2026-07-29. Both were still open upstream when checked 2026-08-01; this
    // fork inherited the defect.)
    stat = lstatImpl(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isSymbolicLink()) {
    return `### ${relativePath}\n(skipped: symlink; its target lies outside this review)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = readFileImpl(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all", "--ignore-submodules=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=log"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=log"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitPathList(cwd, ["diff", "--name-only", comparison.commitRange]);
  const logOutput = gitChecked(cwd, ["log", "--no-show-signature", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=log", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=log"],
        ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=log"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitPathList(repoRoot, ["diff", "--name-only", comparison.commitRange]).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--submodule=log", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
