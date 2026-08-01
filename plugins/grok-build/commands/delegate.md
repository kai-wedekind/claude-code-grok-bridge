---
description: Delegate investigation, an explicit fix request, or follow-up work to the Grok Build delegate subagent
argument-hint: "[--background|--wait] [--write] [--thread <name>] [--json-schema <json>] [--cwd <path>] [--prompt-file <path>] [--prompts-file <path>] [--timeout-ms <ms>] [--max-turns <n>] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [what Grok should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `grok-build:grok-delegate` subagent via the `Agent` tool (`subagent_type: "grok-build:grok-delegate"`), forwarding the raw user request as the prompt.
`grok-build:grok-delegate` is a subagent, not a skill — do not call `Skill(grok-build:grok-delegate)` (no such skill) or `Skill(grok-build:delegate)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Grok's output verbatim.

Raw user request:
$ARGUMENTS

Background ownership model (one policy for command, agent, and skill):

- Bridge `--background` owns the long-running process group (detached `run-worker` + grok agent). That is what records `bridgePid` and `agentPid` so `/grok-build:stop` can kill both trees.
- Claude Code background (Agent `run_in_background` / short Bash enqueue) is only for the enqueue hop, never for holding the long Grok process.
- Prefer bridge `--background` for long or open-ended work. Ensure the forwarded `run` call includes `--background` when background mode is chosen (add it if missing).
- If the request includes `--wait`, run the subagent in the foreground and do not pass `--background` to `run`.
- If neither flag is present, default to foreground for a small, clearly bounded request; for complicated or long work, prefer background and pass bridge `--background`.
- `--wait` is Claude-side only (foreground vs enqueue). Do not treat it as task text. `--background` is a bridge flag when long work is chosen — forward it to `run`, and do not leave it in the natural-language task text.
- `--model`, `--effort`, `--write`, `--thread`, `--json-schema`, `--cwd`, `--prompt-file`, `--prompts-file`, `--timeout-ms`, and `--max-turns` are runtime controls. Preserve them for the forwarded `run` call; do not treat them as task text.
- Mutual exclusions the bridge enforces: `--resume`/`--resume-last` vs `--fresh`; `--thread` vs `--resume-last`. If both `--background` and `--wait` appear, treat as wait/foreground.
- `--prompts-file` is a sequential NDJSON batch on the bridge `run` path; it cannot be combined with `--background`, `--prompt-file`, or a positional prompt.

Execution mode:

- If the request includes `--background`, run the `grok-build:grok-delegate` subagent for a short enqueue only, with bridge `--background` on the `run` call.
- If the request includes `--wait`, run the `grok-build:grok-delegate` subagent in the foreground.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Grok, check for a resumable delegate thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Grok thread or start a new one.
- The two choices must be:
  - `Continue current Grok thread`
  - `Start a new Grok thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Grok thread (Recommended)` first.
- Otherwise put `Start a new Grok thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run ...` and return that command's stdout as-is.
- Return the Grok bridge stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/grok-build:runs`, fetch `/grok-build:show`, call `/grok-build:stop`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `run` command.
- Default write policy is read-only; `--write` only for explicit create/edit/fix requests.
- If the helper reports that Grok is missing or unauthenticated, stop and tell the user to run `/grok-build:check`.
- If the user did not supply a request, ask what Grok should investigate or fix.
