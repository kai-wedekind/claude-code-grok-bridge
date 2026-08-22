// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
// "3 hours", "2 days" — for saying when a check last actually looked. Deliberately duplicated
// from lib/version-check.mjs rather than imported: this module has no imports at all, and a
// formatting helper is not worth making a pure renderer depend on the update machinery. The
// duplicate is four lines of arithmetic with no shared state to drift.
function describeAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return "an unknown time";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatGrokResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `grok -r ${job.threadId}`;
}

function formatUsageFooter(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const parts = [];
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const total = usage.total_tokens ?? usage.totalTokens;
  if (input != null) {
    parts.push(`input ${input}`);
  }
  if (output != null) {
    parts.push(`output ${output}`);
  }
  if (total != null) {
    parts.push(`total ${total}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `Usage: ${parts.join(", ")}`;
}

function appendActiveJobsTable(lines, jobs, options = {}) {
  const showClaudeSession = Boolean(options.showClaudeSession);
  lines.push("Active runs:");
  if (showClaudeSession) {
    lines.push("| Run | Kind | Status | Phase | Elapsed | Claude Session | Grok Session ID | Summary | Actions |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  } else {
    lines.push("| Run | Kind | Status | Phase | Elapsed | Grok Session ID | Summary | Actions |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  }
  for (const job of jobs) {
    const actions = [`/grok-build:runs ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/grok-build:stop ${job.id}`);
    }
    const summaryCell = escapeMarkdownCell(job.lastMessage || job.summary || "");
    if (showClaudeSession) {
      lines.push(
        `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.sessionId ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${summaryCell} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
      );
    } else {
      lines.push(
        `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${summaryCell} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
      );
    }
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.lastMessage && job.lastMessage !== job.summary) {
    lines.push(`  Last: ${job.lastMessage}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  // Turns, where a person actually looks. The number is recorded on every finished run
  // and was visible only by opening the JSON payload — no use for the one thing it is
  // good for: telling a real answer apart from a run that emitted its opening narration
  // and stopped. A single turn on a task that should have taken several is the only
  // mechanical signal for that, and the caller has to be able to see it without tooling.
  //
  // The CLI envelope carries no tool-call count, so that half of the idea is not
  // available without parsing the progress stream, which would be brittle. Turns are.
  const turns = job.result?.numTurns ?? job.numTurns ?? null;
  if (Number.isFinite(turns)) {
    lines.push(`  Turns: ${turns}`);
  }
  if (options.showClaudeSession && job.sessionId) {
    lines.push(`  Claude session: ${job.sessionId}`);
  }
  if (job.threadId) {
    lines.push(`  Grok session ID: ${job.threadId}`);
  }
  const resumeCommand = formatGrokResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Grok: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Stop: /grok-build:stop ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Show: /grok-build:show ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /grok-build:review --wait");
    lines.push("  Stricter pass: /grok-build:critique --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
  // The image probe recorded its own failure and nobody ever read it. It answers exactly
  // one question, and only at the moment it is expensive to get wrong: whether `stop` can
  // tell that the PID it is about to signal is still the process this run started. Without
  // an image it falls back to matching any node or grok process, which on a developer
  // machine is a weak fingerprint. The kill still proceeds — a run that cannot be stopped
  // is the worse failure for a tool that spends money — so this changes nothing about the
  // policy and only makes the weaker guarantee visible to whoever reads the record.
  if (job.agentImageProbe === "unavailable") {
    lines.push("  ⚠ Process fingerprint unavailable — stop matches on name alone, not identity.");
  }
  pushSubagentStrands(lines, job, options);
}

/**
 * What Grok's own subagents actually did.
 *
 * Until 0.3.3 this was invisible: the bridge kept the parent's final synthesis and dropped
 * every strand behind it, so a fan-out that half-died looked exactly like one that
 * succeeded — same confident answer, same charge against the weekly allowance. Measured
 * 2026-08-09 across every run on one machine: 44 % of all strands had failed, and nothing
 * anywhere said so.
 *
 * The evidence is handed in as plain data and never read here. This module has no imports
 * and keeps it that way, so rendering stays a pure function of the record.
 */
export function pushSubagentStrands(lines, job, options = {}) {
  const evidence = job.subagents;
  if (!evidence?.strands?.length) {
    return;
  }
  const { strands } = evidence;
  const failed = strands.filter((s) => s.status === "failed").length;
  const cancelled = strands.filter((s) => s.status === "cancelled").length;
  const completed = strands.filter((s) => s.status === "completed").length;

  // ⚠ The tally must ADD UP to the count beside it. It listed only completed, failed and
  // cancelled, so a strand still running — or one whose meta.json was missing, which yields
  // "unknown" — vanished from the breakdown while still counting in the total: `Subagents: 3
  // (1 completed)`, with nothing saying where the other two went. A reader who notices assumes
  // a display bug; a reader who does not silently under-counts the fan-out. Audit 2026-08-09.
  const accounted = completed + failed + cancelled;
  const tally = [`${completed} completed`];
  if (failed) tally.push(`${failed} failed`);
  if (cancelled) tally.push(`${cancelled} cancelled`);
  if (strands.length > accounted) tally.push(`${strands.length - accounted} running or unknown`);
  lines.push(`  Subagents: ${strands.length} (${tally.join(", ")})`);

  for (const strand of strands) {
    const mark = strand.status === "completed" ? "+" : strand.status === "failed" ? "!" : "-";
    const size = strand.outputChars ? `${strand.outputChars} chars` : "no output";
    const tools = Number.isFinite(strand.toolCalls) ? `, ${strand.toolCalls} tools` : "";
    const label = strand.description || strand.type || strand.id;
    lines.push(`    ${mark} [${strand.type ?? "?"}] ${label} — ${size}${tools}`);
    if (strand.readError) {
      lines.push(`      ! ${strand.readError}`);
    }
  }

  // Say it plainly rather than leaving it to be inferred from the marks. A partial fan-out
  // still bills the full allowance and still returns a synthesis that reads as complete.
  //
  // Count what the sentence actually claims. An earlier version said "produced nothing" while
  // counting `failed` and `cancelled` — so a failed strand that had emitted partial text was
  // reported as empty, and a completed one whose deliverable could not be read was quietly
  // counted among the survivors. Audit 2026-08-09. Emptiness is now measured, not inferred
  // from status, and the two questions are reported separately because they are different:
  // how many strands delivered, and how much of the fan-out died.
  //
  // ⚠ AND A STRAND WE COULD NOT READ HAS NOT "PRODUCED NOTHING". `outputChars` stays 0 when the
  // deliverable was refused for being over the size limit, or when its JSON would not parse —
  // so the sentence claimed the fan-out was emptier than it was, and contradicted the
  // per-strand `! output.json is larger than …` line printed directly above it. That is the
  // same under-reporting this whole module exists to end, reappearing in its own summary.
  // A `readError` means bytes exist and we declined them; that is a third state and it says so.
  //
  // ⚠ AND "COULD NOT BE READ" IS ONLY TRUE FOR ONE OF THE THREE readError KINDS. The flag is
  // set when a deliverable was refused for size, when one exists but could not be parsed, and
  // when a strand is marked completed with no deliverable at all. Saying "DID produce output"
  // about the last is a lie: nothing was produced, which is the original defect wearing the
  // new sentence. Only `refused` — bytes on disk we declined — earns that wording; `missing`
  // belongs with the empty strands it actually resembles. Found by a code review 2026-08-09,
  // hours after this sentence was written to fix the previous version of the same mistake.
  //
  // ⚠ AND A STRAND STILL RUNNING HAS NOT "PRODUCED NOTHING" — IT HAS NOT FINISHED. Every
  // non-terminal strand has `outputChars` 0 and no readError, so it fell into `empty`, and
  // `runs <id>` on a live job announced "3 of 3 strands produced nothing — this answer rests on
  // 0" one line below a tally that correctly said "3 running or unknown". The two lines
  // contradicted each other, and the wrong one is the one a reader takes as the verdict.
  // Reproduced at HEAD by a code review 2026-08-09.
  const terminal = (s) => s.status === "completed" || s.status === "failed" || s.status === "cancelled";
  const finished = strands.filter(terminal);
  const pending = strands.length - finished.length;
  const unread = finished.filter((s) => !s.outputChars && s.readErrorKind === "refused").length;
  const unusable = finished.filter((s) => !s.outputChars && s.readErrorKind === "unusable").length;
  const delivered = finished.filter((s) => s.outputChars).length;
  const empty = finished.length - unread - unusable - delivered;
  if (empty > 0) {
    lines.push(
      `  ⚠ ${empty} of ${finished.length} finished strands produced nothing — this answer rests on ${delivered}.`
    );
  }
  if (pending > 0) {
    lines.push(`  … ${pending} strand(s) had not finished when this was read — not counted either way.`);
  }
  // Strands from an earlier turn of the same session. Named rather than silently filtered, so a
  // reader who knows the thread fanned out five ways can see where the rest went.
  if (evidence.fromOtherTurns > 0) {
    lines.push(
      `  · ${evidence.fromOtherTurns} strand(s) in this session belong to other turns of the thread and are not shown.`
    );
  }
  if (unread > 0) {
    lines.push(
      `  ⚠ ${unread} further strand(s) DID produce output that this bridge declined to read (see the ! lines above) — not counted as delivered, and not empty either.`
    );
  }
  if (unusable > 0) {
    lines.push(
      `  ⚠ ${unusable} further strand(s) left a deliverable that could not be understood — not counted as delivered, and not necessarily empty.`
    );
  }
  if (evidence.droppedByCap > 0) {
    lines.push(
      `  ⚠ ${evidence.droppedByCap} further strand(s) exist on disk but were not read — the per-run cap was reached.`
    );
  }
  // Said out loud rather than silently skipped: an entry that resolves outside the session
  // tree is not a strand of this run, but a listing that quietly shrinks is the very thing
  // this block exists to prevent. If this line ever appears, something planted a link in the
  // CLI's session directory, and that is worth knowing on its own.
  if (evidence.unreadableEntries > 0) {
    lines.push(
      `  ⚠ ${evidence.unreadableEntries} entr(y/ies) were listed in this run's subagents directory but could not be examined at all.`
    );
  }
  if (evidence.droppedOutsideTree > 0) {
    lines.push(
      `  ⚠ ${evidence.droppedOutsideTree} entr(y/ies) under this run's subagents directory resolve OUTSIDE the session tree and were not read.`
    );
  }

  if (options.showStrandOutput) {
    for (const strand of strands) {
      if (!strand.output) continue;
      lines.push("");
      lines.push(`  --- strand: ${strand.description || strand.id} [${strand.type ?? "?"}] ---`);
      for (const line of strand.output.split("\n")) {
        lines.push(`  ${line}`);
      }
      if (strand.truncated) {
        lines.push(`  … truncated here; the full ${strand.outputChars} characters are in ${strand.sourceDir}`);
      }
    }
  } else if (evidence.sessionDir) {
    lines.push(`  Full strand outputs: ${evidence.sessionDir}`);
    lines.push(`  Print them: /grok-build:show ${job.id} --strands`);
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok Build Check",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- grok: ${report.grok.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    ""
  ];

  // Only present when --verify-tools asked for it, because finding out costs a real run.
  // ⚠ Three outcomes, and they must stay three. "Could not check" is not "fine": this list is
  // the read-only barrier, and a probe that failed says nothing about whether it holds. The
  // CLI's own warning for an id that matches nothing goes only to a --debug-file, so without
  // this the failure is invisible on every surface a person sees.
  if (report.toolIds) {
    const tools = report.toolIds;
    if (!tools.checked) {
      lines.push(`- read-only tool ids: NOT CHECKED — ${tools.error || "the probe did not run"}`);
      lines.push("  This is not an all-clear: the barrier's ids remain unverified against this CLI.");
    } else if (tools.unmatched.length > 0) {
      lines.push(`- read-only tool ids: ${tools.unmatched.length} of ${tools.total} MATCH NOTHING`);
      lines.push(`  ${tools.unmatched.join(", ")}`);
      lines.push("  Each removes no tool. The read-only barrier is weaker than the code claims.");
    } else {
      lines.push(`- read-only tool ids: all ${tools.total} recognised by this CLI`);
    }
    lines.push("");
  }

  // ⚠ UNCONDITIONAL, exactly like the tool-id block above and for the same reason: an omitted
  // line reads as "nothing to report", which is indistinguishable from "fine". Four states, and
  // `unknown` says in words that it is not an all-clear.
  {
    const update = report.update ?? { state: "unknown", reason: "no version check ran" };
    lines.push("Version:");
    if (update.state === "behind") {
      lines.push(
        `- update: UPDATE AVAILABLE — running ${update.running}, latest release ${update.latest}`
      );
      lines.push("  https://github.com/kai-wedekind/claude-code-grok-bridge/releases/latest");
    } else if (update.state === "current" && update.stale) {
      // ⚠ `current` is a positive claim about the present, and a stale observation cannot
      // support it — upstream may have shipped since. `behind` from the same cache stays
      // `behind`, because that one can only under-report. Found by an audit, 2026-08-08.
      lines.push(
        `- update: unknown — running ${update.running}, and the last successful check was ` +
          `${describeAge(update.ageMs)} ago (it saw ${update.latest})`
      );
      lines.push("  Too old to call you current. Run `check --fetch-update` to ask now.");
    } else if (update.state === "current") {
      lines.push(
        `- update: current — running ${update.running}, latest release ${update.latest}` +
          (typeof update.ageMs === "number" ? ` (checked ${describeAge(update.ageMs)} ago)` : "")
      );
    } else if (update.state === "ahead") {
      lines.push(
        `- update: running ${update.running}, ahead of the latest release ${update.latest}`
      );
    } else {
      lines.push(`- update: unknown — ${update.reason || "no check has run yet"}`);
      lines.push("  This is not an all-clear. Run `check --fetch-update` to ask now.");
    }
    lines.push("  Status: above covers node, grok and auth only — it does not include version state.");
    lines.push("");
  }

  if (report.bridge) {
    lines.push("Bridge:");
    // A01. The install path first, because every other line in this report describes
    // whatever build that path holds — and a stale one makes all of them true about the
    // wrong code. Sources that stay silent are omitted rather than printed as "unknown":
    // a developer running from a clone has no version directory and no registry, and
    // filling the report with n/a would train people to skip the block.
    const install = report.bridge.install;
    if (install?.installDir) {
      lines.push(`- loaded from: ${install.installDir}`);
    }
    if (install?.directoryVersion) {
      lines.push(`- install directory says: ${install.directoryVersion}`);
    }
    if (install?.manifestVersion) {
      lines.push(`- manifest says: ${install.manifestVersion}`);
    }
    if (install?.registryVersion) {
      lines.push(`- Claude Code registry says: ${install.registryVersion}`);
    }
    if (install?.disagreements?.length) {
      lines.push(`- ⚠ these disagree, so at least one of them is describing code that is not running:`);
      for (const detail of install.disagreements) {
        lines.push(`    ${detail}`);
      }
      lines.push("    Reinstall or redeploy the plugin before trusting a version number here.");
    }
    if (report.bridge.stateRoot) {
      lines.push(`- state root: ${report.bridge.stateRoot}`);
    }
    if (report.bridge.maxConcurrency != null) {
      lines.push(`- max concurrency: ${report.bridge.maxConcurrency}`);
    }
    if (report.bridge.slotWaitMs != null) {
      lines.push(`- slot wait ms: ${report.bridge.slotWaitMs}`);
    }
    lines.push("");
  }

  if (report.envHints?.length > 0) {
    lines.push("Env (effective):");
    for (const line of report.envHints) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  if (report.actionsTaken?.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps?.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// The result is cleared for every hard failure, not only for a bad JSON reply. Naming
// the wrong cause sends the reader off to debug the model instead of the timeout.
//
// Shared by every surface that has to state a cause in a sentence — review, critique and
// the plain `run` path. It was review-only until 2026-08-02, which is why `run` still
// opened with the CLI's raw error envelope while a critique of the same failure named it
// properly. One table, so the three cannot drift into describing the same failure
// differently.
const FAILURE_HEADLINES = {
  timeout: "The run exceeded its time limit before a result was produced.",
  "cli-error": "The Grok CLI failed before a result was produced.",
  "output-truncated": "The output exceeded the capture limit and was cut off, so the result is incomplete.",
  "no-deliverable": "Grok returned no output.",
  "schema-parse": "Grok did not return valid structured JSON.",
  "quota-exhausted":
    "Grok refused the run for quota reasons (HTTP 402), so it stopped before producing a result. " +
    "Whether retrying helps depends on the account: an allowance that has to reset, or credit that can be topped up.",
  // The one that was missing, and the most expensive omission of the set: an expired
  // session fell through to the default line and told the reader their JSON was malformed.
  // Both members of RETRY_CANNOT_HELP now have an entry, which is the property that matters
  // — they are exactly the failures where doing the same thing again cannot work, so the
  // headline is the only thing that tells the reader to do something else.
  "not-authenticated":
    "Nobody is signed in, so the run stopped before producing a result. Sign in with `grok login --device-code` or set XAI_API_KEY."
};

/**
 * A plain sentence for a failure code, or null when the code is unknown.
 *
 * Null rather than a generic phrase on purpose: a caller that gets null keeps whatever it
 * said before, which is worse-worded but never wrong. Inventing a headline for a code this
 * table has not seen is how a reader gets told a confident falsehood about why a run died.
 *
 * @param {string|null|undefined} failureCode
 * @returns {string|null}
 */
export function failureHeadline(failureCode) {
  if (typeof failureCode !== "string" || failureCode.length === 0) {
    return null;
  }
  return FAILURE_HEADLINES[failureCode] ?? null;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const headline =
      failureHeadline(meta?.failureCode) ?? "Grok did not return valid structured JSON.";
    // ⚠ The same double already fixed at the three other call sites in this file: for most
    // failure codes `failureMessage` IS the headline, so printing both gives the reader the
    // identical sentence twice with "- Details:" in front of the second one. Detail is only
    // detail when it says something the headline did not.
    const detail = meta?.failureMessage || parsedResult.parseError;
    const lines = [
      `# Grok Build ${meta.reviewLabel}`,
      "",
      headline,
      ...(detail && detail !== headline ? ["", `- Details: ${detail}`] : [])
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Grok Build ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Grok returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Grok Build ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const failure = String(result.failureMessage ?? "").trim();
  // Prefer the bridge exit status when provided so a failed gate (exit 2) cannot
  // still render as "completed" after the CLI itself returned 0 with empty text.
  const status = result.exitStatus ?? result.status;
  const failed = Boolean(failure) || (status !== 0 && status != null);
  const lines = [
    `# Grok Build ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (failed) {
    // The caller has always passed `failureCode` here and this renderer never read it, so a
    // failed review led with `failureMessage` — which falls back to "Grok exited with status
    // N" whenever the CLI wrote nothing to stderr. For an expired session that put the exit
    // code on the first line and the remedy ("grok login --device-code") down inside
    // "Partial output". Same rule as the task path: name the cause, keep the evidence.
    const headline = failureHeadline(result.failureCode);
    lines.push(headline || failure || "Grok review failed.");
    if (headline && failure && failure !== headline) {
      lines.push("", `Details: ${failure}`);
    }
    if (stdout) {
      lines.push("", "Partial output:", "", "```text", stdout, "```");
    }
  } else if (stdout) {
    lines.push(stdout);
  } else if (status === 0) {
    lines.push("Grok review completed without any stdout output.");
  } else {
    lines.push("Grok review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  // Callers pass failureMessage only for hard failures (!delivered or status !== 0).
  // Soft problems (e.g. thread registration) arrive as warnings and must not be
  // printed as "Run did not succeed" on an otherwise successful exit 0.
  const failure = String(parsedResult?.failureMessage ?? "").trim();
  const warnings = Array.isArray(parsedResult?.warnings)
    ? parsedResult.warnings.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const warningLine = warnings.length > 0 ? `[grok-cc] Warning: ${warnings.join(" ")}\n` : "";
  const usageLine = formatUsageFooter(parsedResult?.usage ?? meta?.usage);
  const usageSuffix = usageLine ? `\n${usageLine}\n` : "";
  // ⚠ THE CAUSE GOES ON LINE ONE.
  //
  // Until 2026-08-02 a failed run opened with the CLI's raw output and stated the reason
  // underneath it. For an exhausted allowance that raw output is an error envelope whose
  // first words are "Internal error", so a billing refusal presented as a crash in this
  // plugin — one reporter said they would have started debugging the bridge. The reason
  // was in the text, several hundred characters down, which is not where anyone looks.
  //
  // The envelope is demoted, never dropped: on `output-truncated` it holds the partial
  // answer, and on `cli-error` it is the only description of what went wrong. Only when
  // the code is unknown does this fall back to the old shape — see failureHeadline.
  const headline = failure ? failureHeadline(meta?.failureCode) : null;
  // A detail earns its line only by adding something. For `no-deliverable` and
  // `schema-parse` the CLI's own message IS the table sentence, so appending it printed the
  // same words twice — the cause right, the evidence a copy of it. The other call sites
  // already guarded on this; these two did not.
  const detail = headline && failure && failure !== headline ? failure : "";

  if (rawOutput) {
    const body = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    // A failed run must say so on stdout too: hiding the reason behind partial output
    // left callers unable to tell a non-zero exit from a successful one.
    if (failure) {
      return headline
        ? `[grok-cc] Run did not succeed: ${headline}\n\n${body}${detail ? `\n[grok-cc] Details: ${detail}` : ""}${usageSuffix || "\n"}`
        : `${body}\n[grok-cc] Run did not succeed: ${failure}${usageSuffix || "\n"}`;
    }
    if (warningLine) {
      return `${body}\n${warningLine}${usageSuffix}`;
    }
    return `${body}${usageSuffix}`;
  }

  if (failure) {
    return headline
      ? `[grok-cc] Run did not succeed: ${headline}${detail ? `\n\n[grok-cc] Details: ${detail}` : ""}${usageSuffix || "\n"}`
      : `${failure}${usageSuffix || "\n"}`;
  }
  if (warningLine) {
    return `${warningLine}${usageSuffix}`;
  }
  if (usageSuffix) {
    return `Grok did not return a final message.${usageSuffix}`;
  }
  return "Grok did not return a final message.\n";
}

export function renderStatusReport(report) {
  const showClaudeSession = Boolean(report.allSessions);
  const lines = [
    "# Grok Build Runs",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    report.allSessions
      ? "Scope: all Claude sessions in this workspace"
      : report.currentSessionId
        ? `Scope: Claude session ${report.currentSessionId}`
        : "Scope: current process (no GROK_CC_SESSION_ID; showing unscoped jobs)",
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running, { showClaudeSession });
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true,
        showClaudeSession
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed",
      showClaudeSession
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent runs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed",
        showClaudeSession
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    // Never present an empty filter as an empty workspace. That is what made a caller
    // abandon a run it had already paid for: the session id changed under it, the filter
    // hid its own job, and the report read like nothing had ever been started.
    const hidden = report.hiddenBySessionFilter ?? 0;
    if (hidden > 0) {
      lines.push(
        `No runs for this session — but this workspace has ${hidden} ${hidden === 1 ? "run" : "runs"} from other sessions.`,
        "List them with --all-sessions. A session id can change under you (compaction, resume),",
        "which hides your own run from this view without stopping it.",
        ""
      );
    } else {
      lines.push("No runs recorded yet.", "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Grok Build Run Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The result body. Kept separate from the export because it has a dozen early returns —
 * appending the strand block to each of them is a dozen chances to miss one, and the one
 * missed would be a silent hole exactly where this release promises there is none.
 */
function renderStoredJobResultBody(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `grok -r ${threadId}` : null;
  const status = job?.status ?? storedJob?.status ?? null;
  const failureCode =
    (typeof job?.failureCode === "string" && job.failureCode) ||
    (typeof storedJob?.failureCode === "string" && storedJob.failureCode) ||
    (typeof storedJob?.result?.failureCode === "string" && storedJob.result.failureCode) ||
    null;
  const isFailed =
    status === "failed" ||
    status === "cancelled" ||
    Boolean(failureCode);

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.grok?.stdout === "string" && storedJob.result.grok.stdout) ||
    "";
  const renderedText =
    typeof storedJob?.rendered === "string" && storedJob.rendered ? storedJob.rendered : "";

  // Failure framing wins over available text: a non-empty partial must not look like
  // a completed result (process exit and stored JSON already say failed).
  if (isFailed) {
    const lines = [
      `# ${job?.title ?? storedJob?.title ?? "Grok Build Result"}`,
      "",
      `Run: ${job?.id ?? storedJob?.id ?? "unknown"}`,
      `Status: ${status ?? "failed"}`
    ];
    if (failureCode) {
      lines.push(`Failure code: ${failureCode}`);
    }
    if (threadId) {
      lines.push(`Grok session ID: ${threadId}`);
      lines.push(`Resume in Grok: ${resumeCommand}`);
    }
    const errorMessage =
      (typeof job?.errorMessage === "string" && job.errorMessage.trim()) ||
      (typeof storedJob?.errorMessage === "string" && storedJob.errorMessage.trim()) ||
      (typeof storedJob?.result?.failureMessage === "string" && storedJob.result.failureMessage.trim()) ||
      "";
    // `show` re-assembles from the stored record rather than replaying `rendered`, so it
    // needed the headline of its own: `errorMessage` is `failureMessage`, which for auth and
    // a bare cli-error is still "Grok exited with status N". The raw envelope below is left
    // where it is — clearly labelled "Partial output" and now preceded by the cause, which
    // is the property that matters. Nesting the whole rendered block under that label would
    // read worse than this.
    const headline = failureHeadline(failureCode);
    if (headline) {
      lines.push("", headline);
      if (errorMessage && errorMessage !== headline) {
        lines.push("", `Details: ${errorMessage}`);
      }
    } else if (errorMessage) {
      lines.push("", errorMessage);
    } else {
      lines.push("", "Run did not succeed.");
    }
    // Fall back to the stored `rendered` only when no headline was printed. With one, that
    // block opens with the very same sentence, so nesting it under "Partial output" stated
    // the cause a second time — and for a failure with no envelope there is nothing else
    // in it to show.
    const partial = (rawOutput || (headline ? "" : renderedText)).trimEnd();
    if (partial) {
      lines.push("", "Partial output:", partial);
    }
    const usageLine = formatUsageFooter(storedJob?.result?.usage ?? storedJob?.usage ?? null);
    if (usageLine) {
      lines.push("", usageLine);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
  }

  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Grok Build Result"}`,
    "",
    `Run: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Grok session ID: ${threadId}`);
    lines.push(`Resume in Grok: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  const usageLine = formatUsageFooter(storedJob?.result?.usage ?? storedJob?.usage ?? null);
  if (usageLine) {
    lines.push("", usageLine);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob, options = {}) {
  const base = renderStoredJobResultBody(job, storedJob);
  const strandLines = [];
  pushSubagentStrands(strandLines, job, options);
  if (strandLines.length === 0) {
    return base;
  }
  return `${base.trimEnd()}\n\n${strandLines.join("\n")}\n`;
}

export function renderCancelReport(job) {
  const delivered = job.cancelKill?.delivered ?? job.killDelivered;
  const lines = [
    "# Grok Build Stop",
    "",
    delivered === false
      ? `Stop requested for ${job.id}, but process kill was not confirmed.`
      : `Stopped ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  if (delivered === false) {
    lines.push("- Kill delivered: false (process may still be running).");
  }
  lines.push("- Check `/grok-build:runs` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
