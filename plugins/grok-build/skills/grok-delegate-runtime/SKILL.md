---
name: grok-delegate-runtime
description: Internal helper contract for calling the grok-bridge runtime from Claude Code
user-invocable: false
---

# Grok Build Delegate Runtime

Use this skill only inside the `grok-build:grok-delegate` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run "<raw arguments>"`

Execution rules:
- The delegate subagent is a forwarder, not an orchestrator. Its only job is to invoke `run` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Grok CLI strings, or any other Bash activity.
- Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop` from `grok-build:grok-delegate`.
- Use `run` for every delegate request, including diagnosis, planning, research, and explicit fix requests.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- **Write policy: default to READ-ONLY.** Add `--write` only when the task explicitly asks Grok to create, edit, or fix files (implementation work). Investigation, diagnosis, research, review, triage, and summarization always run read-only. When adding `--write`, prefer a `--cwd` scoped to the narrowest sensible directory.

Background ownership model:
- Bridge `--background` owns the long-running process group (detached `run-worker` + grok agent) so the run records `bridgePid` and `agentPid`.
- Claude Code background / short enqueue is only for launching that bridge call, not for holding the long Grok process.
- When the user or command chose background mode, pass `--background` to `run`. Do not strip it.
- `--wait` is Claude-side foreground control only: do not pass it to `run`, and do not treat it as natural-language task text.

Command selection:
- Use exactly one `run` invocation per delegate handoff.
- If the forwarded request includes `--background`, pass it through to `run` (bridge owns the process group). Strip only Claude-only framing that is not a bridge flag, and do not leave routing tokens in the natural-language task text.
- If the forwarded request includes `--wait`, run foreground: do not add `--background` to `run`, and strip `--wait` from task text.
- If the forwarded request includes `--model`, `--effort`, `--cwd`, `--thread`, `--json-schema`, `--prompt-file`, `--prompts-file`, `--timeout-ms`, `--max-turns`, or `--write`, pass them through to `run` unchanged (they are runtime controls, not task text). Strip them from the natural-language task text.
- `--thread <name>` continues a named Grok conversation for this workspace; use it when the request names a thread or clearly continues an earlier named delegation. Names: 1–64 characters, letters/digits/`.`/`-`/`_`, must start alphanumeric; reserved names `__proto__`, `constructor`, and `prototype` are rejected. With `--fresh`, do not resume that name's stored session.
- `--json-schema <json>` requests schema-constrained structured output; the bridge exposes it as `structured` in the `--json` payload. The schema string must be a JSON object and is capped at 16000 characters.
- `--prompts-file <path>` runs a sequential NDJSON batch (bridge emits one NDJSON result line per prompt). Incompatible with `--background`, `--prompt-file`, and a positional prompt.
- `--timeout-ms` wall-clock-kills the agent process tree; `--max-turns` is forwarded to the CLI.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- Mutual exclusions: `--resume`/`--resume-last` vs `--fresh`; `--thread` vs `--resume-last`.
- `--effort`: accepted values are `low`, `medium`, `high`.
- `run --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous delegate run.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, stop runs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `run` command exactly as-is.
- Exit codes alone are incomplete: prefer `failureCode` from `--json` payloads when classifying failures.
  - `0` = deliverable present (`failureCode` null).
  - `2` = bridge-side failure: `no-deliverable` (empty output after optional automatic nudge), `schema-parse` (schema-constrained run produced no JSON object), `output-truncated` (stdout capture cap exceeded), `quota-exhausted` (the subscription's allowance is used up, HTTP 402; retrying cannot help until it resets), or `not-authenticated` (nobody is signed in; the CLI's remedy — `grok login --device-code` or `XAI_API_KEY` — is preserved in `rawOutput`, and retrying cannot help until someone does it). CLI status `2` can also surface as `cli-error` when the Grok process itself exited 2.
  - other non-zero = execution/CLI error (`cli-error`) or wall-clock kill (`timeout`).
  - Automatic nudge (one retry into the same session) runs only for read-only tasks when the first attempt exits 0 with empty output. It never runs for `--write`.
  - On a non-zero exit, return the command's error output unchanged so the caller can react — never return nothing.
