---
description: Import the current Claude Code session into a resumable Grok session
argument-hint: "[--source <claude-jsonl>] [--thread <name>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" import "$ARGUMENTS"`

Optional `--thread <name>` registers the imported Grok session under that name for later `/grok-build:delegate --thread <name>` / bridge `run --thread`.

Present the command output to the user exactly as returned. Preserve the Grok session ID and the `grok -r <session-id>` command.
