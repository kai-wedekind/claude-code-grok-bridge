---
description: Show the stored final output for a finished Grok Build run in this repository
argument-hint: '[run-id] [--wait] [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" show "$ARGUMENTS"`

Behaviour:
- Without a run id, shows the latest finished run for the current Claude session.
- With an explicit run id, looks up that id in the workspace (not session-filtered).
- `--wait` requires a run id and polls until the run is finished or the wait deadline expires (default 240000 ms; override with `--timeout-ms`). Wait timeout exits 3 and prints status rather than a result payload.
- Process exit reflects the stored run status (0 on successful completion, non-zero on failed/cancelled).

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Run ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/grok-build:runs <id>` and `/grok-build:review`
