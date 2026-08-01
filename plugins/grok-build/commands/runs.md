---
description: Show active and recent Grok Build runs for this repository
argument-hint: '[run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--all-sessions] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" runs "$ARGUMENTS"`

Session scope (do not invent a missing-history explanation):
- Default list is scoped to the current Claude session (`GROK_CC_SESSION_ID`). Finished runs from earlier sessions stay on disk but are hidden by that filter.
- `--all` keeps the current-session filter but does not cap the recent-finished list at 8.
- `--all-sessions` lists every run in this workspace across Claude sessions (and adds a Claude Session column). Use this when the user asks about history from a previous session or says runs "disappeared".
- SessionEnd cancels active runs for the ending session; it does not delete job records. Retention is MAX_JOBS pruning (50) plus optional bridge `clean`.
- `--wait` requires a run id. Wait timeout exits 3 while the job is still active.

If the user did not pass a run ID:
- Render the command output as a single Markdown table for the current and past runs in this session (or all sessions if `--all-sessions` was passed).
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including run ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.
- If the table is empty and the user expected history, mention `/grok-build:runs --all-sessions` once.

If the user did pass a run ID:
- Present the full command output to the user.
- Do not summarize or condense it.
