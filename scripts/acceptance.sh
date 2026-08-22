#!/usr/bin/env bash
# Acceptance suite for the bridge fork. It checks the SHIPPED behaviour, not just the unit
# tests: what is green here has been verified against the real Grok CLI.
#
#   bash scripts/acceptance.sh            # against the deployed plugin cache
#   BRIDGE=/path/to/grok-bridge.mjs bash scripts/acceptance.sh
#
# Exit 0 = every criterion met.

set -u
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Which bridge is under test? Deliberately the INSTALLED build rather than the working
# copy — acceptance runs against what Claude actually loads.
#
# Until 2026-07-28 this path was hardwired to a single user profile: on any other machine
# the acceptance gate pointed at nothing and still reported nothing unusual. Now it is
# derived from $HOME, with a clear error instead of a silent misdirection.
if [ -z "${BRIDGE:-}" ]; then
  for candidate in \
    "$HOME/.claude/plugins/cache"/*/grok-build/*/scripts/grok-bridge.mjs \
    "$REPO_DIR/plugins/grok-build/scripts/grok-bridge.mjs"; do
    [ -f "$candidate" ] && BRIDGE="$candidate" && break
  done
fi
if [ -z "${BRIDGE:-}" ] || [ ! -f "$BRIDGE" ]; then
  echo "Bridge not found. Set BRIDGE=/path/to/grok-bridge.mjs." >&2
  echo "Looked under: \$HOME/.claude/plugins/cache/*/grok-build/*/scripts/" >&2
  exit 1
fi
# ⚠ SAY WHICH BUILD IS UNDER TEST, AND FAIL IF IT IS NOT THIS ONE.
#
# The default target is the INSTALLED plugin, deliberately — acceptance is meant to check what
# Claude actually loads. But the installed build goes stale the moment you edit the tree, and
# then steps 2 onward gate a version that has nothing to do with the release. Measured
# 2026-08-09: a full green run, 13 passed 0 failed, against an installed 0.3.0 while the tree
# was 0.3.3 — its read-only removal list carried FOUR ids where the tree carries fourteen. Only
# step 1 (the unit suite, which runs in the repo) touched the new code. Nothing in the output
# said so; the line naming the id count was the only hint, and it reads as information rather
# than as a warning.
#
# This FAILS rather than warns. A gate that prints a concern without moving the counter is the
# defect an audit raised against this very file the same day: the operator reads
# "RESULT: N passed, 0 failed" plus exit 0 and concludes the release criteria are met.
# Redeploy (scripts/deploy-local.sh) or point BRIDGE at the tree on purpose.
BRIDGE_VERSION="$(node -e '
const fs = require("fs"), path = require("path");
const dir = path.dirname(path.dirname(process.argv[1]));
for (const p of [path.join(dir, ".claude-plugin", "plugin.json"), path.join(dir, "plugin.json")]) {
  try { process.stdout.write(String(JSON.parse(fs.readFileSync(p, "utf8")).version ?? "")); process.exit(0); } catch {}
}
process.stdout.write("unknown");
' "$BRIDGE" 2>/dev/null || echo unknown)"
REPO_VERSION="$(node -e '
const fs = require("fs");
try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version ?? "unknown")); }
catch { process.stdout.write("unknown"); }
' "$REPO_DIR/plugins/grok-build/.claude-plugin/plugin.json" 2>/dev/null || echo unknown)"
printf '  Bridge under test: %s\n  Version: %s (this working tree: %s)\n' "$BRIDGE" "$BRIDGE_VERSION" "$REPO_VERSION"

SB="$(mktemp -d)"
SBW="$(cygpath -w "$SB" 2>/dev/null || echo "$SB")"
PASS=0
FAIL=0

# The state root MUST be pinned before TEMP is redirected.
#
# With CLAUDE_PLUGIN_DATA unset the bridge derives its state root from os.tmpdir().
# The lines below redirect TEMP into a directory under $SB — and the last line of this
# file deletes $SB. This suite's ledger therefore landed INSIDE its own scratch directory
# and was deleted with it: real, paid Grok runs that never appeared in any accounting.
# Measured 2026-08-01, because the arithmetic did not add up — the usage percentage kept
# climbing while the ledger barely moved.
#
# A caller who sets the variable keeps it: where the accounting goes is their decision.
# Otherwise we pick a named, persistent place of our own and say so.
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  # The caller decided where the accounting goes. Leave it alone.
  echo "  (this suite bills to \$CLAUDE_PLUGIN_DATA, set by the caller)"
else
  # Unset: the bridge would take os.tmpdir(), which is useless twice over. First, the
  # block below redirects TEMP, so the ledger would land in $SB and die with it. Second,
  # the fallback root is a place that, in state.mjs's own words, "nothing else looks" at —
  # not `runs`, not the ledger, not the session-end reaping.
  #
  # ⚠ Reproducing the fallback path here is NOT possible: CLAUDE_PLUGIN_DATA has "state"
  # appended to it, and the fallback root does not end in that. Setting its dirname — the
  # first attempt — sends the accounting to %TEMP%\state, a THIRD place entirely. That
  # would have moved the leak rather than closed it; measured before it was committed.
  #
  # So: a named, persistent place of our own, and the output says which.
  export CLAUDE_PLUGIN_DATA="${HOME:-$USERPROFILE}/.grok-cc-acceptance-state"
  mkdir -p "$CLAUDE_PLUGIN_DATA"
  echo "  (CLAUDE_PLUGIN_DATA was unset — this suite bills to:"
  echo "   $CLAUDE_PLUGIN_DATA/state)"
  echo "   Set the variable to your usual root if the spend should show up there."
fi

# Prompt hand-over files go to the process temp directory, which is shared with
# every other Grok run on the machine. Give this suite its own, so a leftover file
# is unambiguously ours and a concurrent run elsewhere cannot fail the check.
PRIVATE_TMP="$SB/tmp"
mkdir -p "$PRIVATE_TMP"
export TMPDIR="$PRIVATE_TMP"
export TEMP="$(cygpath -w "$PRIVATE_TMP" 2>/dev/null || echo "$PRIVATE_TMP")"
export TMP="$TEMP"

ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

# Platform, decided once and early. This used to be derived just above the kill/recovery
# block, several hundred lines down, which was fine while that was the only consumer. The
# sandbox control in step 2b needs it too, and an unset PLATFORM there does not fail loudly:
# it falls through to the POSIX branch, expects kernel enforcement, and reports a red on
# Windows where the documented behaviour is the opposite. A false failure in a release gate
# is the same defect as a false pass, one sign flipped.
if command -v powershell >/dev/null 2>&1; then
  PLATFORM=windows
elif command -v pgrep >/dev/null 2>&1 && command -v pkill >/dev/null 2>&1; then
  PLATFORM=posix
else
  PLATFORM=unknown
fi

# Can this kernel enforce a filesystem sandbox at all?
#
# THREE states, never two. "Absent" and "I could not tell" must stay apart: a probe that
# fails to answer looks exactly like a definite no, and turning that into an expectation is
# how a gate reports a finding about somebody else's code that is really a finding about
# its own blind spot. macOS carries Seatbelt as part of the OS, so there it is present by
# construction. On Linux it is Landlock, which is a KERNEL CONFIG OPTION and is off in
# Raspberry Pi OS — measured 2026-08-09 on 6.12.96+rpt-rpi-2712: `CONFIG_SECURITY_LANDLOCK
# is not set`, and /sys/kernel/security/lsm lists `capability` alone.
detect_sandbox_mechanism() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) printf 'present'; return ;;
    Linux) ;;
    *) printf 'unknown'; return ;;
  esac
  # The LSM list is the authoritative runtime answer where it is readable.
  if [ -r /sys/kernel/security/lsm ]; then
    if grep -qi landlock /sys/kernel/security/lsm 2>/dev/null; then
      printf 'present'; return
    fi
    printf 'absent'; return
  fi
  # securityfs is often simply not mounted, which says nothing. Fall back to the build config —
  # but ⚠ THE FALLBACK IS ASYMMETRIC ON PURPOSE, and reading it as symmetric was a defect.
  #
  # The config says what the kernel was BUILT with, not what is ACTIVE. Those differ: a kernel
  # can carry `CONFIG_SECURITY_LANDLOCK=y` and still not have Landlock in its active LSM list,
  # because the `lsm=` boot parameter or a distribution default left it out — and in a
  # container the readable config may belong to the host rather than to the kernel this
  # process actually runs under. So `=y` supports `unknown`, never `present`.
  #
  # `is not set` is different, and it is safe in the direction that matters: what was never
  # built cannot possibly be active, so absence is provable from the config alone.
  #
  # That asymmetry follows from the rule this detector exists to enforce — it must never say
  # `present` when enforcement is unavailable, because that arm ASSERTS enforcement, and a
  # non-write would then read as a held sandbox. Saying `unknown` costs a SKIP; saying
  # `present` wrongly manufactures a green. Found by audit 2026-08-09.
  KCONF="/boot/config-$(uname -r 2>/dev/null)"
  if [ -r "$KCONF" ] && grep -q 'CONFIG_SECURITY_LANDLOCK' "$KCONF" 2>/dev/null &&
     ! grep -q '^CONFIG_SECURITY_LANDLOCK=y' "$KCONF" 2>/dev/null; then
    printf 'absent'; return
  fi
  printf 'unknown'
}
# ⚠ The `present` arm of step 2b asserts enforcement, and no host in this project's fleet can
# reach it: Windows resolves `unknown`, the Pi resolves `absent`, and there is no macOS or
# Landlock-enabled Linux machine here. Left alone it would first execute on a user's machine.
# The override exists to exercise it, and is deliberately named so it cannot be set by
# accident — and it announces itself, because an override that made a gate quieter without
# saying so would be the same class of defect this whole step exists to catch.
if [ -n "${ACCEPTANCE_FORCE_SANDBOX_MECHANISM:-}" ]; then
  SANDBOX_MECHANISM="$ACCEPTANCE_FORCE_SANDBOX_MECHANISM"
  printf '  ⚠ SANDBOX_MECHANISM forced to "%s" — harness exercise, NOT a clean acceptance run\n' "$SANDBOX_MECHANISM"
else
  SANDBOX_MECHANISM="$(detect_sandbox_mechanism)"
fi

# Read one field out of a run's JSON payload. This used to shell out to `python`, which is
# nowhere in this project's requirements: on a machine without it every call returned the
# empty string, and the checks that read a field reported FAIL — indistinguishable from a
# genuine code defect, and pointing the reader at the wrong file. Node is already a hard
# requirement (the thing under test is a Node script), so the dependency is now zero.
field() { node -e '
const fs = require("fs");
let d;
try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch { process.stdout.write("PARSE_ERROR"); process.exit(0); }
const p = ("rawOutput" in d) ? d : (d.payload ?? d);
const v = p[process.argv[2]];
process.stdout.write(v === undefined || v === null ? "null" : String(v));
' "$1" "$2"; }

payload() { node -e '
const fs = require("fs");
let d;
try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch { console.log("PARSE_ERROR"); process.exit(0); }
const p = ("rawOutput" in d) ? d : (d.payload ?? d);
const keys = ["delivered", "failureCode", "nudged", "thread", "structured", "status"];
console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, p[k] ?? null]))));
' "$1"; }

section "0. The build under test is this one"
# Counted, not narrated. Everything below step 1 exercises $BRIDGE; if that is a stale install
# the greens belong to another version, and the summary line will not mention it.
if [ "$BRIDGE_VERSION" = "unknown" ] || [ "$REPO_VERSION" = "unknown" ]; then
  bad "cannot establish which version is under test (bridge=$BRIDGE_VERSION, tree=$REPO_VERSION) — every check below would be unattributable"
elif [ "$BRIDGE_VERSION" != "$REPO_VERSION" ]; then
  bad "acceptance is pointed at $BRIDGE_VERSION but this tree is $REPO_VERSION — redeploy (scripts/deploy-local.sh) or set BRIDGE deliberately; steps 2+ would otherwise gate the wrong build"
else
  ok "bridge under test is $BRIDGE_VERSION, matching this working tree"
fi

section "1. Unit suite"
if (cd "$REPO_DIR" && npm test >"$SB/unit.log" 2>&1); then
  # Node picks its test reporter by version and TTY: up to Node 22 that is TAP
  # ("# pass 290"), from Node 24 the spec reporter ("ℹ pass 290"). The old expression knew
  # only the first form, so on Node 24 this line read "PASS npm test:" with no number at
  # all — passed, but silent about WHAT passed. Read both forms.
  COUNT="$(grep -E '(^#|ℹ) pass [0-9]+' "$SB/unit.log" | grep -oE 'pass [0-9]+' | tail -1)"
  ok "npm test: ${COUNT:-count unreadable}"
else
  # ⚠ NAME THE TESTS, do not just count them. A bare "fail 1" sends the reader to a log that
  # this script deletes on the way out (see the tail), and the suite's timing gates make a
  # red step 1 exactly the kind of failure that will not reproduce on demand. Both halves are
  # needed: the names here, and the scratch directory kept below.
  NAMES="$(grep -E '^(not ok|✖ )' "$SB/unit.log" | head -5 | sed -E 's/^not ok [0-9]+ - //; s/^✖ //' | tr '\n' ';')"
  bad "npm test ($(grep -E '^# fail' "$SB/unit.log" | tr -d '#' | xargs)) — ${NAMES:-no test name found in the log}"
fi

section "2. Write barrier (read-only must not write)"
echo "seed" > "$SB/seed.txt"
node "$BRIDGE" run --json --cwd "$SBW" "Create BARRIER.txt with content X here. Use the write tool or the shell." >"$SB/barrier.json" 2>/dev/null
# Absence of the file is only evidence if the agent actually got as far as trying. A run
# that never reached the tool — nobody signed in, allowance exhausted, binary not spawnable
# — also leaves no BARRIER.txt, and this check certified that as "the write barrier held".
# It is the only end-to-end gate on the property this fork exists for, so it must not be
# satisfiable by doing nothing. The run's own JSON says whether it ran.
BARRIER_FAILURE="$(field "$SB/barrier.json" failureCode)"
if [ -f "$SB/BARRIER.txt" ]; then
  bad "BARRIER.txt was created — the write barrier did NOT hold"
elif [ "$BARRIER_FAILURE" = "PARSE_ERROR" ]; then
  bad "run produced no readable JSON — the barrier was not tested"
elif [ "$BARRIER_FAILURE" != "null" ] && [ "$BARRIER_FAILURE" != "no-deliverable" ]; then
  # no-deliverable is legitimate here: a refused write can end with nothing to say.
  bad "run never reached the tool (failureCode=$BARRIER_FAILURE) — the barrier was not tested"
else
  ok "no file created, and the run genuinely made the attempt"
fi

section "2b. Control: does the CLI's own sandbox hold, unmediated?"
# Check 2 proves OUR barrier holds. It says nothing about whether the CLI's --sandbox
# read-only holds, because our barrier removes the tools before the sandbox is ever the
# deciding layer. That distinction is load-bearing: SECURITY.md and the README both tell
# readers why confinement sits at the tool layer, and until 2026-08-08 that reasoning
# rested on xAI's documentation rather than on a measurement here.
#
# So measure it, on every platform, every run. No plugin involved — the real binary, the
# flag on the command line, an empty directory.
#
# ⚠ The EXPECTATION IS PLATFORM-DEPENDENT, and that is the point. On Linux and macOS xAI
# documents kernel enforcement (Landlock, Seatbelt) and the write should be refused. On
# Windows they name no mechanism, and on 2026-08-08 the write landed with exit 0 and an
# empty stderr. Encoding both expectations turns a frozen claim in a security document
# into a standing check: if xAI ever ships Windows enforcement, this fails and tells us
# our documentation is now out of date, which is the only way that sentence gets revisited.
mkdir -p "$SB/sbx"
GROK_BIN="${GROK_BINARY:-grok}"
"$GROK_BIN" -p "Create sandbox-canary.txt in the current working directory containing the single word FIRED. Then read it back." \
  --sandbox read-only --cwd "$SBW/sbx" >"$SB/sbx.out" 2>"$SB/sbx.err"
SBX_EXIT=$?
SBX_ERR_BYTES=$(wc -c < "$SB/sbx.err" | tr -d ' ')
SBX_OUT_BYTES=$(wc -c < "$SB/sbx.out" | tr -d ' ')
# ⚠ TWO NAMES, DELIBERATELY. `SBX_HELD` answers "did the sandbox hold" and `SBX_WROTE` answers
# "did the canary appear" — the same observation with opposite polarity. They existed as one
# variable until 2026-08-09, and three messages printed `SBX_HELD` behind the label
# "write landed", so the Pi run reported `write landed: no` at the exact moment the write had
# landed. A double negative in a security gate's own output is how a correct measurement
# becomes a wrong conclusion downstream, and this one did: it was read back into SECURITY.md
# before the inversion was caught. Label each value with the question it answers.
if [ -f "$SB/sbx/sandbox-canary.txt" ]; then
  SBX_HELD="no"
  SBX_WROTE="yes"
else
  SBX_HELD="yes"
  SBX_WROTE="no"
fi

# ⚠ ABSENCE OF THE CANARY IS ONLY EVIDENCE IF THE RUN HAPPENED. A missing binary, a signed
# out session, an exhausted allowance — every one of those also leaves no canary, and would
# be reported below as "the sandbox held". That is precisely the defect step 2 above was
# fixed for, and this step reproduced it on the first attempt: the shape is that easy to
# write. A run that never reached the tool must read as UNTESTED, never as protected.
#
# The cheap proof that it ran is that it said something. A refusal still produces output —
# the agent explains what it could not do — so empty stdout together with a non-zero exit
# means the process did not get as far as trying.
if [ "$SBX_EXIT" -ne 0 ] && [ "$SBX_OUT_BYTES" -eq 0 ]; then
  bad "CLI sandbox control did not run (exit $SBX_EXIT, no output) — the sandbox was NOT tested"
  SBX_HELD="untested"
  SBX_WROTE="unknown"
fi

# "untested" must not reach the verdicts below. It already reported its own failure, and
# every branch there would restate it as a finding about the sandbox — on Windows literally
# as "the sandbox DID hold", which is the opposite of what is known. One unknown must not
# become two wrong answers.
case "$(if [ "$SBX_HELD" = "untested" ]; then echo skip; else echo "$PLATFORM"; fi)" in
  windows)
    if [ "$SBX_HELD" = "no" ]; then
      ok "CLI sandbox does NOT hold on Windows (write landed, exit $SBX_EXIT, stderr ${SBX_ERR_BYTES}B) — as documented"
    else
      bad "CLI sandbox DID hold on Windows — SECURITY.md and README now overstate the gap; update them"
    fi
    ;;
  posix)
    # ⚠ THE EXPECTATION IS THE KERNEL'S, NOT THE PLATFORM'S. "POSIX means enforced" is false:
    # Landlock is a kernel config option, and Raspberry Pi OS ships with it OFF —
    # `CONFIG_SECURITY_LANDLOCK is not set`, LSM list `capability` alone, measured on
    # 6.12.96+rpt-rpi-2712 on 2026-08-09. The CLI then cannot enforce anything, the write
    # lands, and this step reported a red against xAI for something no code of theirs could
    # have prevented. A release gate that fails for a reason the release cannot fix gets
    # ignored, which is the worst outcome for a security check.
    case "$SANDBOX_MECHANISM" in
      present)
        if [ "$SBX_HELD" = "yes" ]; then
          ok "CLI sandbox holds here (no file created, exit $SBX_EXIT) — kernel enforcement as documented"
        else
          bad "CLI sandbox did NOT hold although the kernel offers Landlock — investigate before shipping"
        fi
        ;;
      absent)
        # Not a pass and not a failure of the CLI. But it IS a finding, and it belongs in the
        # log rather than in nobody's head: asked for a security control it could not apply,
        # the CLI said nothing at all. Silent degradation of confinement is the same shape as
        # the Windows case, and it means "enforced on Linux" is too strong a claim for our
        # own documentation.
        printf '  SKIP  CLI sandbox cannot be tested here: this kernel has no Landlock (write landed: %s, exit %s, stderr %sB). ⚠ The CLI did not warn that confinement was unavailable.
' "$SBX_WROTE" "$SBX_EXIT" "$SBX_ERR_BYTES"
        ;;
      *)
        printf '  SKIP  CLI sandbox: could not determine whether this kernel offers Landlock — no expectation checked (write landed: %s)
' "$SBX_WROTE"
        ;;
    esac
    ;;
  *)
    # Neither probe answered, so there is no expectation to check against. Report the
    # observation and count it as neither pass nor fail: inventing an expectation here
    # would be guessing, and a guess in a release gate is worse than a gap.
    printf '  SKIP  CLI sandbox control: platform undetermined (write landed: %s, exit %s)\n' "$SBX_WROTE" "$SBX_EXIT"
    ;;
esac

section "2c. Control: the CLI still starts a session with our removal list"
# WHY THIS IS SEPARATE FROM STEP 4. Step 4 runs a read-only job and goes red here too — but it
# reports `delivered: false`, which reads as "the model did not answer" and sends the reader to
# the delivery gate. The actual cause can be that the session never started, and the two want
# completely different fixes.
#
# The failure is real and was shipped: on 2026-08-08 the list carried `scheduler_create` and
# `scheduler_delete` without `scheduler_list`. The CLI's tools declare requirements on one
# another, so that combination made EVERY read-only run die at init with
#   Requirements unsatisfied: [RequirementError { tool: "GrokBuild:scheduler_list", ... }]
# The unit suite passed throughout — it runs against the fake grok, which has no requirement
# graph to violate. Only the real binary can answer this, so it is asked here, once per run.
#
# ⚠ The list is READ OUT OF THE MODULE, never restated. A copy here would drift, and then the
# copy is what gets verified: a green light for a list that nothing ships.
#
# ⚠ The path travels in the ENVIRONMENT, not in argv. The bridge refuses to run when it is
# invoked as a script under another name (its own guard against being launched through a
# symlink), and `node -e <code> <path>` puts that path in argv[1] — which trips the guard, and
# the module prints a refusal and exits non-zero while still importing cleanly. It would have
# "worked" here purely because stderr was suppressed and $( ) reads stdout. Out of argv, argv[1]
# is undefined and the guard correctly stays quiet.
TOOL_LIST="$(GROK_CC_BRIDGE_URL="file:///$(cygpath -m "$BRIDGE" 2>/dev/null || echo "$BRIDGE")" node -e '
import(process.env.GROK_CC_BRIDGE_URL).then((m) => process.stdout.write(m.READ_ONLY_DISALLOWED_TOOLS.join(",")))
' 2>/dev/null)"
mkdir -p "$SB/init"
if [ -z "$TOOL_LIST" ]; then
  bad "could not read READ_ONLY_DISALLOWED_TOOLS from the bridge — session init NOT tested"
else
  # ⚠ The flags production actually uses, not a subset. The requirement graph is a property of
  # the WHOLE flag set — that is the argument verifyDisallowedToolIds makes about its own probe —
  # so a 2c that omits --no-plan and the deny rules can pass a list that only dies under a real
  # run. Read the deny rules out of the module for the same reason as the tool list: a copy here
  # would be what gets verified. (Audit, 2026-08-08.)
  DENY_ARGS=""
  DENY_LIST="$(GROK_CC_BRIDGE_URL="file:///$(cygpath -m "$BRIDGE" 2>/dev/null || echo "$BRIDGE")" node -e '
import(process.env.GROK_CC_BRIDGE_URL).then((m) => process.stdout.write(m.READ_ONLY_DENY_RULES.join(",")))
' 2>/dev/null)"
  if [ -n "$DENY_LIST" ]; then
    OLD_IFS="$IFS"; IFS=','
    for rule in $DENY_LIST; do DENY_ARGS="$DENY_ARGS --deny $rule"; done
    IFS="$OLD_IFS"
  fi
  # shellcheck disable=SC2086
  "$GROK_BIN" -p "Reply with the single word OK." --no-plan --sandbox read-only \
    --disallowed-tools "$TOOL_LIST" $DENY_ARGS --cwd "$SBW/init" >"$SB/init.out" 2>"$SB/init.err"
  INIT_EXIT=$?
  # printf '%s' leaves no trailing newline, so `wc -l` counts one short — it reported "13" for
  # a 14-id list on the first run. A gate that miscounts what it checked is a small lie in the
  # one place that exists to be believed.
  INIT_COUNT="$(printf '%s\n' "$TOOL_LIST" | tr ',' '\n' | wc -l | tr -d ' ')"
  if [ "$INIT_EXIT" -eq 0 ]; then
    # ⚠ Says exactly what exit 0 proves and no more. It proves the session STARTS with the list
    # applied. It does not prove the ids are real — an id the CLI does not recognise is inert
    # and starts a session perfectly happily, which is precisely why `check --verify-tools`
    # exists as a separate question. An earlier wording here read "with all N removed ids",
    # which invited the stronger reading.
    ok "CLI starts a session with the $INIT_COUNT-id removal list applied (does not prove the ids are real — that is check --verify-tools)"
  elif grep -qi 'requirements unsatisfied\|session initialization failed\|could.t create session' "$SB/init.err" "$SB/init.out"; then
    # ⚠ BOTH STREAMS. This grepped stderr alone, so a CLI that put the requirement error on
    # stdout — or reworded it — fell through to SKIP, and a SKIP does not increment FAIL, so the
    # whole suite could exit 0 over a removal list that kills every read-only run. That is the
    # same defect this step exists to catch, one stream over. verifyDisallowedToolIds already
    # reads `stderr || stdout` for exactly this reason; acceptance knew less than the check it
    # complements. (Audit, 2026-08-08.)
    DEP="$(grep -ohE 'tool: \\?"[^\\"]+' "$SB/init.err" "$SB/init.out" | head -1 | sed 's/.*"//')"
    bad "removal list breaks session init — the CLI wants ${DEP:-a dependent tool} removed too; EVERY read-only run is dead"
  else
    # Auth, allowance, a missing binary: all leave a non-zero exit and none of them is a
    # statement about the list. An unknown must not become a finding in either direction.
    printf '  SKIP  session-init control did not run (exit %s): %s\n' \
      "$INIT_EXIT" "$(head -c 120 "$SB/init.err" | tr '\n' ' ')"
  fi
fi

section "3. Write mode still works"
mkdir -p "$SB/w"
node "$BRIDGE" run --json --write --cwd "$SBW/w" "Create ok.txt containing WRITE-OK. Then confirm." >"$SB/write.json" 2>/dev/null
if [ -f "$SB/w/ok.txt" ]; then ok "file created in write mode"; else bad "write mode created no file"; fi

section "4. An ordinary run delivers and reports honestly"
node "$BRIDGE" run --json --cwd "$SBW" "Reply with exactly: ACCEPT-OK" >"$SB/plain.json" 2>/dev/null
# Compared field by field rather than by grepping a serialised blob. The old form searched
# for the literal '"delivered": true' — the exact spacing Python's json.dumps happens to
# emit — so it broke the moment the helper changed serialiser, while the payload underneath
# was perfectly correct. A check that depends on how a value was printed is not checking the
# value.
DELIVERED="$(field "$SB/plain.json" delivered)"
FAILCODE="$(field "$SB/plain.json" failureCode)"
if [ "$DELIVERED" = "true" ] && [ "$FAILCODE" = "null" ] && grep -q "ACCEPT-OK" "$SB/plain.json"; then
  ok "delivered=true, failureCode=null, content correct"
else
  bad "unexpected: delivered=$DELIVERED failureCode=$FAILCODE ($(payload "$SB/plain.json"))"
fi

section "5. Structured output (--json-schema)"
node "$BRIDGE" run --json --cwd "$SBW" --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' \
  "Reply as JSON with answer set to OK." >"$SB/schema.json" 2>/dev/null
if grep -q '"structured"' "$SB/schema.json" && grep -q '"answer"' "$SB/schema.json"; then ok "structured carries the schema object"; else bad "no structured result"; fi

section "6. A named thread keeps context across processes"
node "$BRIDGE" run --json --cwd "$SBW" --thread accept "Remember the codeword FALKE-3. Confirm briefly." >/dev/null 2>&1
node "$BRIDGE" run --json --cwd "$SBW" --thread accept "Name only the codeword." >"$SB/thread.json" 2>/dev/null
if grep -q "FALKE-3" "$SB/thread.json"; then ok "codeword remembered"; else bad "thread continuity broken"; fi

section "7. Concurrency (6 at once, all deliver)"
for i in 1 2 3 4 5 6; do mkdir -p "$SB/p$i"; echo "PAR-$i" > "$SB/p$i/f.txt"; done
for i in 1 2 3 4 5 6; do
  ( node "$BRIDGE" run --json --cwd "$SBW/p$i" "Read f.txt and reply with exactly its first line." >"$SB/par$i.json" 2>/dev/null
    grep -c "PAR-$i" "$SB/par$i.json" > "$SB/par$i.hit" ) &
done
wait
HITS=$(cat "$SB"/par*.hit 2>/dev/null | grep -c '^1$')
if [ "$HITS" = "6" ]; then ok "6/6 correct"; else bad "only $HITS/6 correct"; fi

section "8. Crash recovery (an orphaned slot is reclaimed)"
STATE="$CLAUDE_PLUGIN_DATA/state"
# Remember which agents were already running: the cleanup below must only reap the one
# this step orphans on purpose. Killing every grok process would take out whatever else
# the user has in flight — that happened, three times, to concurrent review runs.
#
# All three process handles here used to go through `powershell`, unconditionally. A
# Raspberry Pi has no such thing: the call failed with "command not found", the error went
# to /dev/null, and NOTHING was killed — the orphaned run ended by itself, the next one
# worked, and the step reported green. This block is the only gate on recovery after a hard
# kill, and on POSIX it never tested it. On 2026-07-31 that went into the record as
# "11 of 11". Found 2026-08-01.
# PLATFORM itself is now decided near the top of this file, because step 2b needs it too.

grok_pids_now() {
  case "$PLATFORM" in
    windows) powershell -NoProfile -Command "(Get-Process grok -ErrorAction SilentlyContinue).Id -join ','" 2>/dev/null | tr -d '\r' ;;
    posix)   pgrep -x grok 2>/dev/null | tr '\n' ',' ;;
    *)       echo "" ;;
  esac
}

GROK_PIDS_BEFORE="$(grok_pids_now)"
node "$BRIDGE" run --json --cwd "$SBW" --thread orphanaccept "Describe f.txt in five sentences." >/dev/null 2>&1 &
sleep 6
# Whether a kill PATH exists is not the same question as whether a process was HIT.
# The first version of this block set the flag merely because the platform was known —
# a pattern that matches nothing would then have passed silently again, one floor below
# the powershell mistake above it. Both branches now count hits.
KILL_COUNT=0
case "$PLATFORM" in
  windows)
    KILL_COUNT="$(powershell -NoProfile -Command "\$p = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*grok-bridge.mjs*orphanaccept*' }); \$p | ForEach-Object { taskkill /PID \$_.ProcessId /F 2>&1 | Out-Null }; \$p.Count" 2>/dev/null | tr -d '\r' | tail -1)"
    ;;
  posix)
    # -f because the process is called `node` and only its command line identifies it.
    # pkill returns 0 when at least one process matched and 1 when none did — exactly the
    # answer that was missing here.
    if pkill -f "grok-bridge.mjs.*orphanaccept" >/dev/null 2>&1; then
      KILL_COUNT=1
    fi
    ;;
esac
case "$KILL_COUNT" in
  ''|*[!0-9]*) KILL_COUNT=0 ;;
esac
sleep 2
node "$BRIDGE" run --json --cwd "$SBW" "Reply with exactly: RECOVERED" >"$SB/recover.json" 2>/dev/null
# A kill that never happened must not count as a passed recovery.
if [ "$PLATFORM" = "unknown" ]; then
  bad "no kill path for this platform — recovery was NOT tested"
elif [ "$KILL_COUNT" -lt 1 ]; then
  bad "no process hit ($PLATFORM) — nothing had to survive, so this is not a recovery"
elif grep -q "RECOVERED" "$SB/recover.json"; then
  ok "recovery after a hard kill ($PLATFORM, $KILL_COUNT process(es) killed)"
else
  bad "recovery failed"
fi
case "$PLATFORM" in
  windows)
    powershell -NoProfile -Command "\$before = '$GROK_PIDS_BEFORE' -split ',' | Where-Object { \$_ }; Get-Process grok -ErrorAction SilentlyContinue | Where-Object { \$before -notcontains \"\$(\$_.Id)\" } | ForEach-Object { taskkill /PID \$_.Id /T /F 2>&1 | Out-Null }" >/dev/null 2>&1
    ;;
  posix)
    for pid in $(grok_pids_now | tr ',' ' '); do
      case ",$GROK_PIDS_BEFORE," in
        *",$pid,"*) ;;
        *) kill -9 "$pid" >/dev/null 2>&1 ;;
      esac
    done
    ;;
esac

section "9. No orphaned resources"
# Count only ORPHANED slots: other runs may legitimately hold slots meanwhile.
LEFT=$(node -e "
const fs=require('fs'),dir=process.argv[1];
let stale=0;
try {
  for (const f of fs.readdirSync(dir)) {
    const pid=parseInt(String(fs.readFileSync(dir+'/'+f,'utf8')).split(':')[0],10);
    if (!Number.isFinite(pid)) { stale++; continue; }
    try { process.kill(pid,0); } catch (e) { if (e.code==='ESRCH') stale++; }
  }
} catch {}
console.log(stale);
" "$STATE/global-slots" 2>/dev/null || echo PROBE_FAILED)
TMPP=$(find "$PRIVATE_TMP" -maxdepth 1 -name 'grok-cc-prompt-*.txt' 2>/dev/null | grep -c . || true)
# The fallback used to be `|| echo 0`, which reported a probe that could not run at all as
# a clean result — an unmeasured state presented as a verified one. A failed measurement is
# not a pass; it is the absence of one, and it has to say so.
if [ "$LEFT" = "PROBE_FAILED" ]; then
  bad "the slot check could not run — state UNKNOWN, not clean"
elif [ "$LEFT" = "0" ]; then
  ok "no orphaned slots"
else
  bad "$LEFT orphaned slot files"
fi
if [ "$TMPP" = "0" ]; then ok "no new prompt temp files left behind"; else bad "$TMPP new prompt files left behind"; fi

section "10. The docs name no abolished mechanisms"
if grep -rq -- "--permission-mode plan" "$REPO_DIR/README.md" "$REPO_DIR/plugins/grok-build/commands/" 2>/dev/null; then
  bad "the docs still mention plan mode"
else ok "no plan-mode reference in the docs"; fi

printf '\n== RESULT: %d passed, %d failed ==\n' "$PASS" "$FAIL"
# ⚠ KEEP THE EVIDENCE WHEN SOMETHING FAILED. This deleted the scratch directory
# unconditionally until 2026-08-21 — including `unit.log` and every run's JSON — so a red
# step reported a count and destroyed the only record of what actually went wrong. Measured
# that day: "npm test (fail 1)" with four green suite runs on either side of it and nothing
# left to look at, which turns a real finding into a rumour. A green run still cleans up.
if [ "$FAIL" -eq 0 ]; then
  rm -rf "$SB" 2>/dev/null
else
  printf 'Evidence kept (not deleted because something failed): %s\n' "$SB"
fi
[ "$FAIL" -eq 0 ]
