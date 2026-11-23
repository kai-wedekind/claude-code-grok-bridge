// Per-strand evidence from Grok's own subagent fan-out.
//
// When Grok spawns subagents, the bridge used to keep only what the CLI returns: with
// `--output-format json` that is one `text` field holding the parent's final synthesis.
// Everything each child actually did — its prompt, its tool calls, its full deliverable —
// was dropped on the floor, and we recorded that as "the transcripts interleave and are
// unrecoverable". Measured 2026-08-09 against three real fan-out runs: nothing was ever
// unrecoverable. The CLI writes each child to its own directory, complete and clean:
//
//   <grok home>/sessions/<url-encoded cwd>/<parent session id>/subagents/<child id>/
//     meta.json    - type, description, the full prompt, status, timings, tool_calls, model
//     output.json  - {schema_version, output} with the entire deliverable
//
// So this module reads, it does not reconstruct. There is no stream to demultiplex and no
// second copy to write during the run: nothing here touches the live run path, which is
// why it can be added to a release without risking a paid run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One strand's deliverable, capped. 128 KiB is far above every real strand measured
// (the largest was 18,433 characters) and still bounds a job record if a future run
// returns something enormous. Truncation is announced in the record, never silent.
export const MAX_STRAND_OUTPUT_CHARS = 128 * 1024;

// A parent session can legitimately hold many children; past this, whatever is left is
// reported as dropped rather than silently missing.
export const MAX_STRANDS = 64;

// Refuse to load a single record larger than this. Generous next to the largest real strand
// measured (18,433 characters) and small enough that 64 of them cannot exhaust a process.
// This is the bound that actually protects memory — `MAX_STRAND_OUTPUT_CHARS` bounds only
// what is KEPT, and it is applied after the file has already been read and parsed.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The CLI's config root. `GROK_HOME` overrides it, and the default is `~/.grok` —
 * documented in the CLI's own README under Environment. Resolved rather than hardcoded
 * because a run on the Pi and a run here do not share a home directory.
 */
export function resolveGrokHome(env = process.env) {
  const override = typeof env.GROK_HOME === "string" ? env.GROK_HOME.trim() : "";
  if (override) {
    return override;
  }
  return path.join(os.homedir(), ".grok");
}

/**
 * Locate a parent session directory by its id.
 *
 * The fast path rebuilds the documented layout: sessions are bucketed by URL-encoded
 * working directory. The fallback scans the buckets for a directory with that id.
 *
 * The fallback is not belt-and-braces, it is the actual guarantee. The encoding is
 * upstream's business and can change without telling us, and `cwd` as the bridge recorded
 * it need not be byte-identical to what the CLI encoded (trailing separator, drive-letter
 * case, a symlinked path). A derived path that misses is indistinguishable from a run that
 * spawned no subagents — the failure this module exists to stop being silent about.
 */
export function findSessionDir(sessionId, options = {}) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return null;
  }
  const id = sessionId.trim();
  // A session id becomes a path segment twice below, so it has to be one — `state.mjs`
  // already refuses the same shapes in `assertValidSessionId` for the same reason. Without
  // this, `findSessionDir("..")` normalises to the sessions ROOT and reports it as a
  // session, and a deeper `../..` can leave the tree entirely. The ids we pass come from
  // our own state file today, which is exactly why the check is cheap insurance rather
  // than paranoia: the day one arrives from elsewhere, nothing else here would object.
  if (id.includes("/") || id.includes("\\") || id === "." || id === ".." || path.isAbsolute(id)) {
    return null;
  }
  const home = options.grokHome ?? resolveGrokHome(options.env);
  const root = path.join(home, "sessions");

  if (typeof options.cwd === "string" && options.cwd) {
    // ⚠ `encodeURIComponent` THROWS on a lone UTF-16 surrogate — `URIError: URI malformed` —
    // and this is the fast path, sitting in front of the scan below that would have found the
    // session anyway. Unhandled, one unpaired surrogate in a directory name turned a working
    // lookup into an exception that escaped `collectSubagentEvidence` entirely, and the job
    // then rendered as "no fan-out" rather than as an error. Measured 2026-08-09 with
    // cwd `C:\proj\uD800`. The fast path is an optimisation, so its failure must cost the
    // optimisation and nothing else.
    let guess = null;
    try {
      guess = path.join(root, encodeURIComponent(options.cwd), id);
    } catch {
      guess = null;
    }
    if (guess && isDirectory(guess)) {
      return guess;
    }
  }

  let buckets;
  try {
    // Sorted, because `readdirSync` order is filesystem-dependent. Session ids are UUIDs so
    // a collision across two buckets is not expected — but if one ever happens, an
    // arbitrary winner that changes between runs is far harder to diagnose than a fixed one.
    buckets = fs.readdirSync(root).sort();
  } catch {
    return null;
  }
  for (const bucket of buckets) {
    const candidate = path.join(root, bucket, id);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// ⚠ `isDirectory` uses `statSync`, which FOLLOWS links — so a directory symlink or a Windows
// junction planted under `subagents/` reads as an ordinary child, and its target is loaded and
// rendered as though it were a strand of this run. Child names cannot escape on their own
// (they come from `readdirSync`, so they hold no separators and no `..`), which is exactly why
// a name-based guard is not enough: the escape is the link, not the name. Measured 2026-08-09
// against this module — a junction to a directory outside the session tree returned 28
// characters of foreign content alongside a legitimate strand.
//
// Reaching this needs write access to the user's own `~/.grok`, so it is a containment
// weakness rather than a remote attack. It is still worth closing: this reader exists to say
// what a run's subagents produced, and content from outside the run is not that, whatever put
// it there. Compare the RESOLVED paths — comparing the unresolved ones is what let it through.
// Only to tell "this entry is an ordinary file, ignore it" apart from "this entry could not be
// examined at all". Both make `isDirectory` false, and conflating them is how an unreadable
// strand became invisible.
function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

//
// ⚠ Returns THREE answers, because collapsing them mislabels a fact. A `realpathSync` that
// throws — the entry vanished between `stat` and here, or permission was refused — is "could
// not examine", not "resolves outside the tree". The earlier version caught and returned false,
// so a TOCTOU race was reported to the user as a planted link: fail-closed in the safe
// direction, and wrong about what happened. That is the same conflation this module split
// apart one function above with `isFile`. Found by a code review 2026-08-09.
function containment(parentDir, childDir) {
  let parent;
  let child;
  try {
    parent = fs.realpathSync(parentDir);
    child = fs.realpathSync(childDir);
  } catch {
    return "unexaminable";
  }
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? "inside" : "outside";
}

/** Is this file past the point where reading it is worth the memory? */
function fileTooBig(file, limit = MAX_FILE_BYTES) {
  try {
    return fs.statSync(file).size > limit;
  } catch {
    return false;
  }
}

/**
 * ⚠ Check the SIZE before reading, not after.
 *
 * `MAX_STRAND_OUTPUT_CHARS` bounds what we keep, which is what the job record needs — but the
 * cap was applied to a string that `readFileSync` and `JSON.parse` had already materialised in
 * full, so a huge `output.json` was loaded entirely and then sliced. The record was bounded and
 * the process was not, and the comment claimed otherwise. Audit 2026-08-09.
 */
function readJson(file, limit = MAX_FILE_BYTES) {
  try {
    if (fileTooBig(file, limit)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read every strand under a parent session directory.
 *
 * A child that is present but unreadable is reported with `readError` rather than
 * dropped. Dropping it would restore exactly the condition this replaces: a fan-out that
 * looks like it produced less than it did, with nothing saying so.
 */
export function readSubagentStrands(sessionDir, options = {}) {
  if (typeof sessionDir !== "string" || !sessionDir) {
    return [];
  }
  const dir = path.join(sessionDir, "subagents");
  let children;
  try {
    children = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const cap = Number.isInteger(options.maxOutputChars)
    ? options.maxOutputChars
    : MAX_STRAND_OUTPUT_CHARS;
  const strands = [];

  // Filter FIRST, cap second. Capping the raw listing lets any non-directory entry — a
  // stray lock file, a `.DS_Store`, anything the CLI or a backup tool drops in — spend part
  // of the budget, so real strands past the cut vanish with nothing saying so. That is the
  // under-reporting this module exists to end, reintroduced at the one edge the constant
  // was added to guard.
  // Containment is checked HERE, with the directory filter, so an escaping entry never reaches
  // the read below and never spends a slot against MAX_STRANDS. It is counted rather than
  // silently skipped — an unexplained gap in the strand list is the exact thing this module
  // was written to stop.
  //
  // ⚠ A THIRD CASE HIDES IN THIS FILTER: `isDirectory` returns false when `stat` FAILS, not
  // only when the entry is a file. So a child directory that `readdir` listed but that cannot
  // be stat'ed — a permissions race, a deletion between the two calls — is dropped here with
  // no `readError` and no place in any count, which is precisely the silent under-report this
  // module exists to end and which the comment two blocks down promises never happens.
  // `readdir` already told us the name exists, so its disappearance is worth a line.
  const stated = children.filter((child) => isDirectory(path.join(dir, child)));
  const unstatable = children.filter(
    (child) => !stated.includes(child) && !isFile(path.join(dir, child))
  );
  const realChildren = stated.sort();
  const childDirs = [];
  let escaped = 0;
  let vanished = 0;
  for (const child of realChildren) {
    const verdict = containment(dir, path.join(dir, child));
    if (verdict === "inside") childDirs.push(child);
    else if (verdict === "outside") escaped += 1;
    // "unexaminable" joins the entries that could not be looked at, rather than being reported
    // as a planted link. Both are excluded from the read; only one of them is a finding about
    // somebody putting something there.
    else vanished += 1;
  }
  const dropped = Math.max(0, childDirs.length - MAX_STRANDS);

  for (const child of childDirs.slice(0, MAX_STRANDS)) {
    const childDir = path.join(dir, child);
    const meta = readJson(path.join(childDir, "meta.json"), MAX_FILE_BYTES);
    const outputFile = path.join(childDir, "output.json");
    const payload = readJson(outputFile, MAX_FILE_BYTES);

    let output = null;
    let outputChars = 0;
    let truncated = false;
    let readError = null;
    // ⚠ THREE DIFFERENT FACTS SHARED ONE FLAG. `readError` was set for a deliverable we refused
    // to load, for one we could not parse, and for one that is simply absent — and the summary
    // then reported all three as "produced output that could not be read", which is a lie for
    // the last: nothing was produced. Named a kind so the sentence can match the fact. Found by
    // a code review of this file on 2026-08-09, hours after the sentence was written.
    let readErrorKind = null;

    if (payload && typeof payload.output === "string") {
      outputChars = payload.output.length;
      output = outputChars > cap ? payload.output.slice(0, cap) : payload.output;
      truncated = outputChars > cap;
    } else if (fileTooBig(outputFile)) {
      // Refusing to read is a finding, not an absence. Left as "no output" it would look like
      // a strand that produced nothing, which is exactly the confusion this module removes.
      readError = `output.json is larger than the ${MAX_FILE_BYTES}-byte read limit and was not loaded`;
      readErrorKind = "refused";
    } else if (fs.existsSync(outputFile)) {
      readError = "output.json present but held no readable `output` string";
      readErrorKind = "unusable";
    } else if (meta?.status === "completed") {
      // The one combination that must never pass quietly: the CLI called it done and the
      // deliverable is missing. That is the shape of the original defect.
      readError = "status is completed but output.json is absent";
      readErrorKind = "missing";
    }

    strands.push({
      id: typeof meta?.subagent_id === "string" ? meta.subagent_id : child,
      childSessionId: typeof meta?.child_session_id === "string" ? meta.child_session_id : null,
      type: typeof meta?.subagent_type === "string" ? meta.subagent_type : null,
      description: typeof meta?.description === "string" ? meta.description : null,
      // Capped like the deliverable. A subagent prompt is routinely long — the real ones
      // measured here run to two thousand characters — and it went into the record whole
      // while `output` next to it was bounded.
      prompt: typeof meta?.prompt === "string" ? meta.prompt.slice(0, cap) : null,
      status: typeof meta?.status === "string" ? meta.status : "unknown",
      startedAt: typeof meta?.started_at === "string" ? meta.started_at : null,
      completedAt: typeof meta?.completed_at === "string" ? meta.completed_at : null,
      durationMs: Number.isFinite(meta?.duration_ms) ? meta.duration_ms : null,
      toolCalls: Number.isFinite(meta?.tool_calls) ? meta.tool_calls : null,
      turns: Number.isFinite(meta?.turns) ? meta.turns : null,
      model: typeof meta?.effective_model_id === "string" ? meta.effective_model_id : null,
      // SubagentMeta never persists capability_mode (cli-1.0.45
      // agent/subagent/mod.rs:2101-2154). The field lived only on the GCS artifact.
      output,
      outputChars,
      truncated,
      readError,
      readErrorKind,
      sourceDir: childDir
    });
  }

  // Chronological where the CLI said so, so a rendered transcript reads in spawn order
  // rather than in whatever order the filesystem happened to hand back.
  strands.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
  // Say what the cap swallowed, through an out-param rather than a property bolted onto the
  // returned array — this function's contract is "an array of strands" and callers destructure
  // it. Silence here would be the same defect this module fixes, one level down: a listing
  // that looks complete because nothing claimed otherwise.
  if (options.stats && typeof options.stats === "object") {
    options.stats.droppedByCap = dropped;
    options.stats.droppedOutsideTree = escaped;
    options.stats.unreadableEntries = unstatable.length + vanished;
  }
  return strands;
}

/**
 * Everything the bridge needs for one run, in one call.
 *
 * Returns `null` for both "no session directory" and "session directory with no strands",
 * which is deliberate: the caller's only question is whether there is a fan-out to show,
 * and there is not. ⚠ It does NOT distinguish the two — an earlier version of this comment
 * claimed it did, describing a `{ strands: [], sessionDir: null }` shape the code has never
 * returned. Caught by audit 2026-08-09. If the distinction is ever wanted, call
 * `findSessionDir` directly; do not read it out of this return value.
 */
export function collectSubagentEvidence(sessionId, options = {}) {
  const sessionDir = findSessionDir(sessionId, options);
  if (!sessionDir) {
    return null;
  }
  const stats = {};
  const strands = readSubagentStrands(sessionDir, { ...options, stats });
  // ⚠ NO STRANDS IS NOT THE SAME AS NOTHING TO REPORT, and treating it that way made the
  // containment work dead on the one path it exists for. A subagents directory holding only an
  // escaping junction — or only entries that could not be examined — yields zero strands and a
  // non-zero count, and returning `null` here threw that count away: the caller attached no
  // evidence, and the warning lines added for exactly this case could never run. `show` said
  // "no fan-out" while something had planted a link in the CLI's session directory.
  //
  // Measured 2026-08-09 against a directory containing one junction and nothing else: the
  // reader reported droppedOutsideTree 1, and this function returned null. The containment test
  // could not catch it, because it always plants a legitimate strand first — the control that
  // makes the test valid is also what hides this path. Found by a code review of the fix.
  const dropped = (stats.droppedByCap ?? 0) + (stats.droppedOutsideTree ?? 0) + (stats.unreadableEntries ?? 0);

  // Keep only the strands belonging to THIS run. A session outlives a run whenever `--thread` or
  // `--resume` is used, and the CLI writes every turn's subagents into the one session
  // directory — so without this, a continuation reports the whole thread's history as its own
  // fan-out. See the note on `withSubagentEvidence`.
  //
  // ⚠ An unreadable timestamp KEEPS the strand and marks the filter partial. Dropping evidence
  // because a date would not parse is the same under-report this module exists to prevent, so
  // the failure direction is deliberately "show too much and say so".
  const window = options.window ?? null;
  const from = window?.from ? Date.parse(window.from) : NaN;
  const to = window?.to ? Date.parse(window.to) : NaN;
  let outsideWindow = 0;
  let unfilterable = 0;
  const mine = !window
    ? strands
    : strands.filter((s) => {
        const at = s.startedAt ? Date.parse(s.startedAt) : NaN;
        if (Number.isNaN(at)) {
          unfilterable += 1;
          return true;
        }
        if (!Number.isNaN(from) && at < from - 1000) {
          outsideWindow += 1;
          return false;
        }
        if (!Number.isNaN(to) && at > to + 1000) {
          outsideWindow += 1;
          return false;
        }
        return true;
      });

  if (mine.length === 0 && dropped === 0 && outsideWindow === 0) {
    return null;
  }
  return {
    sessionDir,
    strands: mine,
    droppedByCap: stats.droppedByCap ?? 0,
    droppedOutsideTree: stats.droppedOutsideTree ?? 0,
    unreadableEntries: stats.unreadableEntries ?? 0,
    // Strands belonging to another turn of the same session. Reported rather than hidden: a
    // reader who knows the thread fanned out five ways should see where the other four went.
    fromOtherTurns: outsideWindow,
    // Strands kept because their timestamp could not be read, so the count above is a floor.
    unfilterable,
    completed: mine.filter((s) => s.status === "completed").length,
    failed: mine.filter((s) => s.status === "failed").length,
    totalChars: mine.reduce((sum, s) => sum + s.outputChars, 0)
  };
}
