#!/usr/bin/env bash
# Publish the working HEAD tree to the public repository as ONE curated commit.
#
#   bash scripts/republish.sh            # dry run: report what would change, touch nothing
#   bash scripts/republish.sh --commit   # do it
#
# ⚠ WHY THIS EXISTS AT ALL, AND WHY IT LIVES IN THE REPOSITORY THIS TIME. The original was a
# PowerShell script in a session scratchpad. Scratchpads are temporary; it was gone when the
# next release came round, and the only record of what it guaranteed was one line in a memory
# note. A release step whose implementation can evaporate is not a release step.
#
# ⚠ THE TWO REPOSITORIES ARE NOT THE SAME REPOSITORY, and confusing them caused the worst
# defect of the 0.3.1 release:
#   working     - private, full history, every commit as it happened
#   publication - public, ONE commit per release, no development history
# "Unpushed to the working origin" is NOT the same as "unpublished": this script archives the
# working HEAD regardless of what has been pushed anywhere.
#
# THE INVARIANT, and the only reason to trust the result: the published tree must be
# byte-identical to the working HEAD tree. Verified by comparing tree object ids, which is a
# hash over the whole tree - not a file count, not a diff summary, not "it looked right".
# Measured against the last release before writing this: working v0.3.2 and published 0.3.2
# both have tree f93a8e98761740550a9a66372f1bf46300a57a02.
#
# Anything the working tree does not track is absent by construction, because `git archive`
# exports the COMMIT, not the working directory. That is what keeps `.tmp-internal/` and every
# other ignored path out of the public repository without needing a second exclusion list to
# maintain - and a second list is exactly the thing that would rot.
set -u

WORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUB="${PUB:-$(cd "$WORK/../claude-code-grok-bridge" 2>/dev/null && pwd)}"
COMMIT=0
[ "${1:-}" = "--commit" ] && COMMIT=1

fail() { printf '\n✗ %s\n' "$1" >&2; exit "${2:-1}"; }

[ -n "$PUB" ] && [ -d "$PUB/.git" ] || fail "publication repo not found; set PUB=/path/to/claude-code-grok-bridge"

# ⚠ Refuse to point at ourselves. The two repositories are deliberately similar and the whole
# operation is destructive to the target's working tree, so the one mistake that must be
# impossible is aiming it at the source.
[ "$(cd "$PUB" && pwd -P)" != "$(cd "$WORK" && pwd -P)" ] || fail "PUB and WORK are the same repository"

# ⚠ Read the version with sed, not with `node -p "require(...)"`. This script runs under MSYS
# bash on Windows, where $WORK is a path like /c/Users/... that node cannot resolve, so the
# require form fails with an empty result and the script aborts saying the version is missing -
# which reads like a broken package.json rather than a broken path translation.
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WORK/package.json" | head -1)"
[ -n "$VERSION" ] || fail "could not read the version from package.json"

printf 'working     : %s @ %s\n' "$WORK" "$(git -C "$WORK" log --oneline -1)"
printf 'publication : %s @ %s\n' "$PUB" "$(git -C "$PUB" log --oneline -1)"
printf 'version     : %s\n\n' "$VERSION"

# ⚠ BOTH trees must be clean. A dirty working tree means the archive would not match what is
# committed; a dirty publication tree means somebody's uncommitted work is about to be
# overwritten by a wholesale delete-and-extract.
[ -z "$(git -C "$WORK" status --porcelain)" ] || fail "working tree is dirty - commit or stash first"
[ -z "$(git -C "$PUB" status --porcelain)" ] || fail "publication tree is dirty - resolve it before republishing"

BRANCH="$(git -C "$PUB" rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "publication repo is on '$BRANCH', not main"

WORK_TREE="$(git -C "$WORK" rev-parse 'HEAD^{tree}')"
PUB_TREE_BEFORE="$(git -C "$PUB" rev-parse 'HEAD^{tree}')"

if [ "$WORK_TREE" = "$PUB_TREE_BEFORE" ]; then
  printf '= already IDENTICAL (tree %s) - nothing to publish\n' "$WORK_TREE"
  exit 0
fi

if [ "$COMMIT" -eq 0 ]; then
  printf 'DRY RUN. Files that would change in the publication repo:\n\n'
  git -C "$WORK" diff --stat "$PUB_TREE_BEFORE" "$WORK_TREE" || true
  printf '\nRe-run with --commit to publish. Nothing was modified.\n'
  exit 0
fi

# ⚠ THIS COPIES THE TREE OBJECT. IT DOES NOT COPY FILES, AND THAT IS THE WHOLE POINT.
#
# The first version of this script deleted the publication repo's tracked files and extracted a
# `git archive` over the top. Two defects, both found on the first real run, 2026-08-23:
#
#   1. `git -C "$PUB" ls-files | xargs rm -f` DELETED 103 FILES FROM THE WORKING REPOSITORY.
#      `git -C` moves git's directory; it does not move the shell's. The paths came out relative
#      to $PUB and `rm` resolved them against $PWD, which was the working repo. Nothing was lost
#      because everything was committed - but the recovery was `git restore .`, and if a single
#      uncommitted edit had been in that tree it would have been gone.
#   2. Round-tripping through tar loses the executable bit on this host, so `scripts/*.sh` came
#      out 100644 where the source tree has 100755, and the tree hash differed for files whose
#      CONTENT was byte-identical. The guard caught it; the cause took a per-file blob comparison
#      to find, because "every blob matches" and "the trees differ" look contradictory.
#
# Fetching the commit and pointing the index at its tree has neither failure mode: no shell path
# resolution, no filesystem round-trip, modes and content carried by the object itself. The tree
# equality below is then true by construction - which is a reason to keep asserting it, not to
# stop.
git -C "$PUB" fetch --no-tags --quiet "$WORK" HEAD || fail "could not fetch the working HEAD into the publication repo"

# --reset -u makes the index AND the working tree match that tree exactly: files added, files
# removed, modes as recorded. It is a hard reset of the content without moving HEAD, so the
# release still becomes one deliberate commit on top of the previous release.
git -C "$PUB" read-tree --reset -u FETCH_HEAD || fail "read-tree failed; the publication repo is untouched"

# ⚠ VERIFY BEFORE COMMITTING, not after. Once the commit exists the wrong tree is in history.
STAGED_TREE="$(git -C "$PUB" write-tree)"
if [ "$STAGED_TREE" != "$WORK_TREE" ]; then
  printf '\n✗ TREE MISMATCH - staged %s, expected %s\n' "$STAGED_TREE" "$WORK_TREE" >&2
  printf '  Nothing was committed. Inspect the publication repo; `git reset --hard` restores it.\n' >&2
  exit 6
fi

printf '= IDENTICAL (tree %s)\n' "$WORK_TREE"
printf '\nStaged in %s. Commit it with a written message file:\n' "$PUB"
printf '  git -C "%s" commit -F <path-to-message>\n' "$PUB"
printf '\nNot committed here on purpose: the commit is signed and its message is the public\n'
printf 'release announcement, so it is written deliberately rather than generated.\n'
