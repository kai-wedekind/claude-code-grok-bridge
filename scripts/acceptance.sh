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
head() { printf '\n== %s ==\n' "$1"; }

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

head "1. Unit suite"
if (cd "$REPO_DIR" && npm test >"$SB/unit.log" 2>&1); then
  # Node picks its test reporter by version and TTY: up to Node 22 that is TAP
  # ("# pass 290"), from Node 24 the spec reporter ("ℹ pass 290"). The old expression knew
  # only the first form, so on Node 24 this line read "PASS npm test:" with no number at
  # all — passed, but silent about WHAT passed. Read both forms.
  COUNT="$(grep -E '(^#|ℹ) pass [0-9]+' "$SB/unit.log" | grep -oE 'pass [0-9]+' | tail -1)"
  ok "npm test: ${COUNT:-count unreadable}"
else
  bad "npm test ($(grep -E '^# fail' "$SB/unit.log" | tr -d '#' | xargs))"
fi

head "2. Write barrier (read-only must not write)"
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

head "3. Write mode still works"
mkdir -p "$SB/w"
node "$BRIDGE" run --json --write --cwd "$SBW/w" "Create ok.txt containing WRITE-OK. Then confirm." >"$SB/write.json" 2>/dev/null
if [ -f "$SB/w/ok.txt" ]; then ok "file created in write mode"; else bad "write mode created no file"; fi

head "4. An ordinary run delivers and reports honestly"
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

head "5. Structured output (--json-schema)"
node "$BRIDGE" run --json --cwd "$SBW" --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' \
  "Reply as JSON with answer set to OK." >"$SB/schema.json" 2>/dev/null
if grep -q '"structured"' "$SB/schema.json" && grep -q '"answer"' "$SB/schema.json"; then ok "structured carries the schema object"; else bad "no structured result"; fi

head "6. A named thread keeps context across processes"
node "$BRIDGE" run --json --cwd "$SBW" --thread accept "Remember the codeword FALKE-3. Confirm briefly." >/dev/null 2>&1
node "$BRIDGE" run --json --cwd "$SBW" --thread accept "Name only the codeword." >"$SB/thread.json" 2>/dev/null
if grep -q "FALKE-3" "$SB/thread.json"; then ok "codeword remembered"; else bad "thread continuity broken"; fi

head "7. Concurrency (6 at once, all deliver)"
for i in 1 2 3 4 5 6; do mkdir -p "$SB/p$i"; echo "PAR-$i" > "$SB/p$i/f.txt"; done
for i in 1 2 3 4 5 6; do
  ( node "$BRIDGE" run --json --cwd "$SBW/p$i" "Read f.txt and reply with exactly its first line." >"$SB/par$i.json" 2>/dev/null
    grep -c "PAR-$i" "$SB/par$i.json" > "$SB/par$i.hit" ) &
done
wait
HITS=$(cat "$SB"/par*.hit 2>/dev/null | grep -c '^1$')
if [ "$HITS" = "6" ]; then ok "6/6 correct"; else bad "only $HITS/6 correct"; fi

head "8. Crash recovery (an orphaned slot is reclaimed)"
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
if command -v powershell >/dev/null 2>&1; then
  PLATFORM=windows
elif command -v pgrep >/dev/null 2>&1 && command -v pkill >/dev/null 2>&1; then
  PLATFORM=posix
else
  PLATFORM=unknown
fi

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

head "9. No orphaned resources"
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

head "10. The docs name no abolished mechanisms"
if grep -rq -- "--permission-mode plan" "$REPO_DIR/README.md" "$REPO_DIR/plugins/grok-build/commands/" 2>/dev/null; then
  bad "the docs still mention plan mode"
else ok "no plan-mode reference in the docs"; fi

printf '\n== RESULT: %d passed, %d failed ==\n' "$PASS" "$FAIL"
rm -rf "$SB" 2>/dev/null
[ "$FAIL" -eq 0 ]
