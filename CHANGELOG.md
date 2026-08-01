# Changelog

All notable changes to this fork are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-08-01

First public release. Fork of xAI's grok-build Claude Code plugin; the entries
below are what differs from the upstream baseline, `5a9f924 feat: Grok Build
Claude Code plugin`, which resolves in the upstream repository.

### Added

- Named threads: `run --thread <name>` with a per-workspace registry
  (`named-threads.json`) so conversational follow-ups continue the same Grok
  session across separate bridge invocations; per-thread lock so two runs
  cannot interleave one session.
- Structured schema output: `run --json-schema <json>` passes through to the
  CLI's constrained decoding; parsed result exposed as `payload.structured`;
  unparseable schema output fails the run (exit 2).
- Machine-wide concurrency slots: file-based semaphore in the shared state
  root caps concurrent Grok agents across all workspaces and sessions
  (`GROK_CC_MAX_CONCURRENCY` override; `0` disables the semaphore).
- `failureCode` in JSON payloads (`no-deliverable` / `schema-parse` /
  `cli-error`) to disambiguate non-zero exits.
- Prompt handover via `--prompt-file` so long review/critique contexts do not
  hit the Windows command-line length limit.
- Fork-hardening regression tests (JSON scanner, thread registry/locks, lock
  ownership, slot capping, executable resolution, read-only barrier flags).
- Wall-clock control: `--timeout-ms` kills a stuck agent run and fails it with
  `failureCode: timeout`; it also serves as the wait deadline for `runs` and
  `show --wait`, which exit `3` when the deadline passes.
- Output capture cap (`GROK_CC_STDOUT_CAP_BYTES`, default 32 MiB). Exceeding it
  fails the run with `output-truncated` instead of returning a partial answer
  as if it were complete.
- Batch prompts: `run --prompts-file <ndjson>` runs a sequence of prompts in one
  invocation.
- Cross-session visibility: `runs --all-sessions` lists every job in the
  workspace regardless of which Claude session started it.
- `run --fresh` forces a new Grok session, including when `--thread` names a
  thread that has a stored session.
- `usage` reports what the runs cost: per-run `total_cost_usd` and token counts
  aggregated across workspaces, plus the subscription's weekly percentage read
  from the CLI's own local log when one is there. That percentage is an
  unsupported side channel — reported, never enforced, and it fails open.

### Changed

- Read-only runs no longer use interactive plan mode (`--no-plan` + sandbox
  read-only) so headless runs do not stall on plan approval.
- Run output uses `--output-format json` for exact `finalMessage`, session id,
  turns, stop reason, and usage in the payload.
- Default concurrency bound raised from 3 to a self-scaling value (measured
  safe at high parallelism): `max(8, 2 × logical CPUs)`; the bound is a
  runaway guard, not a correctness requirement.
- Queue overflow starts the run after a short wait instead of failing it
  (backpressure only; work is not discarded).
- Default queue wait shortened (15 minutes → 90 seconds) so waiting for a slot
  does not become its own stall.
- Delegate agent and runtime skill aligned with fork defaults: read-only
  unless `--write`, pass-through of `--thread` / `--json-schema`, trust exit
  codes, surface error output.
- Deliverable gate treats non-empty output as success; a non-`EndTurn`
  stopReason no longer discards usable text.
- Schema parsing prefers the CLI's `structuredOutput` and otherwise takes the
  last JSON object in the text; also accepts concatenated schema objects.
- Job ids from the command line are validated before path join; `run` stops
  parsing options at the first prompt word so an unquoted `--write` inside a
  task description cannot grant write access.
- Documentation aligned with runtime contracts: review/critique described as a
  read-only write barrier (not plan mode); concurrency default
  `max(8, 2 × CPUs)`, 90s wait-then-start, env knobs, and per-user fallback
  state root; one background ownership model (bridge `--background` owns the
  process group); `failureCode` as the real exit discriminator with read-only
  nudge, and review/critique documented as applying the same deliverable gate
  as `run` rather than forwarding CLI status; slash argument-hints and
  operator Operations section (SessionEnd, Windows install, state layout,
  failure modes); thread name rules, `--json-schema` 16k cap, and
  `--background`/`--wait` precedence documented.
- SessionEnd keeps job history: it cancels the session's active jobs and stops
  their processes, but no longer rewrites the workspace job list, so finished
  records survive for `show` and `runs --all-sessions`. Retention is the
  `MAX_JOBS` prune plus the explicit `clean` command.

### Fixed

- Honest exit codes: exit `0` only when a deliverable exists; exit `2` when
  the bridge detects no deliverable (after one automatic nudge) or unparseable
  schema output.
- The truncation gate covers `review` and `critique`, not just `run`. A
  truncated plain review still has text, so it used to be reported as a
  finished review; a truncated critique usually fails to parse and was
  reported as `schema-parse`, blaming the model for output the bridge cut off.
- State lock hardening: retry `EPERM`/`EACCES`/`EBUSY` (Windows contention),
  jittered backoff, token ownership on release, liveness-first steal with age
  backstop, deadline that exceeds reclaim thresholds, self-heal when a
  recycled pid still looks alive.
- Global slot ownership-checked release; one reclaim attempt per slot per
  pass; absolute wait ceiling; async waiting so the event loop keeps turning.
- Envelope detection requires a real envelope shape so model text containing a
  `"text"` key is not mistaken for the CLI envelope.
- Thread registered only on success; registration failure surfaces; background
  path accepts `--thread` like the foreground path.
- One concurrency slot held across a run and its nudge; failed nudge no longer
  discards the first result; nudge never re-runs `--write` tasks unattended.
- Windows: resolve executables via `PATHEXT` and spawn directly (no shell) —
  removes the "Select an app to open 'grok'" dialog and MSYS-mangled
  `taskkill` arguments; no shell fallback when a binary cannot be resolved.
- Script entry points (`GROK_BINARY=*.mjs`) run through the current Node
  binary.

### Security

- Real write barrier on read-only runs: `--disallowed-tools` removes
  `run_terminal_cmd` / `search_replace` / `search_tool` / `use_tool`,
  `--deny` rules block
  `Bash` / `Write` / `Edit` / `MCPTool`, with `--sandbox read-only` retained
  for kernel enforcement where the OS provides it. Sandbox alone was not a
  barrier on Windows (a "read-only" run could create files; reproduced and
  blocked).
- No shell fallback on Windows when resolving binaries (removes remaining
  ShellExecute / interpolation surface).
- Job-id path validation prevents directory escape via `show` / similar
  commands.
- Thread names validated (no `__proto__` / path characters); `--json-schema`
  must be a JSON object and is size-checked against command-line limits.

### Note on the marketplace identifier

This plugin registers under `claude-code-grok-bridge`, not upstream's
`xai-grok-build`. The id is part of the install cache path, so a distinct one lets
the official plugin and this fork coexist on the same machine — and Claude Code
2.1.196 handles a collision badly: it accepts a duplicate id without warning, then
fails to load the plugin and points at whichever path was registered last.

⚠ `claude plugin uninstall` deletes the plugin's data directory — the job records
and the local spend ledger — silently, while exiting 0 (measured against Claude
Code 2.1.196). Copy `~/.claude/plugins/data/<marketplace-id>/` first if those
matter to you.
