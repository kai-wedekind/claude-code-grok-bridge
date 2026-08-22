# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab) rather than a public issue. That keeps the report private until a fix exists.

⚠ **Set your expectations by the project status in the README**, which says active development is expected to stop. A report may not get a timely answer, or any answer. That is a poor position for a security channel to be in, so it is said plainly rather than left to be discovered: if you find something serious here, assume you may need to act on it yourself — the licence permits a fork, and much of this code is shared with [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc), where a defect inherited from upstream is worth reporting regardless of what happens to this fork.

This is a personal fork maintained alongside other work, so please do not expect a same-day response.

## What this plugin does with your data

**It runs an external CLI.** Every task is handed to the real `grok` binary, which sends it to the Grok service. Prompts, file contents the agent reads, and its output leave your machine. Nothing in this plugin changes that, and no local setting prevents it.

**Prompts and results are written to disk.** Job records, logs, and state live under the plugin data directory. Prompts too long for the command line are written to a temporary file that is deleted after the run. Job logs, state files and those temporary prompt files are created `0600`. On Windows that mode is largely advisory — treat the state directory as readable by anything running as your user.

**Secret-shaped strings are redacted** in job logs and in the progress text stored on job records: `sk-…`, `xai-…`, `Bearer …`, and `KEY=`/`TOKEN=`/`SECRET=` assignments. This is a safety net for accidental leakage into diagnostics, not a guarantee. Do not put credentials in prompts.

**The request and the model's result are stored verbatim, and that is deliberate.** Redaction covers the diagnostic surfaces named above; the run's actual output — `result` and the rendered text on the job record — is written exactly as it came back. It has to be: it is the deliverable you read, and a review of code that discusses key formats would be mangled by a filter that cannot tell a quoted example from a live credential. The request is kept the same way: a background run persists the whole request on its job record, prompt included, and the opening of that prompt becomes the run's summary in the workspace state index. The consequence is worth stating plainly rather than leaving to be discovered: anything the model echoes back, including a secret it was shown, lands on disk unredacted under the plugin data directory — and so does a secret pasted into the prompt, which is the likelier place for one to appear.

**The `grok` CLI child inherits a filtered environment**, not your full one. What passes: a small fixed list of OS variables the process needs to start (`PATH`, `PATHEXT`, `SystemRoot`, the temp directories, locale), plus anything beginning `GROK_` or `XAI_` — the credentials the CLI itself needs. Nothing else reaches it — in particular not other vendors' API keys, which a process talking to Grok has no use for. This allowlist is the fork's own; upstream has none, so do not assume this behaviour of the original plugin.

The filter covers the process that talks to somebody else's service, and only that one. The OS helpers the bridge runs to look at processes (`tasklist`, `ps`, `taskkill`) and its own detached run-worker are handed the full environment: they are local utilities and this program re-executing itself, not third parties.

`NODE_OPTIONS` and `NODE_PATH` are also deliberately **not** forwarded. They are the two best-known ways to make a Node process load code nobody asked for — `--require` runs a file before anything else, and `NODE_PATH` redirects bare module resolution — and the CLI does not need either. The parent environment belongs to the user, so this is not a remote attack path; it is one step fewer for anyone who already has that environment, which is what a filter is for.

## The CLI can send more than the task, and that is its setting to change, not this plugin's

Everything above is about what the *bridge* does. The `grok` CLI has a second channel of its own, separate from inference, and it is worth knowing about because nothing here touches it: telemetry and a per-turn trace-upload pipeline. This plugin sends no telemetry and uploads no content of its own — it runs the CLI you already have, under your own account — so what follows is a property of that CLI, and the knobs belong to it.

⚠ **One exception, and it is the only outbound request this plugin makes by itself: the update check.** Until 0.3.3 the sentence above read "uploads nothing on its own", and that became false the moment the check existed, so it is stated here rather than left for someone to discover.

- **What is sent:** one unauthenticated `GET` to the public GitHub endpoint `repos/kai-wedekind/claude-code-grok-bridge/releases/latest`. No body, no token, no identifier, no telemetry. GitHub necessarily sees your IP and a `grok-build/<version>` user-agent, which is the version you are running.
- **When:** at **SessionEnd** only — at most once every six hours after a successful check, and after a failure on a backoff that starts at one hour and doubles to a ceiling of one day. (An earlier version of this line said "six hours" flat, which was false on the failure path.) Never if the session's own cleanup already used most of its budget. Never at SessionStart — that hook has a five second budget and it is the one whose 0.3.2 defect this whole feature exists to warn people about. SessionStart only reads a small cached file.
- **What it does with the answer:** writes `<state root>/update-check.json` and, on the next session start, may print one line telling you a newer version exists. **It never downloads or installs anything.**
- **Turning it off:** `GROK_CC_UPDATE_CHECK=0` (also `off`, `false`, `no`). It is read from the hook's own environment, so it is not the inert kind of switch described under [Environment variables the child does not inherit](#environment-variables-the-child-does-not-inherit) — set it however you set variables for Claude Code and no request is made.
- **If the check fails or has never run, the plugin says nothing.** It will not tell you that you are up to date, because it does not know.

Verified against the CLI installed here, which carries its own documentation inside the binary:

| What | How to turn it off |
|---|---|
| Coding data sharing | `grok`, then `/privacy` |
| Telemetry | `GROK_TELEMETRY_ENABLED=0`, or `[features] telemetry` in `config.toml` |
| Per-turn trace upload | `GROK_TELEMETRY_TRACE_UPLOAD=0`, or `[telemetry] trace_upload` |
| Product analytics (Mixpanel) | `GROK_TELEMETRY_MIXPANEL_ENABLED=0` |
| Feedback collection | `GROK_FEEDBACK_ENABLED=0` |

Every name above appears in the CLI's own environment-variable reference, which is embedded in the binary. That matters because of what is *not* in the table, below.

Three honest limits. First, these are the CLI's own knobs and the CLI is xAI's software: what each one covers, whether any of it is additionally gated server-side, and how long anything is retained are theirs to define and change — check their current terms rather than trusting a list written here. Second, the bridge forwards `GROK_*` and `XAI_*` to the child (see above), so setting these in the environment does reach the CLI when the bridge launches it — but a setting you make only in your shell will not follow a run started from somewhere else. Put them where they will be there every time.

Third, and the reason this section is shorter than it was: **there is a widely-repeated `DISABLE_ERROR_REPORTING=1` switch, and this table used to list it. Setting it for a bridge-launched run does nothing.** The name matches neither the `GROK_`/`XAI_` prefixes nor the exact allowlist, so the env filter strips it before the CLI is spawned — a control that looks applied and is not, which is worse than a gap. It is also absent from the CLI's own documented variable list; the string exists in the binary next to a `GROK_ERROR_REPORTING` spelling that *would* survive the filter, but neither is documented and we have not verified what either one does, so we are not going to tell you to set them. If you want that channel off, take it up with the CLI directly rather than through this bridge.

Credit where it is due: this exposure was pointed out to us by [tylersue/claude-grok-delegation](https://github.com/tylersue/claude-grok-delegation), which documents it in its own security notes. We verified the knobs against the installed CLI before writing them down here rather than repeating them on trust — and you should treat this table the same way.

## Stopping a run checks what it is about to signal

`stop` and `SessionEnd` terminate processes by pid, and those pids come off a job record that may be days old. Operating systems reissue pids, so the number alone is not an identity. ⚠ **Reclaim used to be a third path here and no longer signals anything** — that changed in 0.3.3 and this sentence had not caught up. An abandoned-but-alive run is delisted, its spend marked incomplete rather than zero, and its kill targets kept on the record so an explicit `stop` can still end it; nothing is killed automatically, precisely because fifteen minutes is ample time for a pid to have been reissued to another agent carrying the same image.

Every record therefore stores the image name of what it started — `bridgeImage` for the bridge process, `agentImage` for the Grok agent — and every kill probes the target and compares before signalling. A mismatch is reported as `image-mismatch` and nothing is terminated.

A record that carries a pid and no name gets a weaker check rather than none: the target must at least be one of the two things a run can start — this interpreter, or the configured `grok` binary (`GROK_BINARY` is honoured). Anything else is refused.

A probe that cannot read the image at all still allows the kill. That is about platforms where the process table is unreadable, not about records that never said.

## Repository content is not trusted input

`review`, `critique` and `run` put repository content into the prompt: the diff, and the contents of untracked files up to 24 KiB each. That content is written by whoever wrote the repository, and a language model does not reliably distinguish "text I was asked to review" from "instruction addressed to me".

The practical rule follows from that, and it is the one thing worth knowing before pointing this at code you did not write:

- **Do not pass `--write` on a repository you do not trust.** In write mode the agent has `Bash`, `Write` and `Edit` in that working directory. A file in the repository that tells it what to do is an input it may act on.
- Read-only mode is a real defence **against the agent writing**: the writing tools are removed rather than merely discouraged. Its scope is the agent, though, and the agent is not the whole run. Gathering the review context runs `git` inside the target directory *before* the agent is launched, so whatever git is willing to take from a directory it is pointed at is taken while the barrier is not yet in play.

  ⚠ **Several git settings take a command as their value, and git honours the ones a repository carries in its own configuration — and a repository can also simply ship a hook. That is git's design, not a git defect** — a local config is trusted, and there is no "untrusted repository" mode to turn on. Since 0.3.3 every git invocation used for context collection disables hooks outright and neutralises the command-valued settings we identified and measured, enumerating the ones with attacker-chosen names per repository rather than assuming a fixed set.

  🚫 **Read that as defence in depth, and specifically not as a claim that the class is closed. It is not, and we have stopped pretending it can be closed this way.** Five rounds of adversarial testing each found a mechanism the previous round had not named — a converter, a filesystem monitor, a filter, a config include, a hook, a hook directory whose name was the defence itself, a child process spawned to check whether a submodule was dirty. Each was demonstrated with a live control and each was closed. **The pattern did not converge**, and the reason is structural rather than a matter of effort: git treats a repository's own configuration as trusted, offers no untrusted-repository mode, and adds mechanisms over time. Neutralising them one at a time cannot keep a promise that git does not make.

  So the honest statement is: **known mechanisms are closed and gated, unknown ones are assumed to exist.** Two residuals are known and deliberately *not* closed, because neither can be: a filter named by a committed `.gitattributes` but defined in *your own* global configuration runs your program — a clone carries attributes, so cloning does not help — and configuration reachable through scopes we do not enumerate may name another. The hook path is worth singling out, because it needed no configuration entry at all: a script in the default `.git/hooks` directory was enough, which is why sweeping config keys never found it.

  **Cloning helps and does not finish the job.** A `git clone` does not bring the remote's local configuration, so it removes the case where the repository carries its own command strings — and a directory obtained as an archive, a copied working tree, a shared folder or an rsync does carry them, which is the case worth avoiding. If you have been handed a directory rather than a URL, clone from it before reviewing.

  ⚠ **But a clone does carry `.gitattributes`, and that is enough on its own.** A committed `*.bin filter=lfs` runs the reviewer's *own* `git-lfs` during collection, because the filter is resolved from whatever configuration the reviewing machine already has. The command is then yours rather than the attacker's — but the reviewed tree still decided that a program would run, and which one. Anyone who reviews untrusted code on a machine with globally configured filters should know that; this is the residual we have not closed, and "clone it first" does not reach it.
- **It is not a defence of confidentiality, and the difference matters here.** No *reading* tool is removed — that is what the mode is for. So instructions planted in a repository can still ask the agent to pull other files from the working directory into its prompt and to restate their contents in the review, and both of those leave your machine. Reviewing a hostile repository read-only protects what you keep; it does not protect what you show. Point `--cwd` at the repository under review and nothing wider, and read the result before you trust it.
- Files ignored by git are excluded (`--exclude-standard`), so the usual `.env` does not travel. Symlinks are detected with `lstat` and named without being opened — reading them would follow the link out of the repository, which is exactly the defect this fork inherited and fixed (upstream `xai-org/grok-build-plugin-cc` issue #4, opened 2026-07-16 and still open there when last checked 2026-08-01).

There is no sanitisation of repository content, and none is claimed. Treat the read-only barrier as the boundary.

## Fetched content is not trusted input either

The section above is about the repository, because that is the case this fork was built around. It is not the only content that reaches the model, and the same non-claim covers the rest of it.

Read-only removes fourteen tools — the shell, the file editor, the two MCP meta-tools, `write`, `monitor`, the four media generators (each of which puts a file on disk), `web_fetch`, and all three scheduler tools, whose entries would outlive the run — and denies `Bash`, `Write`, `Edit` and `MCPTool`. Several of those *can* reach the network, and removing them closes those paths along with the write paths. What it does not close is the one deliberately left open. **So read-only is a write barrier that shuts most outbound doors as a side effect — not a network barrier that shuts them all**, and the door left open is the whole of your exposure here.

`web_search` is deliberately kept, and that is a decision rather than an oversight: this fork carries research offloads as well as code review, and looking things up is frequently the task. The reasoning sits beside the list where it is defined, and a test pins it so it cannot be dropped by accident.

So, on the same terms as the repository:

- **What the agent fetches is untrusted input.** A search result can carry text addressed to the model as easily as a README can. Nothing delimits it, tags it, or marks it as untrusted — and this bridge could not do so if it wanted to, because it never sees it. Tool results live inside the CLI process; the bridge composes a prompt and reads back a final answer.
- **`--cwd` does not reach this.** It scopes the working directory, which bounds what can be read from disk and therefore what could be restated. It places no constraint on the network path. The advice in the previous section is about the filesystem; do not read it as covering this one.
- **The sandbox does not close it either, on any platform.** The Grok CLI documents that web search, web fetch and the LLM API always have network access, because the agent needs the network to function.

If you want a run that cannot search, the CLI has `--disable-web-search`. This bridge does not pass it today.

Verified for `run`. `review` and `critique` additionally pass `--agent explore`, whose effective toolset is not something we have pinned down; it may be narrower. Treat the above as the conservative case rather than assuming the narrower one.

## The read-only barrier

`run` is read-only unless `--write` is passed. The barrier is enforced by removing the writing tools from the agent (`--disallowed-tools`) and adding deny rules for `Bash`, `Write`, `Edit` and `MCPTool`.

`--sandbox read-only` is passed as well, but **it is not the barrier this fork relies on**: xAI documents enforcement through Landlock (Linux) and Seatbelt (macOS) and names no Windows mechanism. **Measured 2026-08-08 against `grok 1.0.0 (3cd0d0cbce)`:** a direct `grok -p "<create a file>" --sandbox read-only --cwd <empty dir>`, with no plugin involved, exited `0` and the file was there afterwards. On Windows the flag is accepted and the write still lands. We do not rely on it anywhere.

⚠ **And the CLI does not say so.** In that run stderr was empty — no warning, no note, nothing that distinguishes an enforced sandbox from an ignored one. The line reading `Sandbox not enforced on this platform (win32)` is emitted by **this bridge** (`describeConfinement` in `grok-bridge.mjs`), not by the CLI. An earlier version of this document credited it to xAI, which was wrong: we were citing our own output as evidence of the vendor's behaviour.

⚠ **And "Linux" is not the right unit.** Landlock is a kernel configuration option, not a property of the platform. **Measured 2026-08-09 on Raspberry Pi OS (`6.12.96+rpt-rpi-2712`, aarch64):** `/boot/config-$(uname -r)` carries `# CONFIG_SECURITY_LANDLOCK is not set`, and `/sys/kernel/security/lsm` lists only `capability`. On such a kernel the CLI has nothing to enforce with, and it behaves exactly as it does on Windows — flag accepted, exit `0`, stderr empty. So the silence described above is not a Windows quirk but the general case wherever the mechanism is absent, and nothing at runtime distinguishes an enforced sandbox from one that could not be applied. Enforcement holds *where the kernel provides Landlock*, which a mainstream first-party distribution image does not.

⚠ **On that kernel the write landed, and the CLI still said nothing** — the same outcome as Windows, for the same reason: asked for a control it had no way to apply, it applied nothing and reported nothing. `scripts/acceptance.sh` step 2b originally encoded its expectation as a *platform*, so it read that landed write as a failure of xAI's code, which no code of theirs could have prevented. It now resolves the mechanism in three states — present, absent, unknown — and skips rather than judging when it cannot tell.

⚠ **The first version of the paragraph above said the write had *not* landed. It had.** The acceptance script printed the variable answering "did the sandbox hold" behind the label "write landed", and that inverted reading was copied into this document before the label was fixed. It is left recorded rather than quietly amended, because a security document that silently changes what it measured is worth less than one that shows where its own reading went wrong.

Note the narrower claim — "not enforced" rather than "does nothing": xAI documents effects that follow from merely *requesting* a profile, so calling the flag inert would still be an overstatement, and in a security document an overstatement in the comfortable direction is the wrong one to make. The barrier sits at the tool layer because that is the layer that holds on every platform — and, since the measurement above, because the sandbox has been observed not holding on this one.

The barrier is applied on every launch path: foreground, background worker, the automatic retry, and review/critique. Each of those is pinned by a test that asserts the argv this bridge builds.

⚠ **What that does NOT cover, said plainly because an earlier version of this sentence claimed it did:** whether a subagent *Grok itself* spawns inherits the removal list is a property of the CLI, not of the argv we hand it, and nothing here pins it. This document previously said "delegating to a sub-agent does not escape it; that was tested rather than assumed" — the tests behind that assert our argv on every launch path, which is a different statement. Treat the `explore` path as the conservative case (see the note above on its effective toolset) rather than assuming the narrow one.
