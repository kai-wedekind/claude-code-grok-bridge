# Claude Code ↔ Grok Build Bridge

**Give Claude Code a second model to hand work to.** A diff to review, a problem you
are stuck on, a job long enough that you would rather not sit and watch it — Grok takes
it and answers back into the session you are already working in. A marketplace plugin
that shells out to the real `grok` CLI; no broker, no service in between.

It bills to your Grok account rather than to Claude quota. If you already pay for a plan
that includes Grok — an X Premium subscription, say, though which plans include what is
xAI's to define, so check their current terms — and you spend your working day in
Claude Code, chances are you are nowhere near using what you are already paying for.
This puts it to work without changing where you work.

The rest of the effort here went into making a delegated run trustworthy: you can see
what it cost, stop it and know it stopped, and tell the difference between an answer and
a failure.

**What you get:**

- **A genuinely independent second opinion.** The point is not another pass by the
  model you are already talking to. It is a different one, with its own blind spots,
  reading your diff or your design and disagreeing where it disagrees.
- **Reach into 𝕏, which Claude Code cannot.** x.com is closed to it; Grok has that
  access natively. A post URL or a research question — what shipped, what people are
  hitting, how they worked around it — gets answered without leaving your session.
- **Work that outlives the request.** Send a long job to the background and carry on.
  It can be listed, inspected while it runs, and picked up afterwards, from any session.
- **Stop that actually stops.** Cancelling terminates the process tree and confirms the
  kill landed. A run is never marked cancelled while its agent quietly keeps going and
  keeps spending.
- **You can see what it costs.** Every run's reported spend is kept locally, by day and
  by workspace. There is no quota endpoint to ask, so this is the only view you have —
  and it separates runs that cost *nothing* from runs whose cost is *unknown*, rather
  than scoring both as zero and flattering the total.
- **A result, or a reason there is none.** Success means output arrived, failure names
  which kind of failure it was, and partial output is kept and labelled as partial. The
  exit code, the printed text and the JSON payload are not allowed to disagree.
- **Safe to point at code you did not write.** Read-only is the default and is real:
  the writing tools are removed, which holds on Windows too, where the CLI's own sandbox
  flag is silently ignored. Full write access is one flag away when you want it.
- **Built for repeat use, not one-shot demos.** Conversations continue across separate
  calls instead of restarting cold; structured output comes back as parsed JSON and
  fails loudly rather than handing you prose that will not parse; and you can fire as
  many runs as you like without counting what is already in flight.
- **Nothing installed from a registry.** No dependencies, no lockfile. `git clone` plus
  Node is the entire supply chain, and you can read all of it.
- ⚠ Installing it does **not** make Claude Code use it. See
  [Making Claude Code actually use it](#making-claude-code-actually-use-it) — that gap is
  deliberate.

⚠ **Windows and Linux are used in earnest. macOS is not.** The full suite runs on all
three in CI, including tests that spawn and kill real processes — but the end-to-end
suite that drives the actual `grok` CLI has only ever run on Windows, on Linux and on a
Raspberry Pi, because there is no Mac here to run it on. macOS is not deliberately
unsupported and there is no known reason it would fail; it is simply unverified in real
use, so stable operation there is not something this project can promise. If you run it
on a Mac and something breaks, that is a useful bug report.

**Requires** Node ≥ 18.18 and a logged-in `grok` CLI, both on the persistent PATH.
**Start at** [Install](#install), or the [FAQ](#faq) if you would rather have the obvious
questions answered first — whether your code leaves the machine, whether this collides with
xAI's own plugin, which plan you need. **Before pointing it at code you did not write,**
read [SECURITY.md](SECURITY.md) — particularly what read-only does and does not protect.

---

## About this fork

This is a **modified fork** of xAI's grok-build Claude Code plugin (Apache-2.0). It is maintained by Kai Wedekind ([@KaiWedekind](https://x.com/KaiWedekind)) and is **not** an official xAI release. It is not an Anthropic product either, and carries no endorsement from, or affiliation with, either company. Grok, Grok Build, SuperGrok, Claude Code and X are named throughout only to say what this software talks to and what it spends — see `NOTICE` for the trademark attributions. It comes with no warranty; the Apache License 2.0 in `LICENSE` governs that, in sections 7 and 8.

It exists to make the bridge dependable enough to leave running: a run either produces something or says why it did not, agents can be stopped and their spend accounted for, and the whole thing behaves the same on Windows as it does anywhere else.

**It does not take capabilities away.** Grok can still write code, run commands and edit files here — that is `--write`, and it works. What changed is which mode is the *default*, and whether the guarantees the original made were actually true on every platform.

Substantive changes relative to the upstream baseline, [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc) at `5a9f924`. Each is written as the problem first, because that is what tells you whether it affects you. The fork's development history was condensed into a single commit for publication, so this list — together with `CHANGELOG.md` — *is* the record of what changed; it is not a summary of commits you can go and read here.

- **A run could report success having done nothing.** Read-only work was routed through interactive plan mode, whose "present a plan and wait" branch dead-ends when there is nobody to approve it — so the run ended, exited `0`, and returned a plan instead of an answer. Plan mode is no longer used as a barrier; deliverables are detected from the CLI's own JSON, and the exit code now means something: `0` only with output, `2` without, plus a `failureCode` saying which kind of nothing you got.
- **Read-only was not enforced on Windows.** The original relied on the CLI's `--sandbox read-only`, which that platform ignores — so the flag sat on the command line looking like protection while the agent could write anywhere. Confinement now happens at the tool layer, by removing the writing tools and adding deny rules for `Bash`/`Write`/`Edit`/`MCPTool`, which holds everywhere; the kernel sandbox is an extra layer where the OS supports it, not the load-bearing one. **`--write` unlocks full write access** in the directory you point `--cwd` at — see `SECURITY.md` for what each mode does and does not protect.
- **Killing a run did not reliably kill the agent.** Stopping now terminates the real process tree and confirms it, rather than marking a record cancelled and leaving a process behind; a job whose processes are gone is reclaimed instead of sitting at "running" forever. Crash recovery is covered by the acceptance suite, not just by unit tests.
- **Spend was invisible.** Every run draws on a paid allowance with no quota endpoint to ask. The bridge now keeps a local ledger of what each run reported — `usage` reads it, names which state root it read, and counts runs whose cost is *unknown* separately from runs that cost nothing.
- **Long-running work had nowhere to live.** `--background` plus tracked run records, so a run survives the call that started it and can be listed, inspected and stopped afterwards.
- **Every invocation started a new conversation.** `--thread <name>` continues a per-workspace Grok conversation across separate bridge calls, so iterative work does not mean re-sending context.
- **Results were prose only.** `--json-schema` constrains the output and hands back a parsed `structured` payload; output that does not parse fails the run instead of quietly arriving as text.
- **Concurrency was a fixed bound of three, and overflow failed the run.** The bound is now self-scaling and machine-wide via a file-based semaphore; at the limit runs queue and then start rather than being rejected, so a caller never has to count other agents before offloading.
- **Windows process handling went through a shell.** Executables are resolved via `PATHEXT` and spawned directly — no ShellExecute dialog, no MSYS path mangling — and long prompts are handed over in a file rather than on `argv`, which used to hit `ENAMETOOLONG`.
- **Review context followed symlinks out of the repository.** A link in the working tree had its target read and inlined into what was sent to the model. Symlinks are now detected with `lstat` and named without being opened.

Identity metadata in this tree names Kai Wedekind as owner/author; the plugin functional name remains `grok-build`. Upstream copyright stays in `NOTICE` / `LICENSE`.

---

[Grok Build](https://x.ai) in Claude Code for review, critique, delegation, and session import. Run status, results and stop are owned by the plugin through PID and log files; there is no app-server broker.

## Requirements

- Node.js `>= 18.18` — **on the persistent PATH**, not merely in the shell you install from. The session hooks invoke a bare `node`; where it is missing they fail silently and `GROK_CC_SESSION_ID` is never set. A portable, no-admin install is enough (unpack the Windows zip or the Linux tarball and add its directory to the user PATH).
- Grok Build CLI (`grok`) on `PATH`, or set `GROK_BINARY`
- **Something for the CLI to bill against.** The bridge does not handle billing or authentication at all — it launches the CLI and reports what the CLI reports. So whatever makes `grok` work for you interactively will work here: a signed-in session, or `XAI_API_KEY` in the environment. Which plans and credit arrangements exist, and how they interact, is xAI's to define and change; check their current terms rather than trusting a list written here. What is worth knowing on this side is that **every run costs something**, that the bridge cannot see your remaining balance, and that the local ledger is therefore the only spend record you get.
- A logged-in Grok CLI session — verify with `grok models`, and read what it prints rather than trusting its exit code. On the first call after the access token expires, that command can exit `0` while stating that you are *not* authenticated: it reads its auth state before the in-flight token refresh completes. Measured twice on 2026-07-31 against grok 0.2.117: the refresh took 373 ms and 441 ms, and about 690 ms passed before the model catalog was usable. `/grok-build:check` accounts for this and will not report `ready` in that state.
- There are **no npm dependencies**. Nothing is installed from a registry, and there is no lockfile — `git clone` plus Node is the whole supply chain.
- **Platform coverage is uneven, and the two halves are worth separating.** *Unit tests:* 316 of them, run in CI on all three operating systems — Linux across Node 18.18, 20 and 22, Windows on the oldest and newest of those, macOS on the newest. A good part of that suite spawns and kills real processes rather than mocking them, so the platform-specific process handling genuinely runs on each. *End to end against the real `grok` CLI:* an eleven-gate acceptance suite covering the write barrier, structured output, thread continuity, concurrency, crash recovery and orphan cleanup — run on Windows, on Linux and on a Raspberry Pi (aarch64), and **never on macOS**, for want of the hardware. So macOS has the code exercised but not the product; expect it to work, do not expect it to be proven.

## Install

### The short way: ask Claude Code to do it

You are going to use this *through* Claude Code, so let it do the installing. Paste this into a session:

```text
Install the Claude Code ↔ Grok bridge for me:
clone https://github.com/kai-wedekind/claude-code-grok-bridge, register the clone as a
local marketplace, install the plugin grok-build from it, then run npm test and
/grok-build:check and tell me what both said. Stop and ask me if anything fails —
do not work around it.
```

It needs `git`, `node` (≥ 18.18) and the `grok` CLI on PATH; if one is missing it will say so. The last sentence matters: an installation that quietly routes around a problem is how you end up with a plugin that loads but does not work.

The long way is below, and it is worth reading once even if you took the short one — steps 3 and the two warnings are things the short way cannot check for you.

### 1. Get the code

```bash
gh repo clone kai-wedekind/claude-code-grok-bridge
cd claude-code-grok-bridge
```

Or without the GitHub CLI: `git clone https://github.com/kai-wedekind/claude-code-grok-bridge.git`

### 2. Register it as a local marketplace and install

**Unix / macOS** — from the repository root (the path must be absolute):

```bash
claude plugin marketplace add "$(pwd)"
# example: claude plugin marketplace add /absolute/path/to/claude-code-grok-bridge

claude plugin install grok-build@claude-code-grok-bridge
```

**Windows (PowerShell):**

```powershell
claude plugin marketplace add (Get-Location).Path
# example: claude plugin marketplace add C:\src\claude-code-grok-bridge

claude plugin install grok-build@claude-code-grok-bridge
```

Or, when Claude Code is already open, use `/plugin`, add the local marketplace path, then install `grok-build@claude-code-grok-bridge`.

> **The marketplace id is deliberately not upstream's.** It matches this repository rather than reusing `xai-grok-build`, so the official xAI plugin and this fork can be installed side by side. That matters more than it sounds: measured on a clean machine, 2026-07-31, Claude Code 2.1.196 accepted a second marketplace under an id it already knew **without any warning** and exited 0, after which the installed plugin failed to load and pointed at whichever path was registered last — and removing the duplicate marketplace uninstalled the plugin along with it.

### 3. Verify the install

```bash
claude plugin list            # expect: grok-build@claude-code-grok-bridge — Status: enabled
claude plugin details grok-build
```

`details` should report 8 commands, 3 skills, 1 agent, and 2 hooks (`SessionStart`, `SessionEnd`). Then, inside Claude Code:

```text
/grok-build:check
```

Ready means Node is available, `grok` is available, and `grok models` both succeeded **and** did not deny the session. If `grok` is not on `PATH`:

```powershell
$env:GROK_BINARY = "C:\path\to\grok.exe"
# or a Node entry script: $env:GROK_BINARY = "C:\path\to\grok.mjs"
```

### Updating an existing install

Claude Code loads the plugin from its cache directory, not from this working copy, so edits here take effect only once they are mirrored across:

```bash
scripts/deploy-local.sh           # sync working copy → installed plugin
scripts/deploy-local.sh --check   # report drift and exit 1, for a pre-commit gate
```

This is a **sync** tool and not an installer: it needs the directory that step 2 creates and exits 1 with the install commands if it is missing. It also needs `node` on `PATH`, because the install path carries the plugin version and that is read from the manifest rather than hardcoded. On Windows it needs a real `bash` — Git for Windows puts one in `C:\Program Files\Git\bin`, which is not on `PATH` by default.

> **`claude plugin marketplace remove` does not delete the cache, and neither does a version bump.** Measured on two machines against Claude Code 2.1.196: after a rename or a bump, `~/.claude/plugins/cache` holds **both** directories, and the old one still contains the previous build. Nothing loads it — but `scripts/acceptance.sh` finds the bridge by globbing that cache and takes the first hit. That is worse than a coin toss: the glob sorts lexicographically, so `0.2.0` comes before `0.3.0` and the **stale** build wins reliably, for as long as the major number stays the same. After any rename or bump, delete the old directory and confirm the glob resolves to exactly one path.
>
> **`claude plugin uninstall` DOES delete the plugin's data directory — and that asymmetry is exactly backwards.** It takes the run records and the local spend ledger with it, silently, while leaving the re-installable cache in place: the irreplaceable part goes automatically, the replaceable part stays. The command prints `Successfully uninstalled plugin`, exits 0, and does not mention the data directory at all. **So read `usage` — or copy the state directory — before you uninstall.** That is the very first command of a reinstall, so there is no later moment at which to do it.
>
> Isolated against Claude Code 2.1.196: the directory `~/.claude/plugins/data/<marketplace-id>` was populated immediately before `claude plugin uninstall` and gone immediately after, with no command in between; `marketplace remove` was then run on its own and left the data directory untouched.

## Making Claude Code actually use it

Installing the plugin gives Claude Code the **ability** to reach Grok. It does not give it an **occasion**. The slash commands below wait until you type one, and the only thing that fires on its own is the `grok-delegate` subagent's description — being stuck, wanting a second implementation pass, handing over a substantial coding task. Everything else people expect ("keep long documents out of my context", "always use Grok for X/Twitter", "research first, then work") happens only if you say so.

That is a deliberate gap: how much of your work leaves your machine, and how much of a paid allowance it spends, is not a plugin's decision.

So there are two ways to run this, and both are legitimate end states.

**Manual only.** Type a slash command when you want Grok, and nothing reaches it otherwise. No configuration, no standing instruction, no surprises on your bill. If that is all you ever want, you are already finished — the rest of this section is optional.

**Or tell Claude Code when to reach for it.** A few lines in your `CLAUDE.md` turn "I could delegate this" into something that happens without you asking each time: send long documents to Grok instead of your context, always use it for 𝕏, get a second opinion before you commit. You decide which of those, and how far it goes.

**[docs/ADOPTION.md](docs/ADOPTION.md)** is the guide for the second path. It sketches five routing tiers — `manual`, `second-opinion`, `reach`, `offload-first`, `delegate-write` — and gives you a five-line block to paste into `CLAUDE.md`, with the definitions in the shipped `grok-build:grok-routing` skill so they travel with the plugin rather than rotting in a copy.

⚠ **Those tiers are an example, not a contract.** They exist so you have something that works without designing a policy first. Edit the skill, write your own tier, name different triggers, or ignore the whole scheme and put one sentence in your `CLAUDE.md` — the plugin does not read the tiers and does not care which you picked. It is your machine, your allowance, and your call how much of either this thing gets.

## FAQ

**Does my code leave my machine?**
Yes. Every task is handed to the real `grok` binary, which sends it to the Grok service —
prompts, file contents the agent reads, and its output. Nothing in this plugin changes that
and no local setting prevents it. Separately, the CLI has a telemetry and trace-upload
channel of its own that this plugin does not touch;
[SECURITY.md](SECURITY.md) lists the switches, verified against the installed binary.

**Do I have to uninstall xAI's official plugin first?**
No. This registers under a different marketplace id (`claude-code-grok-bridge`, not
`xai-grok-build`) precisely so the two can sit side by side. Installing both under the same
id fails in a confusing way, which is why the ids differ.

**Which Grok plan do I need?**
Whatever makes `grok` work for you interactively will work here — the bridge does not handle
billing or authentication at all, it launches the CLI and reports what the CLI reports. Which
plans and credit arrangements exist is xAI's to define and change, so check their current
terms rather than a list written here. What is worth knowing on this side: every run costs
something, the bridge cannot see your remaining balance, and the local ledger is therefore
the only spend record you get.

**I installed it and Claude Code never uses it. Is it broken?**
No, that gap is deliberate. Installing a plugin makes commands available; it does not teach
the model when to reach for them. See
[Making Claude Code actually use it](#making-claude-code-actually-use-it) — a few lines in
your `CLAUDE.md` is the whole fix.

**Is it safe to point at a repository I did not write?**
Read-only is the default and is enforced by removing the writing tools, so the agent cannot
change your files. But read-only protects *integrity*, not *confidentiality*: the reading
tools and web search are still there, so hostile text in a repository can influence what the
model does with what it read. `SECURITY.md` says exactly what each mode does and does not
protect. Do not pass `--write` on a repository you do not trust.

**Does it work on macOS?**
The unit suite runs there in CI, including tests that spawn and kill real processes. The
end-to-end suite against the real `grok` CLI has never run on macOS, for want of the
hardware. So the code is exercised and the product is not proven — expect it to work, do not
expect it to be verified, and a bug report from a Mac is genuinely useful.

**What happens when the Grok allowance runs out mid-run?**
The run fails with `failureCode: quota-exhausted` rather than looking like a generic error,
and the tokens the run had already spent before the refusal are still booked to the ledger.
Retrying cannot help until the allowance resets.

**Why is the history a single commit?**
The fork's development history was condensed for publication. The upstream baseline is named
in `NOTICE` and resolves in xAI's repository, so the exact set of changes is derivable by
diffing this tree against it — and `CHANGELOG.md` says what changed and why.

## Commands

Slash-command behaviour details live in `plugins/grok-build/commands/*.md`. This section is the public contract.

### `/grok-build:check`

Probe Node + Grok CLI availability and authentication. Also reaps orphaned runs whose tracked processes are gone.

### `/grok-build:review`

Read-only review of local git state (write barrier, not plan mode):

```text
/grok-build:review --wait
/grok-build:review --background --scope working-tree
/grok-build:review --base main
/grok-build:review --wait --model <model> --effort high
/grok-build:review --wait --timeout-ms 120000 --max-turns 40
/grok-build:review --wait focus on auth error paths
```

The bridge launches roughly:

```bash
grok --prompt-file <file> --agent explore --no-plan --sandbox read-only \
  --disallowed-tools run_terminal_cmd,search_replace,search_tool,use_tool \
  --deny Bash --deny Write --deny Edit --deny MCPTool \
  --cwd <ws> --output-format json
```

That is the real barrier: `--no-plan` (avoids interactive plan approval, which dead-ends headless), tool removal, deny rules, and sandbox where the OS enforces it. Do not call this "plan mode". On Windows the sandbox is not kernel-enforced, so tool removal and deny rules are the binding half of the barrier.

Optional flags: `--model`, `--effort` (`low`|`medium`|`high`), `--timeout-ms <ms>`, `--max-turns <n>`, `--base <ref>`, `--scope auto|working-tree|branch`, `--wait` / `--background`, `--json`. If model/effort are omitted, Grok chooses defaults. Trailing words after flags are optional focus text (joined into the review prompt). Staged-only / unstaged-only scopes are not supported.

Review applies the same deliverable gate as other bridge paths: empty stdout on CLI exit 0 fails with exit `2` and `failureCode: no-deliverable`. See [Exit codes and failure classes](#exit-codes-and-failure-classes).

**What review actually sends.** The diff, plus the full contents of *untracked* text files, inline, up to **24 KiB each** — that content goes to the Grok service like everything else. Larger files, binaries and symlinks are replaced by a visible placeholder naming the reason rather than being read; symlinks in particular are named but never followed, since following one leaves the repository. Files git ignores are excluded, so the usual `.env` does not travel. If a file you expected to be reviewed is missing from the result, one of those limits is why.

### `/grok-build:critique`

Same target selection as review, with a design/risk critique prompt and structured JSON constrained by the review output schema:

```text
/grok-build:critique --wait
/grok-build:critique --base main challenge whether this was the right caching and retry design
/grok-build:critique --wait --model <model> --effort high focus on failure modes
/grok-build:critique --wait --timeout-ms 180000 --max-turns 50
```

The bridge launches roughly:

```bash
grok --prompt-file <file> --agent explore --no-plan --sandbox read-only \
  --disallowed-tools run_terminal_cmd,search_replace,search_tool,use_tool \
  --deny Bash --deny Write --deny Edit --deny MCPTool \
  --cwd <ws> --output-format json --json-schema <review-schema>
```

Optional flags: same as review (`--model`, `--effort`, `--timeout-ms`, `--max-turns`, `--base`, `--scope`, `--wait` / `--background`, `--json`). Extra focus text after flags is supported. Same read-only write barrier as review.

Critique fails with exit `2` when output is empty (`no-deliverable`) or when JSON is missing / unusable against the review shape (`schema-parse`). See [Exit codes and failure classes](#exit-codes-and-failure-classes).

### `/grok-build:delegate`

Delegate investigation or implementation to Grok via the `grok-build:grok-delegate` subagent (bridge command: `run`):

```text
/grok-build:delegate investigate the flaky test in auth
/grok-build:delegate --resume apply the top fix
/grok-build:delegate --model <model> --effort high fix the race
/grok-build:delegate --write --cwd packages/auth implement the retry helper
/grok-build:delegate --background --thread auth-debug dig into the race
/grok-build:delegate --json-schema '{"type":"object","properties":{"summary":{"type":"string"}}}' summarize findings
/grok-build:delegate --timeout-ms 300000 --max-turns 80 investigate hang
/grok-build:delegate --prompts-file prompts.ndjson
```

Write policy layering:

| Layer | Default |
| --- | --- |
| Bridge `run` CLI | **Read-only** unless you pass `--write`. Enforced by removing the writing tools (`--disallowed-tools run_terminal_cmd,search_replace,search_tool,use_tool`) plus `--deny` rules for `Bash`/`Write`/`Edit`/`MCPTool`, with `--sandbox read-only` on top for kernel enforcement where the OS supports it. Plan mode is **not** used: its "present plan, await approval" fork dead-ends in headless mode. |
| Delegate agent / skill | Read-only as well; `--write` is added only for explicit implementation requests |

Note on `--sandbox`: the CLI enforces it via Landlock (Linux) / Seatbelt (macOS) and continues without enforcement elsewhere, so on Windows it is not a barrier by itself — hence the tool removal and deny rules above.

- Direct `node …/grok-bridge.mjs run "…"` is therefore read-only unless `--write` is passed.
- `--thread <name>` continues a named conversation for this workspace (registry per workspace, one run at a time per name). Without `--fresh`, an existing registration is resumed; with `--fresh`, that name starts a new Grok session and is re-registered only if the run delivers output. Names must be 1–64 characters: letters, digits, `.`, `-`, or `_`, starting alphanumeric. Reserved names `__proto__`, `constructor`, and `prototype` are rejected.
- `--json-schema '<schema>'` constrains the answer to JSON; the parsed object is exposed as `structured` in the `--json` payload, and a run that yields no JSON object fails. The schema string must be a JSON object and is size-capped at **16000 characters** (command-line limit guard).
- `--prompts-file <path>` runs a sequential NDJSON batch (one JSON string or `{"prompt":"…"}` object per non-empty line). Emits one NDJSON result object per prompt on stdout. Incompatible with `--background`, `--prompt-file`, and a positional prompt. Without `--thread`, later lines chain via resume of the previous line's session; with `--thread`, all lines share that named conversation.
- `--timeout-ms <ms>` is a wall-clock kill for the Grok process tree. `--max-turns <n>` is forwarded to the CLI.
- `--resume` / `--resume-last` continues the last stored Grok session id via `grok -r <id>`. Mutually exclusive with `--fresh`. `--thread` is mutually exclusive with `--resume-last`. `--fresh` is the default when neither resume nor an existing named thread applies; the flag exists so callers can be explicit and so combining it with resume fails loudly.
- Prefer bridge `--background` for long work so runs record both `bridgePid` (Node worker) and `agentPid` (grok child). Claude Code background is only for short enqueue of that bridge call.
- For `review` / `critique`, if both `--background` and `--wait` are present, **`--wait` wins** (foreground). `run` accepts `--background` only (no `--wait` flag on the bridge `run` command).
- `/grok-build:stop` terminates **both** process trees when present (agent then bridge/worker).
- If you do not pass `--model` or `--effort`, Grok chooses its own defaults.
- Exit codes and `failureCode` for `run` / review / critique: see [Exit codes and failure classes](#exit-codes-and-failure-classes).
- Concurrency and the write barrier: see [Concurrency and write barrier](#concurrency-and-write-barrier).

### `/grok-build:import`

Import the current Claude transcript into Grok:

```text
/grok-build:import
/grok-build:import --source ~/.claude/projects/.../session.jsonl
/grok-build:import --thread imported-main
```

Uses `grok import` and prints a resume hint: `grok -r <id>`. Optional `--thread <name>` registers the imported Grok session id under that name for later `run --thread`.

### `/grok-build:runs`

List active and recent plugin-owned runs:

```text
/grok-build:runs
/grok-build:runs <run-id>
/grok-build:runs <run-id> --wait
/grok-build:runs <run-id> --wait --timeout-ms 120000
/grok-build:runs --all
/grok-build:runs --all-sessions
```

**Session scope (why history can look empty):**

| Mode | What you see |
| --- | --- |
| Default | Only runs whose `sessionId` matches the current Claude session (`GROK_CC_SESSION_ID`). Active runs for that session, the latest finished, and up to 8 other recent finished runs. |
| `--all` | Still scoped to the current Claude session, but the recent-finished list is not capped at 8. |
| `--all-sessions` | Every run recorded for this workspace, across Claude sessions. Recent list is uncapped; the table includes a Claude Session column. |

Finished runs from earlier Claude sessions are **kept** (SessionEnd does not delete history). They are hidden by the default session filter — use `--all-sessions` to see them. Retention prunes the oldest records, plus optional `clean` (bridge CLI). The cap of **50** (`MAX_JOBS`) applies per bucket, not to the workspace as a whole, so the total can legitimately exceed it:

- **Active runs** (`queued`, `running`) are never pruned. A retention policy must not delete a result at the moment it becomes available.
- **Survivors** — terminal records that still name an *agent* process, meaning a stop was attempted and could not be confirmed — keep the newest 50. That pid is the only way back to a process that may still be running, so it outlives ordinary history; it is capped all the same, because nothing sweeps a pid whose process died without a second stop. A leftover `bridgePid` does not make a survivor: the completion path leaves one on every finished record, and counting those would let ordinary history crowd out the record that matters.
- **Ordinary finished runs** keep the newest 50.

`--wait` requires a run id. Default wait timeout is 240000 ms. If the job is still active when the wait deadline expires, exit code is **3**.

Before listing, dead bridges (all kill-target PIDs gone) are reclaimed as failed orphans so they do not block the list forever.

### `/grok-build:show`

Show stored output for a finished run:

```text
/grok-build:show
/grok-build:show <run-id>
/grok-build:show <run-id> --wait
/grok-build:show <run-id> --wait --timeout-ms 120000
```

Without a run id, shows the latest finished run for the **current Claude session**. With an explicit id, any workspace run may be selected (id lookup is not session-filtered). Process exit reflects the stored run status (`0` completed success, non-zero failed/cancelled). `--wait` requires a run id; wait timeout exits **3** and prints status instead of the result.

### `/grok-build:stop`

Stop an active run by terminating tracked process trees:

```text
/grok-build:stop
/grok-build:stop <run-id>
```

Without a run id, stops the single active run for the current Claude session (errors if none or if several are active). Kills every distinct pid among `agentPid` (detached grok child) and `bridgePid` / legacy `companionPid` / legacy `pid` (bridge or run-worker). Terminal status is claimed under a locked CAS so a finishing worker cannot overwrite `cancelled` with `completed`.

## Exit codes and failure classes

Process exit alone is overloaded. Prefer `failureCode` in `--json` payloads when present.

| Exit | `failureCode` | Applies to | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `0` | `null` | `run`, review, critique | Deliverable present (non-empty model output; for schema runs, a usable JSON object / structuredOutput also counts) | Use the result. |
| `2` | `no-deliverable` | `run`, review, critique | CLI exited 0 but produced no usable output (after optional automatic nudge on read-only `run`) | Retry with a clearer prompt; do not assume side effects. |
| `2` | `schema-parse` | `run` with `--json-schema`, critique | Output was **present but not usable** as a schema/review JSON object. A run that produced nothing at all is `no-deliverable`, not this — the schema is only judged once there is something to judge | Fix schema or prompt; keep `--json-schema` under 16000 characters. |
| `2` | `quota-exhausted` | `run`, review, critique | Grok refused the run for quota reasons (HTTP 402). The bridge does not auto-retry it, because on a plan allowance retrying only burns time until the reset — but whether it can help at all is a property of your account, not of this code: credit can be topped up, and an account permitted to fall through to metered tokens may simply carry on. The tokens already spent on the failed run are still recorded. |
| `2` | `not-authenticated` | `run`, review, critique | Nobody is signed in. The CLI's own remedy (`grok login --device-code`, or `XAI_API_KEY`) is preserved in `rawOutput`. Retrying cannot help until someone logs in. |
| `2` | `output-truncated` | `run`, `review`, `critique` | Stdout exceeded the capture cap (default 32 MiB) and was truncated; never treated as success. A non-zero CLI status is classified first, so a run that both failed and overflowed reports `cli-error` | Narrow the task or raise capture only if you accept memory cost (`GROK_CC_STDOUT_CAP_BYTES`). |
| non-zero (often CLI status; timeout uses `1`) | `cli-error` | `run`, review, critique | Grok CLI failed | Check `grok models`, `GROK_BINARY`, auth; read stderr in the payload / log. |
| non-zero (often `1`) | `timeout` | `run`, review, critique | Wall-clock `--timeout-ms` killed the process tree | Raise `--timeout-ms`, reduce scope, or inspect partial log output. |
| `3` | (none) | `runs` / `show` with `--wait` | Wait deadline expired while the job was still active | Poll again or raise `--timeout-ms`. |
| non-zero | (none / stored) | `show`, `stop`, cancel paths | Stored failure/cancel, or stop / registry errors | Inspect `/grok-build:runs` and the job log. |

Notes:

- "Applies to" names the commands that talk to Grok. `import`, `check`, `runs`, `show`, `stop`, `threads`, `clean` and `usage` never produce a `failureCode`: they read local state or a local transcript, so there is no CLI run to fail. Two rows said "all" and meant these three.
- Automatic nudge (one retry into the same session) runs **only on read-only `run`** when the first attempt exits 0 with empty output. It never runs for `--write`, and it is not used on review/critique.
- Review uses `--output-format json` and gates on non-empty final text, taking the envelope's text where there is one and raw stdout where there is not. It used to pass `plain`; that produced no envelope, so no usage figure, so every successful review was missing from the spend ledger entirely. Critique uses `--output-format json` plus the review JSON schema and gates on parse + review shape (`verdict`, `summary`, `findings`, `next_steps`).
- Cancelled runs never report process success (exit 0).
- `--timeout-ms` is a **best-effort deadline, not a hard one.** The run path performs synchronous work — resolving the binary, taking the state lock, and killing the process tree via `taskkill /T` — and each of those blocks the event loop, including the timer that enforces the deadline. On an idle machine the overshoot is a second or two. On a busy one it is much larger: measured 2026-07-28 under load, a 500 ms budget took about 19 seconds end to end, most of it before the agent was even spawned. What the deadline does guarantee is that the run ends and reports `failureCode: timeout` rather than hanging indefinitely. Callers that need a hard bound must impose their own on the bridge process.

## Concurrency and write barrier

**Machine-wide concurrency.** Concurrent Grok agent processes share a file-based semaphore under the resolved state root. Default cap is `max(8, 2 × logical CPUs)`. Set `GROK_CC_MAX_CONCURRENCY` to change it; `0` removes the bound. When every slot is taken, a new run **waits** up to `GROK_CC_SLOT_WAIT_MS` (default 90000), then **starts anyway** rather than failing — so a caller never has to count other agents before offloading. The bound is a runaway guard for unbounded fan-out, not a correctness lock: same-workspace job-list collisions use the state lock; same named conversation uses a per-thread lock. Processes with different `CLAUDE_PLUGIN_DATA` form **independent pools**.

**Per-thread lock.** Two `run --thread <name>` invocations for the same name cannot interleave turns in one Grok session. The second run fails immediately with a clear error until the first finishes or is stopped.

**Write barrier (read-only runs).** Enforcement order: (1) `--disallowed-tools` removes `run_terminal_cmd`, `search_replace`, `search_tool` and `use_tool` from the toolset (the binding half on Windows); (2) `--deny` rules reject `Bash` / `Write` / `Edit` / `MCPTool` if a tool reappears; (3) `--sandbox read-only` adds kernel enforcement on Linux/macOS only. Plan mode is never the barrier.

## Bridge CLI surface (reference)

Direct invocations of `node …/grok-bridge.mjs` (slash commands shell these):

```text
check    [--json]
review   [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
         [--model <model>] [--effort <low|medium|high>]
         [--timeout-ms <ms>] [--max-turns <n>] [focus ...]
critique [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
         [--model <model>] [--effort <low|medium|high>]
         [--timeout-ms <ms>] [--max-turns <n>] [focus ...]
run      [--background] [--write] [--thread <name>] [--json-schema <json>]
         [--cwd <path>] [--prompt-file <path>] [--prompts-file <path>]
         [--resume-last|--resume|--fresh (default)]
         [--model <model>] [--effort <low|medium|high>]
         [--timeout-ms <ms>] [--max-turns <n>] [prompt]
import   [--source <claude-jsonl>] [--thread <name>] [--json]
runs     [run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>]
         [--all] [--all-sessions] [--json]
show     [run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]
stop     [run-id] [--json]
threads  [--forget <name>] [--json]
clean    --keep <n> and/or --older-than-ms <ms> [--json]
```

Flag notes:

| Flags | Behaviour |
| --- | --- |
| `--background` + `--wait` (review/critique) | `--wait` wins → foreground |
| `--background` (`run`) | Detached worker; no `--wait` on `run` |
| `--write` | Opt-in mutating `run`; default is read-only barrier |
| `--resume` / `--resume-last` vs `--fresh` | Mutually exclusive |
| `--thread` vs `--resume-last` | Mutually exclusive |
| `--fresh` | Explicit new session; with `--thread`, do not resume that name's stored session |
| `--json-schema` | JSON object string, max 16000 characters |
| `--prompts-file` | NDJSON batch for `run`; not with `--background` / `--prompt-file` / positional prompt |
| `--timeout-ms` | Wall-clock kill for agent runs; also wait deadline for `runs`/`show --wait` |
| `--max-turns` | Forwarded to the Grok CLI |
| `--all` | `runs`: uncapped recent list within current Claude session |
| `--all-sessions` | `runs`: every workspace job across Claude sessions |
| `--thread <name>` | 1–64 chars `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; not `__proto__` / `constructor` / `prototype` |
| `threads` / `clean` | Bridge-only helpers (list/forget named threads; prune terminal job history). `clean` requires `--keep` and/or `--older-than-ms` so it cannot wipe all history by accident. |
| `usage` | Bridge-only spend report: `--days <n>` (default 7), `--include-test-workspaces`, `--json`. See below. |

## Knowing what the runs cost

`usage` aggregates what the Grok CLI reported for each run across every workspace under
the state root, with a per-day table. Spend is summed from `total_cost_usd_ticks`, the
CLI's exact integer form (1 USD = 10^10 ticks) — its own documentation notes that these
reconcile with the server's usage export while the dollar floats cannot. Records written
before ticks were captured fall back to the float. A run the CLI marks
`usage_is_incomplete` is reported separately rather than counted as free, because an
unaccounted run is unmeasured, not cheap. Runs
against the test fixture are excluded. Only runs recorded after this feature landed carry
a cost; older records show tokens only.

It also prints the subscription's weekly usage percentage when it can find one. There is
**no supported endpoint** for that number: the official CLI fetches its own billing config
at session start and logs it, and this reads that local log back. Treat it as a hint, not
a contract — the field names are not public, the log rotates, and the value is only as
fresh as the last CLI session. Every failure path returns nothing at all rather than a
wrong number, and it never gates a run: a stale reading must not be able to stop work.

### Turning dollars into percent, and keeping it true

The ledger measures **spend**. The subscription page shows a **percentage**. Nothing
connects the two, because no endpoint publishes the allowance behind the percentage — so
the exchange rate has to be measured, and re-measured.

The measuring instrument is already in the room. You are running this plugin from a Claude
Code session; that session can read `usage`, and you can read the subscription page. So
hand it over occasionally, in one line:

```text
Subscription page says 68% used. Take a calibration point.
```

The session reads `usage`, divides spend by percent, appends the point to a file, and tells
you whether the ratio moved. That is the whole method. It costs nothing, it needs no API,
and it happens inside work you were doing anyway — which is the only reason it actually
gets done.

**Do it repeatedly, not once.** A provider can change what a percentage point is worth
whenever it likes: a different allowance, a different weighting of input against output
against cache reads, a new plan tier. A ratio measured in July is a statement about July.
A series that stays flat across many points is evidence; a single number is an anecdote,
and it will keep looking correct long after it stopped being so.

Three things make a point worth recording, all learned by getting them wrong:

- **Read it when nothing is running.** An in-flight run has spent money the ledger has not
  seen yet, and the point silently lands low.
- **Use the cumulative quotient, not the step.** Percentages are shown as integers, so a
  single step from 66 to 68 can be anything from just over one point to nearly three. Step
  deltas scatter wildly while the running total converges — the convergence is the signal.
- **Sum every state root.** Runs started outside Claude Code land in the temp fallback, and
  a renamed marketplace creates a new plugin data directory. Reading one root and calling
  it the total is the easiest way to under-measure by a wide margin.

⚠ **The result is a lower bound, and knowingly so.** The ledger reads per-run job files, so
anything it never recorded is invisible: runs whose accounting the CLI marked incomplete
(reported separately), and runs on another machine drawing the same subscription. Retention
also prunes old job files at `MAX_JOBS`, so a long enough window silently loses its own
early history — that one is still open. Treat the figure as "at least this much" and expect
the true rate to sit above it.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Optional override for the `grok` executable (or a `*.mjs` entry run via Node) |
| `GROK_CC_MAX_CONCURRENCY` | Machine-wide Grok agent cap. Default `max(8, 2 × logical CPUs)`. Set `0` to disable the semaphore. |
| `GROK_CC_SLOT_WAIT_MS` | How long to wait for a free slot before starting anyway (default `90000`). |
| `GROK_CC_STDOUT_CAP_BYTES` | Max captured agent stdout (default 32 MiB). Truncation fails the run with `output-truncated`. |
| `GROK_CC_SESSION_ID` | Claude session id (set by SessionStart hook) |
| `GROK_CC_TRANSCRIPT_PATH` | Claude transcript path (set by SessionStart hook) |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root (host) |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; state lives under `.../state`. Different values → independent concurrency pools. |
| `CLAUDE_ENV_FILE` | Host env file for session hooks |
| `CLAUDE_PROJECT_DIR` | Project directory from the host |

State fallback when `CLAUDE_PLUGIN_DATA` is unset: `$TMPDIR/grok-cc-runs-<username>` (username slug from the OS; suffix omitted only if the username cannot be resolved). On Windows, `$TMPDIR` is typically the process temp directory.

## Operations

### Session lifecycle

- **SessionStart** writes `GROK_CC_SESSION_ID`, `GROK_CC_TRANSCRIPT_PATH`, and `CLAUDE_PLUGIN_DATA` into the host env file so later bridge calls share session identity.
- **SessionEnd** cancels every **active** job recorded for that Claude session (including jobs started with `--cwd` in other workspaces during the session): marks them `cancelled` ("Stopped by session end.") and terminates their tracked process trees (`agentPid` / `bridgePid` / legacy pids). It does **not** rewrite or prune the job list — finished and cancelled records stay on disk so `/grok-build:show` and `--all-sessions` still work. Retention is the normal **MAX_JOBS (50)** prune on state writes, plus optional bridge `clean`. Background work does not keep running after the Claude session ends; its history does.

### State layout

Under the resolved state root (`$CLAUDE_PLUGIN_DATA/state` or the temp fallback):

```text
state/
  global-slots/          # machine-wide concurrency semaphore files
  <workspace-slug>-<hash>/
    state.json           # job list for this workspace
    state.json.lock
    named-threads.json   # --thread name → Grok session id
    thread-<name>.lock   # per-thread mutual exclusion
    jobs/
      <job-id>.json      # per-run record + log pointers
      <job-id>.log
```

Workspace directories are named `<basename>-<16-char-sha256-of-canonical-root>`.

### Background lifecycle example

```text
# Start long work (bridge owns the process group)
/grok-build:delegate --background investigate the flake in auth

# List runs for this workspace / session
/grok-build:runs

# See runs from earlier Claude sessions in this workspace
/grok-build:runs --all-sessions

# Poll one run until terminal (or timeout)
/grok-build:runs <run-id> --wait

# Read stored output after completion
/grok-build:show <run-id>

# Cancel early
/grok-build:stop <run-id>
```

Prefer bridge `--background` so stop can kill both the Node worker and the grok child. Claude-only background without bridge `--background` does not give the plugin stable PID ownership.

### Failure modes (operator guide)

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Slot wait messages, then run starts | Concurrency cap full for the wait window | Expected; raise `GROK_CC_MAX_CONCURRENCY`, wait for other agents, or leave default (start-anyway after wait). |
| `thread "…" is already in use` | Another run holds that named thread lock | Wait, use another `--thread` name, or stop the holder. |
| Exit `2` + `failureCode: no-deliverable` | Empty model output after optional read-only nudge | Retry with clearer prompt; do not assume write side effects. |
| Exit `2` + `failureCode: schema-parse` | Schema/critique JSON missing or unusable | Fix schema or prompt; keep schema under 16000 chars. |
| Exit `2` + `failureCode: output-truncated` | Agent stdout exceeded capture cap | Narrow task; inspect partial log; only raise `GROK_CC_STDOUT_CAP_BYTES` if needed. |
| `failureCode: timeout` | `--timeout-ms` wall clock hit | Raise timeout or reduce work; check partial log. |
| `failureCode: cli-error` | Grok CLI non-zero status | Check `grok models`, `GROK_BINARY`, auth; read stderr in the payload. |
| Exit `3` on `runs`/`show --wait` | Wait deadline while still active | Poll again or raise `--timeout-ms`. |
| `/grok-build:runs` empty but you know work ran | Default session filter | Use `--all-sessions` (history is kept after SessionEnd). |
| State lock timeouts | Contended `state.json.lock` or stale holder | Retry; on hard corruption delete the workspace state dir only if you accept losing run history. |
| Result printed but `runs` still shows the job active | State volume full or read-only; the run finished but could not be recorded | Free space, then re-run. The answer is not lost — see below. |
| `[grok-cc] Bridge state file was corrupt…` | `state.json` failed to parse | Nothing to do: it was quarantined and the index was rebuilt from the job files. The quarantined copy is kept next to it. |
| Named-thread registry corrupt | Bad `named-threads.json` | Delete that file to start over (error text says so). |
| Windows "Select an app to open grok" | Binary not resolved / shell spawn | Set `GROK_BINARY` to the real executable; keep `grok` on PATH. |
| Session closed, background agent gone | SessionEnd cancels active runs | Restart the work in a new session; records remain for `--all-sessions` / `show`. |
| `/grok-build:stop` does nothing useful | Run was Claude-background only without bridge `--background` | Always enqueue long work with bridge `--background`. |
| Hooks never fire; `GROK_CC_SESSION_ID` unset | `node` is not on the PATH of the shell that launched Claude Code | The hooks invoke a bare `node` and fail silently when it is missing. Put Node on the persistent user PATH, not just the current shell. |

### When the state volume cannot be written

Everything the bridge remembers lives under the plugin data directory. If that volume
fills up or turns read-only mid-run, the run itself is unaffected — the agent is a
separate process talking to the network — but nothing about it can be recorded. The
bridge is built so that this degrades rather than destroys:

- A finished result is still returned to the caller, with `persisted: false` and the
  reason. You get your answer; only the stored copy is missing.
- No process is killed on the strength of a decision that could not be recorded. A run
  whose progress writes are failing looks stale, and reclaiming it is exactly the wrong
  move, so a failed claim aborts the reclaim.
- `runs`, `stop` and `show --wait` keep listing what they can instead of failing outright.
- A corrupt index is rebuilt from the per-job files rather than throwing.

One case cannot be repaired from inside the bridge: if progress writes fail before the
agent's process id has been recorded **and** the bridge is then hard-killed, nothing on
disk points at the agent, and it keeps running until it finishes on its own. Recording
the id needs a writable volume, so there is no fix at that layer — check for stray `grok`
processes after a crash on a full disk.

### Flag matrix (slash → bridge)

| Slash command | Bridge command | Background | Write | Focus text |
| --- | --- | --- | --- | --- |
| `/grok-build:review` | `review` | `--background` / `--wait` (wait wins) | always read-only barrier | optional trailing words |
| `/grok-build:critique` | `critique` | same | always read-only barrier | optional trailing words |
| `/grok-build:delegate` | `run` via subagent | bridge `--background` for long work | default RO; `--write` opt-in | task text after flags |
| `/grok-build:runs` | `runs` | n/a (`--wait` polls a run id) | n/a | n/a |
| `/grok-build:show` / `stop` | `show` / `stop` | n/a | n/a | n/a |

## Development

```bash
npm test
```

No `npm install` is needed — there are no dependencies.

What a healthy checkout looks like is **`0 fail`, and at most one skip** — which test skips
is platform-dependent: on Linux and macOS the Windows-only `PATHEXT` resolution test, on
Windows the symlink test, but only where the host denies symlink creation (no elevation, no
Developer Mode), so an elevated Windows box skips neither. Those two numbers are the
invariant; the total only ever grows and is not worth comparing against a number written
down here. A second skip is a finding: it means a test opted out on your platform, and the
summary line reports that in the same calm voice as a pass.

Tests use Node's built-in test runner and a fake `grok` binary on `PATH`. Runtime code uses Node stdlib only.

Version: the source of truth is `package.json`; `npm run bump-version <x.y.z>` propagates it to `plugins/grok-build/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and CI runs `npm run check-version`, which fails on drift. No number is written here, because nothing would keep it honest.

## Contributing

Bug fixes with a reproduction are welcome as a pull request. For anything larger — a feature,
a new command, a change to how a barrier works — open an issue first and let's agree the
shape before you write code, so nobody spends an evening on something that gets turned down
for a reason nobody said out loud. [CONTRIBUTING.md](CONTRIBUTING.md) has the full process,
including what the test suite expects and how to run the acceptance gates.

## License

Apache-2.0. See [LICENSE](LICENSE) for the terms and [NOTICE](NOTICE) for the attribution,
the modification notice and the trademarks.

---

| | |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | What differs from the upstream baseline, and why |
| [SECURITY.md](SECURITY.md) | What each mode protects, what it does not, and how to report a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to propose a change and what the suite expects |
| [docs/ADOPTION.md](docs/ADOPTION.md) | Getting Claude Code to actually reach for it |
| [NOTICE](NOTICE) | Attribution, modification notice, trademarks |
| [LICENSE](LICENSE) | Apache-2.0 |

Maintained by Kai Wedekind — [@KaiWedekind](https://x.com/KaiWedekind) on 𝕏.

Bugs go in an [issue](../../issues); the template asks for the job record, which is pruned
after fifty runs in a workspace, so copy it out before it is gone. Security reports go
through the private channel in [SECURITY.md](SECURITY.md), not a public issue. Anything
else — a question, or that it was useful — 𝕏 is fine and probably faster.
