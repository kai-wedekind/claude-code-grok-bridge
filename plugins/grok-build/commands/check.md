---
description: Check whether the local Grok Build CLI is ready for the Claude Code bridge
argument-hint: '[--json] [--verify-tools] [--fetch-update]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" check --json $ARGUMENTS
```

If the result says Grok is unavailable:
- Do not invent an install path. Tell the user to install the Grok Build CLI and ensure `grok` is on PATH (or set `GROK_BINARY`).
- Then rerun `/grok-build:check` after they install it.

If Grok is already installed:
- Do not ask about installation.

Optional flags, both of which cost something and are therefore off by default:
- `--verify-tools` asks the CLI whether it still recognises every id in the read-only removal list. It has to start a real session, which spends real allowance.
- `--fetch-update` asks GitHub for the latest release now, instead of reporting the cached answer. One unauthenticated request; the cache otherwise refreshes from the SessionEnd hook, at most every six hours after a success and on a backoff after a failure.

Output rules:
- Present the final check output to the user.
- If Grok is installed but not authenticated, preserve the guidance to authenticate (for example complete login via interactive `grok`, then verify with `grok models`).
- Present the `Version:` line verbatim. **Never summarise `update: unknown` as "up to date"** — unknown means the check could not run or has never run, and reporting it as current is the one outcome worse than silence, because it stops the user looking. If the user wants a definitive answer, run `--fetch-update`.
