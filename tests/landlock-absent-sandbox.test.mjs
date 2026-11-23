/**
 * Current CLIs refuse to start `--sandbox read-only` when the
 * profile cannot be applied. On Linux without Landlock that is every read-only launch,
 * so the bridge passes `--sandbox off` there and nowhere else. The probe override
 * (GROK_CC_LANDLOCK_PROBE, only `present` / `absent` / `unknown`) and the platform
 * override (GROK_CC_CONFINEMENT_PLATFORM, only while the probe override is set) exist
 * so this file can pin that branch on a host that has Landlock, or that is not Linux.
 *
 * This file does not import `readOnlySandboxProfile`. The assertions below are against
 * `describeConfinement` and against the argv a real launch builds, so a revert of the
 * decision fails the assertion rather than the import.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  describeConfinement,
  describeConnectorConfinement
} from "../plugins/grok-build/scripts/grok-bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function headlessArgv(argvLog) {
  if (!fs.existsSync(argvLog)) return [];
  return fs
    .readFileSync(argvLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((argv) => argv.includes("-p") || argv.includes("--prompt-file"));
}

function sandboxOf(argv) {
  const index = argv.indexOf("--sandbox");
  return index === -1 ? null : argv[index + 1];
}

function launch(subcommand, flags, prompt, { scenario = "default", probe, platform = "linux", json = false } = {}) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  const argvLog = path.join(makeTempDir(), "argv.log");
  const extra = { GROK_FAKE_ARGV_LOG: argvLog };
  if (probe) {
    extra.GROK_CC_LANDLOCK_PROBE = probe;
    if (platform) extra.GROK_CC_CONFINEMENT_PLATFORM = platform;
  }
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir(), ...extra });
  // buildEnv copies the parent environment. A stray override must not decide this launch.
  if (!probe) {
    delete env.GROK_CC_LANDLOCK_PROBE;
    delete env.GROK_CC_CONFINEMENT_PLATFORM;
  } else if (!platform) {
    delete env.GROK_CC_CONFINEMENT_PLATFORM;
  }
  const workspace = makeTempDir();
  const args = [SCRIPT, subcommand, "--cwd", workspace, ...flags];
  if (prompt != null) args.push(prompt);
  const result = run(process.execPath, args, { env });
  let payload = null;
  if (json) {
    payload = JSON.parse(result.stdout);
  }
  return { result, argv: headlessArgv(argvLog), payload, workspace, env };
}

// The forced-probe disclosure arms, pinned phrase by phrase with literal regexes, so a
// disclosure cannot claim more than the record: a test that pins only the forced-probe note
// and two negatives lets a change to what an arm SAYS pass unnoticed.
function assertForcedReadOnlyArm(disclosure, probe, label) {
  assert.match(disclosure, /^Sandbox enforcement unverified on this kernel: /, label);
  assert.match(
    disclosure,
    new RegExp(`The answer was forced by GROK_CC_LANDLOCK_PROBE=${probe} and the host was not probed\\.`),
    label
  );
  assert.match(disclosure, /The bridge passes --sandbox read-only on that answer\./, label);
  assert.match(disclosure, /Tool removal and deny rules are the barrier being relied on\./, label);
  assert.doesNotMatch(disclosure, /\benforced\b/, label);
  assert.doesNotMatch(disclosure, /--sandbox off/, label);
  assert.doesNotMatch(disclosure, /not requested/, label);
  assert.doesNotMatch(disclosure, /Landlock is not among the active LSMs/, label);
  assert.doesNotMatch(disclosure, /could not be read/, label);
}

function assertForcedOffArm(disclosure, label) {
  assert.match(disclosure, /^Sandbox not requested on this kernel: /, label);
  assert.match(
    disclosure,
    /The answer was forced by GROK_CC_LANDLOCK_PROBE=absent and the host was not probed\./,
    label
  );
  assert.match(
    disclosure,
    /Current CLIs refuse to start rather than run --sandbox read-only without Landlock/,
    label
  );
  assert.match(disclosure, /This bridge therefore passes --sandbox off on that answer/, label);
  assert.match(
    disclosure,
    /A managed requirement still outranks the CLI flag and can force a profile\./,
    label
  );
  assert.match(disclosure, /Tool removal and deny rules are the whole barrier here\./, label);
  assert.doesNotMatch(disclosure, /applied/, label);
  assert.doesNotMatch(disclosure, /\benforced\b/, label);
  assert.doesNotMatch(disclosure, /Landlock is not among the active LSMs/, label);
}

// The same arms pinned as WHOLE strings. Phrase assertions would let a change keep every
// pinned phrase and add a contradicting sentence, open the unforced arm with "Sandbox enforced
// on this kernel:", or drop an evidence or rationale clause and still pass. These literals are
// written out here and never built from a bridge function or constant. Each sentence rests on
// the 1.0.45 source, the bridge's argv and layers, and measurements with grok 1.0.70 on a
// Raspberry Pi and on Windows; this file does not re-measure them.
const EXPECTED_UNFORCED_ABSENT = [
  `Sandbox not requested on this kernel: Landlock is not among the active LSMs, and current CLIs refuse to start rather than run --sandbox read-only without it (measured on grok 1.0.70, 2026-10-24; the 1.0.45 source already exits 1).`,
  `This bridge therefore passes --sandbox off on this kernel, so a profile set in the user's own Grok config or GROK_SANDBOX cannot re-trigger the refusal.`,
  `A managed requirement still outranks the CLI flag and can force a profile.`,
  `Tool removal and deny rules are the whole barrier here.`
].join(" ");

const EXPECTED_FORCED_OFF = [
  `Sandbox not requested on this kernel: The answer was forced by GROK_CC_LANDLOCK_PROBE=absent and the host was not probed.`,
  `Current CLIs refuse to start rather than run --sandbox read-only without Landlock (measured on grok 1.0.70, 2026-10-24; the 1.0.45 source already exits 1).`,
  `This bridge therefore passes --sandbox off on that answer, so a profile set in the user's own Grok config or GROK_SANDBOX cannot re-trigger the refusal.`,
  `A managed requirement still outranks the CLI flag and can force a profile.`,
  `Tool removal and deny rules are the whole barrier here.`
].join(" ");

const EXPECTED_FORCED_READ_ONLY_PRESENT = [
  `Sandbox enforcement unverified on this kernel: The answer was forced by GROK_CC_LANDLOCK_PROBE=present and the host was not probed.`,
  `The bridge passes --sandbox read-only on that answer.`,
  `Tool removal and deny rules are the barrier being relied on.`
].join(" ");

const EXPECTED_FORCED_READ_ONLY_UNKNOWN = [
  `Sandbox enforcement unverified on this kernel: The answer was forced by GROK_CC_LANDLOCK_PROBE=unknown and the host was not probed.`,
  `The bridge passes --sandbox read-only on that answer.`,
  `Tool removal and deny rules are the barrier being relied on.`
].join(" ");

// Forced platform arms: the host sentence, then the platform note. The probe value does not
// change the text, only the platform variable does.
const EXPECTED_FORCED_WIN32 = [
  `Sandbox not enforced on this platform (win32): --sandbox read-only is passed, but a write still lands — measured against grok 1.0.0, and the CLI itself says nothing.`,
  `Tool removal and deny rules are the whole barrier here.`,
  `The answer was forced by GROK_CC_CONFINEMENT_PLATFORM=win32 and the host was not probed.`
].join(" ");

const EXPECTED_FORCED_DARWIN = [
  `Sandbox enforcement unverified on macOS: Seatbelt is part of the OS, so the mechanism is almost certainly there — but nothing here probes it, this project has no Mac, and a mechanism existing is not the same as the CLI applying it.`,
  `Tool removal and deny rules are what the barrier actually rests on.`,
  `The answer was forced by GROK_CC_CONFINEMENT_PLATFORM=darwin and the host was not probed.`
].join(" ");

// The connector record is this opening, one space, then the base disclosure, for every arm
// above. The opening is the connector-mode text and is pinned here only so that the
// composition is exact. Its CLI-behaviour sentences (permission mode, the 1.0.52 subagent
// refusal, the 1.0.41 / 1.0.45 read-boundary design) are carried from SECURITY.md, README.md
// and the connector changelog fragments; they were not re-measured and are not claims of
// this file.
const CONNECTOR_OPENING = [
  `Connector mode (google_calendar): search_tool and use_tool are available, the MCPTool deny rule is dropped, and MCPTool(google_calendar__*) pre-approves every tool it covers, including ones that create, send, change or delete.`,
  `The run is pinned to --permission-mode default, so a tool of any other connector raises a permission request, which a headless run answers with Cancelled — unless your own settings already decide it, because the CLI adds them on top: allow rules in your Grok config, managed policy or Claude Code settings, "Always allow" grants saved for this repository, or a Claude defaultMode of auto (an LLM classifier decides instead) or bypassPermissions (everything is approved).`,
  `A local MCP server with the same name as a named connector is opened too, and takes precedence.`,
  `A tool call cannot start a subagent or a workflow here: the bare Edit and Write deny rules reach those tools and are enforced before any approval mode.`,
  `Measured 2026-10-15 on grok 1.0.52, the spawn was refused with "Denied by permission policy: deny rule on edit" and no subagents directory appeared.`,
  `Children exist only in --write runs today.`,
  `That refusal is a side effect of how the CLI classifies those tools, not a documented contract, so a CLI change could reopen it.`,
  `Where a child does run, it shares the parent's permission rules, saved grants and approval mode and carries over the tool removal list; that inheritance is read from the CLI source and is not measured.`,
  `This prompt opens with the bridge's note, so the CLI's slash dispatcher never reads it as a command.`,
  `Anything the agent can read, it can also write into a named connector that accepts text.`,
  `--cwd sets the working directory and the base for relative paths.`,
  `It does not bound reads: a connector run can read any file the user account can read, including ~/.ssh, ~/.claude and ~/.grok, and a prompt-injected connector payload can pull those files into the model's context and from there into a writable connector.`,
  `That is the CLI's design in 1.0.41 and 1.0.45; 1.0.52 is unverified from source.`
].join(" ");

test("linux without Landlock is not-requested and the disclosure says the bridge passes off", () => {
  const absent = describeConfinement(false, "linux", () => "absent");
  assert.equal(absent.kernelSandbox, "not-requested");
  assert.deepEqual(absent.layers, ["disallowed-tools", "deny-rules"]);
  assert.equal(absent.mode, "read-only");
  assert.match(absent.disclosure, /Landlock is not among the active LSMs/);
  assert.match(absent.disclosure, /refuse to start/);
  assert.match(absent.disclosure, /grok 1\.0\.70/);
  assert.match(absent.disclosure, /2026-10-24/);
  assert.match(absent.disclosure, /--sandbox off/);
  // The unforced arm (an injected impl, no env override) carries the managed-requirement
  // sentence too.
  assert.match(absent.disclosure, /A managed requirement still outranks the CLI flag and can force a profile\./);
  assert.match(absent.disclosure, /Tool removal and deny rules are the whole barrier/);

  const connector = describeConnectorConfinement(["google_calendar"], "linux", () => "absent");
  assert.equal(connector.mode, "connector");
  assert.equal(connector.kernelSandbox, "not-requested");
  assert.match(connector.disclosure, /--sandbox off/);
  assert.match(connector.disclosure, /search_tool and use_tool are available/);
});

test("linux with Landlock, an unanswered probe, and Windows keep their previous answers", () => {
  const present = describeConfinement(false, "linux", () => "present");
  assert.equal(present.kernelSandbox, "enforced");
  assert.equal(present.disclosure, null);
  assert.ok(present.layers.includes("sandbox"));

  const unknown = describeConfinement(false, "linux", () => "unknown");
  assert.equal(unknown.kernelSandbox, "unverified");
  assert.match(unknown.disclosure, /unverified on this kernel/);
  assert.doesNotMatch(unknown.disclosure, /--sandbox off/);

  // An injected "absent" must not flip a non-Linux host. The probe is not consulted there.
  const windows = describeConfinement(false, "win32", () => "absent");
  assert.equal(windows.kernelSandbox, "requested-not-enforced");
  assert.match(windows.disclosure, /--sandbox read-only is passed/);
  assert.doesNotMatch(windows.disclosure, /--sandbox off/);

  const darwin = describeConfinement(false, "darwin", () => "absent");
  assert.equal(darwin.kernelSandbox, "unverified");
  assert.match(darwin.disclosure, /unverified on macOS/);
});

test("an unrecognised probe value is ignored", () => {
  const savedProbe = process.env.GROK_CC_LANDLOCK_PROBE;
  const savedPlatform = process.env.GROK_CC_CONFINEMENT_PLATFORM;
  const restore = () => {
    if (savedProbe == null) delete process.env.GROK_CC_LANDLOCK_PROBE;
    else process.env.GROK_CC_LANDLOCK_PROBE = savedProbe;
    if (savedPlatform == null) delete process.env.GROK_CC_CONFINEMENT_PLATFORM;
    else process.env.GROK_CC_CONFINEMENT_PLATFORM = savedPlatform;
  };
  try {
    process.env.GROK_CC_LANDLOCK_PROBE = "nope";
    process.env.GROK_CC_CONFINEMENT_PLATFORM = "linux";
    const ignored = describeConfinement(false);
    const host = describeConfinement(false, process.platform);
    assert.equal(ignored.kernelSandbox, host.kernelSandbox);
    assert.equal(ignored.disclosure, host.disclosure);

    process.env.GROK_CC_LANDLOCK_PROBE = "absent";
    delete process.env.GROK_CC_CONFINEMENT_PLATFORM;
    const withoutPlatform = describeConfinement(false).kernelSandbox;
    process.env.GROK_CC_CONFINEMENT_PLATFORM = "freebsd";
    assert.equal(describeConfinement(false).kernelSandbox, withoutPlatform);
  } finally {
    restore();
  }
});

test("read-only run, connector, nudge, review, critique and verify-tools pass --sandbox off when Landlock is absent", () => {
  const readOnly = launch("run", ["--json"], "say nothing", { probe: "absent", json: true });
  assert.equal(readOnly.result.status, 0, readOnly.result.stderr);
  assert.equal(readOnly.argv.length, 1);
  assert.equal(sandboxOf(readOnly.argv[0]), "off");
  assert.equal(readOnly.payload.confinement.kernelSandbox, "not-requested");
  assert.equal(readOnly.payload.confinement.mode, "read-only");
  assert.ok(readOnly.payload.warnings.some((entry) => /--sandbox off/.test(entry)));
  // The absent answer came from the override, not from the LSM list.
  assert.match(readOnly.payload.confinement.disclosure, /GROK_CC_LANDLOCK_PROBE=absent/);
  assert.match(readOnly.payload.confinement.disclosure, /the host was not probed/);
  assert.doesNotMatch(readOnly.payload.confinement.disclosure, /Landlock is not among the active LSMs/);
  assertForcedOffArm(readOnly.payload.confinement.disclosure, "run --json, probe absent");

  const connector = launch("run", ["--json", "--connector", "google_calendar"], "list my week", {
    probe: "absent",
    json: true
  });
  assert.equal(connector.result.status, 0, connector.result.stderr);
  assert.equal(sandboxOf(connector.argv[0]), "off");
  assert.equal(connector.payload.confinement.mode, "connector");
  assert.equal(connector.payload.confinement.kernelSandbox, "not-requested");

  const nudge = launch("run", [], "say nothing", { scenario: "empty-text", probe: "absent" });
  assert.ok(nudge.argv.length >= 2, `expected a nudge relaunch, saw ${nudge.argv.length}`);
  nudge.argv.forEach((argv, index) => {
    assert.equal(sandboxOf(argv), "off", `nudge launch ${index + 1}`);
  });

  for (const command of ["review", "critique"]) {
    const binDir = makeTempDir();
    installFakeGrok(binDir);
    const workspace = makeTempDir();
    initGitRepo(workspace);
    fs.writeFileSync(path.join(workspace, "changed.txt"), "a line worth reviewing\n", "utf8");
    const argvLog = path.join(makeTempDir(), "argv.log");
    const env = buildEnv(binDir, {
      CLAUDE_PLUGIN_DATA: makeTempDir(),
      GROK_FAKE_ARGV_LOG: argvLog,
      GROK_CC_LANDLOCK_PROBE: "absent",
      GROK_CC_CONFINEMENT_PLATFORM: "linux"
    });
    const result = run(process.execPath, [SCRIPT, command, "--json", "--cwd", workspace], { env });
    const payload = JSON.parse(result.stdout);
    const argv = headlessArgv(argvLog);
    assert.ok(argv.length >= 1, `${command} must have launched`);
    argv.forEach((line) => assert.equal(sandboxOf(line), "off", command));
    assert.equal(payload.confinement.kernelSandbox, "not-requested", command);
    assert.equal(payload.confinement.mode, "read-only", command);
  }

  const probe = launch("check", ["--verify-tools", "--json"], null, { probe: "absent" });
  const probed = probe.argv.filter((argv) => argv.includes("--disallowed-tools"));
  assert.ok(probed.length >= 1, "verify-tools must have launched the removal-list probe");
  probed.forEach((argv) => {
    assert.equal(sandboxOf(argv), "off");
    assert.ok(argv.includes("--deny"), "the probe keeps the deny rules");
  });
});

test("Landlock present and an unanswered probe still pass --sandbox read-only", () => {
  for (const probe of ["present", "unknown"]) {
    const runResult = launch("run", ["--json"], "say nothing", { probe, json: true });
    assert.equal(runResult.result.status, 0, runResult.result.stderr);
    assert.equal(sandboxOf(runResult.argv[0]), "read-only", probe);
    // The override is not a measurement. The argv stays
    // read-only; the record does not say enforced, and the disclosure names the force.
    assert.equal(runResult.payload.confinement.kernelSandbox, "unverified", probe);
    assert.match(
      runResult.payload.confinement.disclosure,
      new RegExp(`The answer was forced by GROK_CC_LANDLOCK_PROBE=${probe} and the host was not probed`)
    );
    assert.doesNotMatch(runResult.payload.confinement.disclosure, /Landlock is not among the active LSMs/);
    assert.doesNotMatch(runResult.payload.confinement.disclosure, /could not be read/);
    assertForcedReadOnlyArm(runResult.payload.confinement.disclosure, probe, `run --json, probe ${probe}`);
  }
});

test("a write run passes no sandbox when Landlock is absent", () => {
  const write = launch("run", ["--write", "--json"], "change this", { probe: "absent", json: true });
  assert.equal(write.result.status, 0, write.result.stderr);
  assert.equal(write.argv.length, 1);
  assert.equal(sandboxOf(write.argv[0]), null);
  assert.equal(write.payload.confinement.mode, "write");
  assert.deepEqual(write.payload.confinement.layers, []);
  assert.equal(write.payload.confinement.kernelSandbox, "not-requested");
});

test("a forced probe never records enforced and says the host was not probed", () => {
  const savedProbe = process.env.GROK_CC_LANDLOCK_PROBE;
  const savedPlatform = process.env.GROK_CC_CONFINEMENT_PLATFORM;
  const restore = () => {
    if (savedProbe == null) delete process.env.GROK_CC_LANDLOCK_PROBE;
    else process.env.GROK_CC_LANDLOCK_PROBE = savedProbe;
    if (savedPlatform == null) delete process.env.GROK_CC_CONFINEMENT_PLATFORM;
    else process.env.GROK_CC_CONFINEMENT_PLATFORM = savedPlatform;
  };
  const note = (probe) => new RegExp(
    `The answer was forced by GROK_CC_LANDLOCK_PROBE=${probe} and the host was not probed`
  );
  try {
    process.env.GROK_CC_CONFINEMENT_PLATFORM = "linux";
    for (const probe of ["present", "absent", "unknown"]) {
      process.env.GROK_CC_LANDLOCK_PROBE = probe;
      const record = describeConfinement(false);
      assert.notEqual(record.kernelSandbox, "enforced", probe);
      assert.match(record.disclosure, note(probe), probe);
      assert.doesNotMatch(record.disclosure, /Landlock is not among the active LSMs/, probe);
      assert.doesNotMatch(record.disclosure, /could not be read/, probe);
      // On Linux the probe decides; the platform note belongs to the other platforms.
      assert.doesNotMatch(record.disclosure, /GROK_CC_CONFINEMENT_PLATFORM/, probe);
      if (probe === "absent") {
        assert.equal(record.kernelSandbox, "not-requested", probe);
        assertForcedOffArm(record.disclosure, probe);
      } else {
        assert.equal(record.kernelSandbox, "unverified", probe);
        assert.ok(!record.layers.includes("sandbox"), probe);
        assertForcedReadOnlyArm(record.disclosure, probe, probe);
      }
      const connector = describeConnectorConfinement(["google_calendar"]);
      assert.notEqual(connector.kernelSandbox, "enforced", probe);
      assert.match(connector.disclosure, note(probe), probe);
    }

    // An injected impl is a supplied probe result. The env override must not erase it.
    process.env.GROK_CC_LANDLOCK_PROBE = "absent";
    const injected = describeConfinement(false, "linux", () => "present");
    assert.equal(injected.kernelSandbox, "enforced");
    assert.equal(injected.disclosure, null);
    assert.ok(injected.layers.includes("sandbox"));

    // Off Linux the probe decides nothing, so "forced by the probe"
    // would name a cause that does not exist. Where GROK_CC_CONFINEMENT_PLATFORM decided the
    // platform, the note names that variable and not the probe. These run on any host.
    const platformNote = (value) => new RegExp(
      `The answer was forced by GROK_CC_CONFINEMENT_PLATFORM=${value} and the host was not probed\\.`
    );
    for (const [forcedPlatform, kernelSandbox, hostSentence] of [
      ["win32", "requested-not-enforced", /not enforced on this platform/],
      ["darwin", "unverified", /unverified on macOS/]
    ]) {
      for (const probe of ["present", "absent", "unknown"]) {
        const label = `${forcedPlatform}/${probe}`;
        process.env.GROK_CC_LANDLOCK_PROBE = probe;
        process.env.GROK_CC_CONFINEMENT_PLATFORM = forcedPlatform;
        const forced = describeConfinement(false);
        assert.equal(forced.kernelSandbox, kernelSandbox, label);
        assert.match(forced.disclosure, hostSentence, label);
        assert.match(forced.disclosure, platformNote(forcedPlatform), label);
        assert.doesNotMatch(forced.disclosure, /GROK_CC_LANDLOCK_PROBE/, label);
        const forcedConnector = describeConnectorConfinement(["google_calendar"]);
        assert.match(forcedConnector.disclosure, platformNote(forcedPlatform), label);
        assert.doesNotMatch(forcedConnector.disclosure, /GROK_CC_LANDLOCK_PROBE/, label);

        // An explicit platform argument decides first, so the variable decided nothing.
        const explicit = describeConfinement(false, forcedPlatform);
        assert.equal(explicit.kernelSandbox, kernelSandbox, label);
        assert.match(explicit.disclosure, hostSentence, label);
        assert.doesNotMatch(explicit.disclosure, /GROK_CC_|forced by|not probed/, label);

        // The probe alone, with no platform variable, is not a platform override either.
        delete process.env.GROK_CC_CONFINEMENT_PLATFORM;
        const probeOnly = describeConfinement(false, forcedPlatform);
        assert.equal(probeOnly.kernelSandbox, kernelSandbox, label);
        assert.doesNotMatch(probeOnly.disclosure, /GROK_CC_|forced by|not probed/, label);
      }
    }

    // The explicit argument wins over a different platform variable, and then nothing was forced.
    process.env.GROK_CC_LANDLOCK_PROBE = "absent";
    process.env.GROK_CC_CONFINEMENT_PLATFORM = "darwin";
    const explicitWin32 = describeConfinement(false, "win32");
    assert.equal(explicitWin32.kernelSandbox, "requested-not-enforced");
    assert.match(explicitWin32.disclosure, /not enforced on this platform/);
    assert.doesNotMatch(explicitWin32.disclosure, /GROK_CC_|forced by|not probed/);

    // A platform variable without a probe override is ignored, so it cannot annotate a real run.
    // The stray value must differ from the host's own platform, or the
    // check cannot fail there. A fixed "darwin" is already the host's value on macOS, where an
    // honoured stray variable would change nothing. Every host but macOS runs the darwin
    // branch; only a macOS host runs the win32 one, and no run on another host exercises it.
    const strayPlatform = process.platform === "darwin" ? "win32" : "darwin";
    assert.notEqual(strayPlatform, process.platform);
    delete process.env.GROK_CC_LANDLOCK_PROBE;
    process.env.GROK_CC_CONFINEMENT_PLATFORM = strayPlatform;
    assert.deepEqual(describeConfinement(false), describeConfinement(false, process.platform));

    // Write mode does not consult the probe. Its disclosure must not claim the probe decided it.
    process.env.GROK_CC_LANDLOCK_PROBE = "absent";
    process.env.GROK_CC_CONFINEMENT_PLATFORM = "linux";
    const write = describeConfinement(true);
    assert.equal(write.kernelSandbox, "not-requested");
    assert.doesNotMatch(write.disclosure, /GROK_CC_LANDLOCK_PROBE/);
  } finally {
    restore();
  }
});

test("every disclosure arm is pinned as an exact string, and the connector record is the opening plus that string", () => {
  const savedProbe = process.env.GROK_CC_LANDLOCK_PROBE;
  const savedPlatform = process.env.GROK_CC_CONFINEMENT_PLATFORM;
  const restore = () => {
    if (savedProbe == null) delete process.env.GROK_CC_LANDLOCK_PROBE;
    else process.env.GROK_CC_LANDLOCK_PROBE = savedProbe;
    if (savedPlatform == null) delete process.env.GROK_CC_CONFINEMENT_PLATFORM;
    else process.env.GROK_CC_CONFINEMENT_PLATFORM = savedPlatform;
  };
  const connectors = ["google_calendar"];
  try {
    // (a) the unforced Landlock-absent arm: an injected impl, no env override.
    delete process.env.GROK_CC_LANDLOCK_PROBE;
    delete process.env.GROK_CC_CONFINEMENT_PLATFORM;
    assert.equal(
      describeConfinement(false, "linux", () => "absent").disclosure,
      EXPECTED_UNFORCED_ABSENT,
      "unforced absent"
    );
    assert.equal(
      describeConnectorConfinement(connectors, "linux", () => "absent").disclosure,
      `${CONNECTOR_OPENING} ${EXPECTED_UNFORCED_ABSENT}`,
      "unforced absent, connector"
    );

    // (b) the forced-off arm and (c) the forced read-only arm for present and unknown.
    process.env.GROK_CC_CONFINEMENT_PLATFORM = "linux";
    for (const [probe, expected] of [
      ["absent", EXPECTED_FORCED_OFF],
      ["present", EXPECTED_FORCED_READ_ONLY_PRESENT],
      ["unknown", EXPECTED_FORCED_READ_ONLY_UNKNOWN]
    ]) {
      process.env.GROK_CC_LANDLOCK_PROBE = probe;
      assert.equal(describeConfinement(false).disclosure, expected, `forced ${probe}`);
      assert.equal(
        describeConnectorConfinement(connectors).disclosure,
        `${CONNECTOR_OPENING} ${expected}`,
        `forced ${probe}, connector`
      );
    }

    // (d) the Windows and macOS disclosures with the platform note, probe set, no explicit
    // platform argument. The probe value does not change the text.
    for (const [platform, expected] of [
      ["win32", EXPECTED_FORCED_WIN32],
      ["darwin", EXPECTED_FORCED_DARWIN]
    ]) {
      for (const probe of ["present", "absent", "unknown"]) {
        process.env.GROK_CC_LANDLOCK_PROBE = probe;
        process.env.GROK_CC_CONFINEMENT_PLATFORM = platform;
        assert.equal(describeConfinement(false).disclosure, expected, `forced ${platform}/${probe}`);
        assert.equal(
          describeConnectorConfinement(connectors).disclosure,
          `${CONNECTOR_OPENING} ${expected}`,
          `forced ${platform}/${probe}, connector`
        );
      }
    }
  } finally {
    restore();
  }
});

test("the absent probe does not flip a non-linux host", (t) => {
  if (process.platform === "linux") {
    t.skip("this host is Linux, so an absent probe is the real branch");
    return;
  }
  const runResult = launch("run", ["--json"], "say nothing", { probe: "absent", platform: null, json: true });
  assert.equal(sandboxOf(runResult.argv[0]), "read-only");
  assert.notEqual(runResult.payload.confinement.kernelSandbox, "not-requested");
  // The probe decides nothing here and no platform variable is set,
  // so the record carries no forced-answer note at all.
  assert.doesNotMatch(runResult.payload.confinement.disclosure, /GROK_CC_|forced by|not probed/);
});

test("a forced platform override annotates a launched record and names the platform variable", () => {
  for (const [forcedPlatform, kernelSandbox] of [
    ["win32", "requested-not-enforced"],
    ["darwin", "unverified"]
  ]) {
    const forced = launch("run", ["--json"], "say nothing", {
      probe: "absent",
      platform: forcedPlatform,
      json: true
    });
    assert.equal(forced.result.status, 0, forced.result.stderr);
    assert.equal(sandboxOf(forced.argv[0]), "read-only", forcedPlatform);
    assert.equal(forced.payload.confinement.kernelSandbox, kernelSandbox, forcedPlatform);
    assert.match(
      forced.payload.confinement.disclosure,
      new RegExp(`The answer was forced by GROK_CC_CONFINEMENT_PLATFORM=${forcedPlatform} and the host was not probed\\.`),
      forcedPlatform
    );
    assert.doesNotMatch(forced.payload.confinement.disclosure, /GROK_CC_LANDLOCK_PROBE/, forcedPlatform);
  }
});
