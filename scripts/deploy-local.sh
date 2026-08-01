#!/usr/bin/env bash
# Mirror this working copy into the locally installed plugin.
#
# Claude Code loads the plugin from its cache directory, not from this repo, so
# edits here have no effect until they are copied over. Doing that by hand drifts:
# scripts get copied and the markdown does not, and the installed plugin then
# documents behaviour it no longer has.
#
# Usage: scripts/deploy-local.sh [--check]
#   --check  report drift and exit 1 instead of copying (for a pre-commit gate)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/plugins/grok-build"
# Kept as named parts because the cache path is built from them and the error message below
# has to quote the exact install command. Two copies of the marketplace id drift.
MARKETPLACE_ID="claude-code-grok-bridge"
PLUGIN_ID="grok-build"

# The install path carries the plugin version. Hardcoding it here made a fifth copy of the
# version string: `npm run bump-version` maintains four, all of them JSON, and the CI gate
# `npm run check-version` inspects exactly those four. So a bump would pass CI green while
# the only documented way to sync edits into the running plugin started pointing at a
# directory that no longer exists — silently, because nobody re-reads this line.
# Ask the manifest instead of keeping a copy; a copy cannot notice that the original moved.
PLUGIN_VERSION="$(cd "$SRC" && node -p "require('./.claude-plugin/plugin.json').version" 2>/dev/null || true)"
if [ -z "$PLUGIN_VERSION" ]; then
  echo "Could not read the plugin version from $SRC/.claude-plugin/plugin.json" >&2
  echo "This script now needs node on PATH: the install path carries the plugin version," >&2
  echo "and it is read from the manifest rather than hardcoded here. Earlier versions ran" >&2
  echo "without node, so a shell that used to work can fail here for that reason alone." >&2
  exit 1
fi

DEST="${GROK_CC_PLUGIN_CACHE:-$HOME/.claude/plugins/cache/$MARKETPLACE_ID/$PLUGIN_ID/$PLUGIN_VERSION}"

# This is a SYNC tool, not an installer, and the difference is invisible from the outside:
# the directory it needs is exactly the one `claude plugin install` creates. On a machine
# that has never installed the plugin — the first-contact case, measured on a clean Windows
# install 2026-07-31 — the old message named the missing path and an environment variable,
# neither of which tells you that the real answer is "install it first". Say the order.
if [ ! -d "$DEST" ]; then
  # Under Git Bash this script sees /c/Users/…, but `claude` is a native Windows program and
  # cannot resolve that form — a copy-paste of the suggested command would fail on exactly
  # the machine that most needs the suggestion. cygpath ships with Git for Windows.
  suggest_dir="$REPO_DIR"
  if command -v cygpath >/dev/null 2>&1; then
    suggest_dir="$(cygpath -w "$REPO_DIR")"
  fi

  echo "Installed plugin not found at: $DEST" >&2
  echo >&2
  echo "This script mirrors the working copy into an EXISTING install; it does not create one." >&2
  echo "If the plugin has never been installed on this machine, install it first:" >&2
  echo "  claude plugin marketplace add \"$suggest_dir\"" >&2
  echo "  claude plugin install $PLUGIN_ID@$MARKETPLACE_ID" >&2
  echo "then re-run this script." >&2
  echo >&2
  echo "If it is installed elsewhere, point GROK_CC_PLUGIN_CACHE at that directory." >&2
  exit 1
fi

check_only=0
[ "${1:-}" = "--check" ] && check_only=1

# Which directories the gate covers. Anything not covered can drift between the working
# copy and the installed plugin while --check reports "matches the working copy" — which
# it did: .claude-plugin was missing, so the install carried the upstream author (xAI) for
# weeks while this copy had long been a fork. Adding just that one was the second mistake;
# hooks, prompts and schemas were missing too, and only a later review caught them.
# So derive the list instead of curating it: every directory the plugin ships, always.
# A gate that cannot see a file is not a gate for that file.
PLUGIN_DIRS=$(cd "$SRC" && find . -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort)

drift=0
while IFS= read -r rel; do
  src="$SRC/$rel"
  dst="$DEST/$rel"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    continue
  fi
  drift=1
  echo "${rel}"
  if [ "$check_only" -eq 0 ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
done < <(cd "$SRC" && find $PLUGIN_DIRS -type f \( -name '*.mjs' -o -name '*.md' -o -name '*.json' -o -name '*.txt' -o -name '*.sh' \) | sort)

if [ "$drift" -eq 0 ]; then
  echo "installed plugin matches the working copy"
  exit 0
fi

if [ "$check_only" -eq 1 ]; then
  echo "-- drift above; run scripts/deploy-local.sh to sync" >&2
  exit 1
fi
echo "-- synced to $DEST"
