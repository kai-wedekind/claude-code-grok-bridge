/**
 * A skill named in the documentation has to be a skill that exists.
 *
 * Claude Code addresses a plugin skill as `<plugin>:<skill>`, where `<skill>` is the `name`
 * in the skill's own front matter. Nothing rewrites that name, so the qualified form is
 * mechanical — and therefore checkable.
 *
 * It was wrong in four places at once. The routing skill declares `name: grok-routing`
 * inside plugin `grok-build`, making it `grok-build:grok-routing`; README, both halves of
 * docs/ADOPTION.md and the skill's own closing paragraph all said `grok-build:routing`, and
 * no file anywhere said the real name. One of the four is the block a user pastes into their
 * `CLAUDE.md` — so the single line whose entire job is to name the trigger named nothing.
 *
 * That is the specific shape worth guarding: documentation that instructs a *reader* to do
 * something is not covered by tests that check documentation against *behaviour*. The
 * existing documented-contract test reads only README.md, so ADOPTION.md and every shipped
 * SKILL.md were pinned by nothing at all.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(REPO, "plugins", "grok-build");
const SKILLS_DIR = path.join(PLUGIN_DIR, "skills");

/** Front-matter `name:` — the second half of the qualified id, not the directory. */
function declaredSkillName(skillDir) {
  const body = fs.readFileSync(path.join(SKILLS_DIR, skillDir, "SKILL.md"), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  assert.ok(match, `${skillDir}/SKILL.md must open with YAML front matter`);
  const name = /^name:\s*(\S+)\s*$/m.exec(match[1]);
  assert.ok(name, `${skillDir}/SKILL.md front matter must declare a name`);
  return name[1];
}

function pluginName() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")
  );
  return manifest.name;
}

/** Every tracked text file that could name a skill, read once. */
function documentationFiles() {
  const roots = [
    REPO,
    path.join(REPO, "docs"),
    ...fs.readdirSync(SKILLS_DIR).map((d) => path.join(SKILLS_DIR, d))
  ];
  const files = [];
  for (const dir of roots) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

/**
 * Everything addressable as `grok-build:<name>`. The namespace is shared by three kinds of
 * surface, which is exactly why the wrong skill name looked plausible: `grok-build:review`
 * really does exist, so the shape of `grok-build:routing` read as correct.
 */
function shippedSurfaces() {
  const dropExtension = (file) => file.replace(/\.md$/, "");
  const fromDir = (dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map(dropExtension) : [];

  return new Set([
    ...fs.readdirSync(SKILLS_DIR).map(declaredSkillName),
    ...fromDir(path.join(PLUGIN_DIR, "commands")),
    ...fromDir(path.join(PLUGIN_DIR, "agents"))
  ]);
}

test("every documented plugin:name reference resolves to something that ships", () => {
  const plugin = pluginName();
  const shipped = shippedSurfaces();

  // Deliberately anchored to the real plugin name rather than a generic `\w+:\w+`, which
  // would sweep up prose like "Note: something" and force the pattern to grow exceptions.
  const reference = new RegExp(`\\b${plugin}:([a-z0-9][a-z0-9-]*)\\b`, "g");

  const bad = new Set();
  for (const file of documentationFiles()) {
    const body = fs.readFileSync(file, "utf8");
    for (const [, name] of body.matchAll(reference)) {
      if (!shipped.has(name)) {
        bad.add(`${path.relative(REPO, file)} names ${plugin}:${name}`);
      }
    }
  }

  assert.deepEqual(
    [...bad].sort(),
    [],
    `documentation names surfaces that do not ship. Shipped: ${[...shipped].sort().join(", ")}`
  );
});

test("the routing skill is reachable under the name the paste-block tells users to load", () => {
  // The regression that prompted this file, pinned directly rather than only through the
  // general sweep above — this is the one line whose failure is silent for the user.
  const adoption = fs.readFileSync(path.join(REPO, "docs", "ADOPTION.md"), "utf8");
  const qualified = `${pluginName()}:${declaredSkillName("grok-routing")}`;

  assert.equal(qualified, "grok-build:grok-routing");
  assert.ok(
    adoption.includes(`load the skill \`${qualified}\``),
    "the CLAUDE.md paste-block must name the skill by its real qualified id"
  );
});

test("each shipped skill declares a name matching its directory", () => {
  // Not required by Claude Code, but every skill here already does it, and a mismatch is the
  // thing that made the wrong name look plausible in the first place.
  for (const dir of fs.readdirSync(SKILLS_DIR)) {
    assert.equal(declaredSkillName(dir), dir, `skills/${dir} declares a different name`);
  }
});
