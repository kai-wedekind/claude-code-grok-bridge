// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  clearDisabledFlag,
  loadState,
  readDisabledFlag,
  resolveDisabledFlagPath,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeDisabledFlag
} from "../plugins/grok-build/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  // The fallback root only applies when CLAUDE_PLUGIN_DATA is absent; the test must
  // control that rather than inherit whatever the developer's shell exports.
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, /grok-cc-runs/);
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: {},
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("loadState quarantines corrupt state, recovers, and says so instead of wiping", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{not-json", "utf8");

  // This used to throw. Throwing did stop a silent wipe, but it also made every
  // command fail — including the ones an operator would use to see what happened, and
  // it left running work untracked. The wipe concern is now met by rebuilding from the
  // per-job files and saying out loud that the index was corrupt.
  const notices = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    notices.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  let state;
  try {
    state = loadState(workspace);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(state, "a corrupt index must not make the workspace unusable");
  assert.match(notices.join(""), /corrupt|quarantin/i, "the corruption must be reported");

  const dirEntries = fs.readdirSync(path.dirname(stateFile));
  assert.ok(dirEntries.some((name) => name.startsWith("state.json.corrupt-")));
});

test("loadState returns default state when the file is missing", () => {
  const workspace = makeTempDir();
  const state = loadState(workspace);
  assert.equal(state.version, 1);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.config, {});
});

function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A plugin data directory AND a private kill-switch flag path, so no test touches the real home.
function withPluginDataDir(pluginDataDir, fn) {
  return withEnv(
    {
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      GROK_CC_DISABLED_FLAG: path.join(pluginDataDir, "home", ".grok-cc", "disabled.json")
    },
    fn
  );
}

test("readDisabledFlag returns null when nothing was ever disabled", () => {
  withPluginDataDir(makeTempDir(), () => {
    assert.equal(readDisabledFlag(), null);
  });
});

test("writeDisabledFlag then readDisabledFlag round-trips the reason and a timestamp", () => {
  withPluginDataDir(makeTempDir(), () => {
    const before = Date.now();
    const written = writeDisabledFlag("weekly allowance exhausted");
    assert.equal(written.reason, "weekly allowance exhausted");
    assert.ok(Date.parse(written.disabledAt) >= before, "disabledAt should be a real, current timestamp");

    const read = readDisabledFlag();
    assert.equal(read.reason, written.reason);
    assert.equal(read.disabledAt, written.disabledAt);
    assert.equal(written.path, resolveDisabledFlagPath(), "disable must say where the flag is");
  });
});

test("the flag does not depend on CLAUDE_PLUGIN_DATA: a shell without it and the plugin agree", () => {
  // A flag in the state root would make `disable` from a shell without the variable write a
  // file the plugin never reads, and the plugin would keep spending.
  const flag = path.join(makeTempDir(), ".grok-cc", "disabled.json");
  withEnv({ GROK_CC_DISABLED_FLAG: flag, CLAUDE_PLUGIN_DATA: undefined }, () => {
    writeDisabledFlag("allowance exhausted");
  });
  withEnv({ GROK_CC_DISABLED_FLAG: flag, CLAUDE_PLUGIN_DATA: makeTempDir() }, () => {
    assert.equal(readDisabledFlag()?.reason, "allowance exhausted");
  });
});

test("a flag under the state root is not the kill switch", () => {
  // The bridge writes no flag there, and reading one would make `enable` delete a file the
  // current flag does not own.
  withPluginDataDir(makeTempDir(), () => {
    const legacy = path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "disabled.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ reason: "old build", disabledAt: "2026-09-06T00:00:00Z" }));
    assert.equal(readDisabledFlag(), null);
    assert.equal(clearDisabledFlag(), false);
    assert.equal(fs.existsSync(legacy), true);
  });
});

test("a leading ~/ in GROK_CC_DISABLED_FLAG expands to the home directory", () => {
  // chdir so an unexpanded `~` (path.resolve against the cwd) cannot land in the repo.
  const home = makeTempDir();
  const scratch = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(scratch);
  try {
    withEnv(
      {
        USERPROFILE: home,
        HOME: home,
        GROK_CC_DISABLED_FLAG: "~/ks-flag.json",
        CLAUDE_PLUGIN_DATA: undefined
      },
      () => {
        const expected = path.join(home, "ks-flag.json");
        const written = writeDisabledFlag("tilde");
        assert.equal(path.resolve(written.path), path.resolve(expected));
        assert.equal(readDisabledFlag()?.reason, "tilde");
        assert.equal(fs.existsSync(expected), true);
      }
    );
  } finally {
    process.chdir(previousCwd);
  }
});

// Pins the `~` and `~\` branches of expandLeadingHome. Only the
// resolved path is read, nothing is written, so the temp "home" stays the only path touched.
test("a bare ~ in GROK_CC_DISABLED_FLAG resolves to the home directory itself", () => {
  const home = makeTempDir();
  withEnv({ USERPROFILE: home, HOME: home, GROK_CC_DISABLED_FLAG: "~", CLAUDE_PLUGIN_DATA: undefined }, () => {
    assert.equal(resolveDisabledFlagPath(), path.resolve(home));
  });
});

test("a leading ~\\ in GROK_CC_DISABLED_FLAG expands to the home directory", () => {
  const home = makeTempDir();
  withEnv(
    { USERPROFILE: home, HOME: home, GROK_CC_DISABLED_FLAG: "~\\ks-flag.json", CLAUDE_PLUGIN_DATA: undefined },
    () => {
      assert.equal(resolveDisabledFlagPath(), path.resolve(path.join(home, "ks-flag.json")));
    }
  );
});

test("a relative GROK_CC_DISABLED_FLAG fails closed and is not resolved against the cwd", () => {
  const scratch = makeTempDir();
  const previousCwd = process.cwd();
  process.chdir(scratch);
  const relative = "rel/disabled.json";
  try {
    withEnv({ GROK_CC_DISABLED_FLAG: relative, CLAUDE_PLUGIN_DATA: undefined }, () => {
      const flag = readDisabledFlag();
      assert.equal(flag?.disabledAt, "unknown");
      assert.match(flag?.reason ?? "", /GROK_CC_DISABLED_FLAG must be an absolute path/);
      assert.match(flag?.reason ?? "", /rel\/disabled\.json/);
      assert.throws(
        () => writeDisabledFlag("nope"),
        (error) => {
          assert.equal(error.message, flag.reason);
          return true;
        }
      );
      assert.throws(() => clearDisabledFlag(), (error) => {
        assert.equal(error.message, flag.reason);
        return true;
      });
    });
    assert.equal(fs.existsSync(path.join(scratch, "rel", "disabled.json")), false);
  } finally {
    process.chdir(previousCwd);
  }
});

test("an absolute GROK_CC_DISABLED_FLAG is used as given", () => {
  const flag = path.join(makeTempDir(), "disabled.json");
  withEnv({ GROK_CC_DISABLED_FLAG: flag }, () => {
    assert.equal(resolveDisabledFlagPath(), path.resolve(flag));
    writeDisabledFlag("absolute");
    assert.equal(readDisabledFlag()?.reason, "absolute");
    assert.equal(clearDisabledFlag(), true);
    assert.equal(readDisabledFlag(), null);
  });
});

test("a flag file of the wrong shape, or one that cannot be read, fails CLOSED", () => {
  for (const content of ["{}", JSON.stringify({ reason: "only a reason" }), "null", "[]"]) {
    withPluginDataDir(makeTempDir(), () => {
      const flagPath = resolveDisabledFlagPath();
      fs.mkdirSync(path.dirname(flagPath), { recursive: true });
      fs.writeFileSync(flagPath, content);
      assert.match(readDisabledFlag()?.reason ?? "", /not a valid flag record/, content);
    });
  }
  withPluginDataDir(makeTempDir(), () => {
    // A directory where the file should be: readable as neither, so it must count as disabled.
    fs.mkdirSync(resolveDisabledFlagPath(), { recursive: true });
    assert.match(readDisabledFlag()?.reason ?? "", /could not be read/);
  });
});

test("clearDisabledFlag removes the flag and reports whether one existed", () => {
  withPluginDataDir(makeTempDir(), () => {
    assert.equal(clearDisabledFlag(), false, "nothing to clear yet");
    writeDisabledFlag("test");
    assert.equal(clearDisabledFlag(), true, "a flag existed and was removed");
    assert.equal(readDisabledFlag(), null);
    assert.equal(clearDisabledFlag(), false, "clearing twice is not an error");
  });
});

test("a corrupted disabled-flag file fails CLOSED, not open", () => {
  // ⚠ The one case worth its own test: an unparseable flag file must read as disabled, never
  // as "not disabled" — a half-written or corrupted file must not silently re-enable spending.
  withPluginDataDir(makeTempDir(), () => {
    const flagPath = resolveDisabledFlagPath();
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(flagPath, "{ not valid json");

    const flag = readDisabledFlag();
    assert.ok(flag, "a corrupt flag file must still read as disabled");
    assert.match(flag.reason, /could not be parsed/i);
  });
});
