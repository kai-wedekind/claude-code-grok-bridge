// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
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

  if (report.bridge) {
    lines.push("Bridge:");
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
    const lines = [
      `# Grok Build ${meta.reviewLabel}`,
      "",
      headline,
      "",
      `- Details: ${meta?.failureMessage || parsedResult.parseError}`
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

export function renderStoredJobResult(job, storedJob) {
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
