/**
 * The publish gate against private data (scripts/check-private-data.mjs).
 *
 * A real user name in a path can take the backslash-eaten form that a plain path search
 * misses. These tests pin that every shape of that leak is caught, that placeholder names in
 * fixtures are not, and that the release mode refuses to run without the private deny-list.
 *
 * ⚠ Every sample below is ASSEMBLED at runtime. A literal home path, address or key in this file
 * would itself be private-looking data in the published tree — and the last test runs the gate
 * over the repository's own HEAD.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { GENERIC_RULES, loadDenylist, scanText, scanTree } from "../scripts/check-private-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-private-data.mjs");
const BS = "\\";
const USERS = ["C:", "Users"].join(BS);
const rules = (text) => scanText(text, GENERIC_RULES).map((f) => f.rule);
const HOME = "home path with a user name";

function denylistFile(content) {
  const file = path.join(makeTempDir(), "denylist.txt");
  fs.writeFileSync(file, content);
  return file;
}

function gate(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", ...options });
}

test("a home path with a real user name is caught in every shape the 0.3.3 leak took", () => {
  assert.deepEqual(rules(`see ${USERS}${BS}zed${BS}.claude${BS}x.jsonl`), [HOME]);
  assert.deepEqual(rules(`doubled ${USERS.replace(BS, BS + BS)}${BS}${BS}zed${BS}${BS}data`), [HOME]);
  assert.deepEqual(rules("eaten C:" + "Userszed-xAppDataLocalTemp"), ["backslash-eaten home path"]);
  assert.deepEqual(rules("posix /c/" + "Users/zed/project and /home/" + "zed/x"), [
    "POSIX home path with a user name",
    "POSIX home path with a user name"
  ]);
});

test("lower-case, forward-slash, JSON-escaped and spaced home paths are caught too", () => {
  // Lower-case `users`, a forward slash, four backslashes (a JSON string written into JSON), and
  // a name with a space when a separator follows it.
  assert.deepEqual(rules("d:" + BS + "users" + BS + "zed" + BS + "x"), [HOME]);
  assert.deepEqual(rules("C:/" + "Users/zed/x"), [HOME], "one finding, not also a POSIX one");
  assert.deepEqual(rules("C:" + BS.repeat(4) + "Users" + BS.repeat(4) + "zed"), [HOME]);
  assert.deepEqual(rules(`${USERS}${BS}Zed Quill${BS}data`), [HOME]);
  assert.deepEqual(rules("/C/" + "users/zed/x"), ["POSIX home path with a user name"]);
  assert.deepEqual(rules("/Home/" + "zed/x"), ["POSIX home path with a user name"]);
  assert.deepEqual(rules(`${USERS}/zed/x`), [HOME], "a backslash then a slash is the same path");
  assert.deepEqual(rules("aws_secret_access_key = " + "Q7vK2mP9xL4nR8tW3yZ6bH1cD5fG8jK0mN2pR4sT"), ["credential"]);
  // The eaten form accepts a placeholder only when what follows is plainly the next segment.
  assert.deepEqual(rules("C:" + "Usersyou" + "rname"), ["backslash-eaten home path"]);
  assert.deepEqual(rules("C:" + "Usersme" + "lanieAppData"), ["backslash-eaten home path"]);
  assert.deepEqual(rules(`link ${["169", "254", "1", "2"].join(".")}`), ["private or link-local IPv4 address"]);
  assert.deepEqual(rules(`ula ${["fd12", "3456", "", "1"].join(":")} and ${["fe80", "", "1"].join(":")}`), [
    "private or link-local IPv6 address",
    "private or link-local IPv6 address"
  ]);
  assert.deepEqual(rules("auth BEARER " + "Q7vK2mP9xL4nR8tW3yZ6bH1cD5"), ["credential"]);
  const jwt = ["eyJ" + "hbGciOiJIUzI1", "eyJ" + "zdWIiOiJxNzQ", "Q7vK2mP9xL4n"].join(".");
  assert.deepEqual(rules(`token ${jwt}`), ["credential"]);
  // A real-looking token is not excused by containing an innocent word.
  assert.deepEqual(rules("key sk-" + "testQ7vK2mP9xL4nR8tW3yZ6"), ["credential"]);
});

test("placeholder names in fixtures and docs are not findings", () => {
  for (const name of ["someone", "John Smith", "test", "<user>", "..."]) {
    assert.deepEqual(rules(`${USERS}${BS}${name}${BS}data`), [], name);
  }
  assert.deepEqual(rules(`${USERS}${BS}me then more words`), [], "prose after a path is not part of the name");
  assert.deepEqual(rules("C:" + "Usersmeapp and C:" + "Usersyou..."), []);
  assert.deepEqual(rules("/c/" + "Users/.../x"), []);
  assert.deepEqual(rules("https://api.github.com/" + "users/octocat"), [], "a URL segment is not a home");
});

test("addresses, private networks and credentials are caught; examples and dummies are not", () => {
  assert.deepEqual(rules(`mail ${"someone.real"}@${"mailhost"}.de`), ["e-mail address"]);
  assert.deepEqual(rules(`ok ${"t"}@example.invalid and ${"1"}+x@users.noreply.github.com`), []);
  assert.deepEqual(rules(`lan ${["192", "168", "0", "24"].join(".")}`), ["private or link-local IPv4 address"]);
  assert.deepEqual(rules(`loopback ${["127", "0", "0", "1"].join(".")}`), []);
  const realLooking = "sk-" + "Q7vK2mP9xL4nR8tW3yZ6bH1c";
  const found = scanText(`key ${realLooking}`, GENERIC_RULES);
  assert.deepEqual(found.map((f) => f.rule), ["credential"]);
  assert.ok(!found[0].excerpt.includes("Q7vK2m"), "a credential must never be echoed in full");
  assert.deepEqual(rules("key sk-" + "abcdefghijklmnopqrstuvwxyz"), [], "an obvious fixture is not a credential");
});

test("every finding is masked, not only credentials", () => {
  const found = scanText(`see ${USERS}${BS}zedquill${BS}x and ${"someone.real"}@${"mailhost"}.de`, GENERIC_RULES);
  assert.equal(found.length, 2);
  for (const f of found) {
    assert.ok(!f.excerpt.includes("zedquill") && !f.excerpt.includes("someone.real"), f.excerpt);
  }
});

test("deny-list entries are matched case-insensitively and never echoed in full", () => {
  const found = scanText("a line with ZZ-Private-Marker in it", loadDenylist(denylistFile("# comment\n\nzz-private-marker\n")));
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, "private identifier");
  assert.equal(found[0].excerpt, "ZZ-…(17)");
});

test("an invalid deny-list line is reported by number, never by content", () => {
  const result = gate(["--message", denylistFile("x\n"), "--denylist", denylistFile("ok\nzz-secret-(\n")]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /line 2 is not a valid regular expression/);
  assert.doesNotMatch(result.stderr, /zz-secret/);
});

test("the release mode refuses to run without a deny-list, or with one that has no rules", () => {
  const none = gate(["--require-denylist"]);
  assert.equal(none.status, 3, none.stderr);
  assert.match(none.stderr, /no deny-list rules loaded/);

  const missing = gate(["--require-denylist", "--denylist", path.join(makeTempDir(), "absent.txt")]);
  assert.equal(missing.status, 3, missing.stderr);

  // A list of only comments and blank lines does not pass the release mode.
  const empty = gate(["--require-denylist", "--denylist", denylistFile("# nothing yet\n\n")]);
  assert.equal(empty.status, 3, empty.stderr);
});

test("a missing option value is a usage error, not a check of something else", () => {
  for (const args of [["--tree"], ["--denylist"], ["--message"], ["--tree", "--require-denylist"]]) {
    const result = gate(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  }
});

test("reached through a symlink or junction, the gate still runs and reports", (t) => {
  // node resolves the main module to its real path but leaves argv[1] as typed; a plain
  // comparison skipped main() and exited 0 without a word.
  const dir = makeTempDir();
  const link = path.join(dir, "scripts-link");
  try {
    fs.symlinkSync(path.dirname(SCRIPT), link, "junction");
  } catch (error) {
    t.skip(`cannot create a link here (${error.code})`);
    return;
  }
  const run = (content) =>
    spawnSync(process.execPath, [path.join(link, "check-private-data.mjs"), "--message", denylistFile(content)], {
      cwd: ROOT,
      encoding: "utf8"
    });
  const clean = run("clean\n");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /no private data found/, "a pass must say so; silence is not a result");
  const dirty = run(`on ${USERS}${BS}zed${BS}x\n`);
  assert.equal(dirty.status, 1, "through the link, a finding must still fail the gate");
});

test("a commit or tag message file is checked with the same rules", () => {
  const message = denylistFile(`Release notes\n\nMeasured on ${USERS}${BS}zed${BS}project.\n`);
  const result = gate(["--message", message]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /message .*:3: home path with a user name/);
});

test("file names and UTF-16 files in a tree are scanned, a non-UTF-16 NUL is still scanned", () => {
  const repo = makeTempDir();
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  initGitRepo(repo);
  git("config", "core.autocrlf", "false");
  const namedDir = path.join(repo, "logs", "zed" + "quill-at-" + "mailhost.de");
  fs.mkdirSync(namedDir, { recursive: true });
  fs.writeFileSync(path.join(namedDir, "clean.txt"), "nothing here\n");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`path ${USERS}${BS}zed${BS}x\n`, "utf16le")]);
  fs.writeFileSync(path.join(repo, "notes-utf16.txt"), utf16);
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x10, 0x00]));
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  const denyRules = loadDenylist(denylistFile("zedquill\n"));
  const { findings, lossy } = scanTree("HEAD", [...GENERIC_RULES, ...denyRules], repo);
  const byPath = findings.map((f) => `${f.path}:${f.line}:${f.rule}`);
  assert.ok(byPath.some((p) => p.startsWith("logs/zed") && p.endsWith(":0:private identifier")), byPath.join("\n"));
  assert.ok(byPath.includes(`notes-utf16.txt:1:${HOME}`), byPath.join("\n"));
  // The blob has NULs and is not UTF-16. It is scanned as lossy UTF-8, not skipped.
  assert.equal(lossy, 1);
  assert.ok(!byPath.some((p) => p.startsWith("blob.bin:")), byPath.join("\n"));
});

test("the repository's own HEAD tree passes the generic rules", () => {
  assert.deepEqual(scanTree("HEAD", GENERIC_RULES, ROOT).findings, []);
});

function utf16Bytes(text, { bom = true, be = false } = {}) {
  let body = Buffer.from(text, "utf16le");
  if (be) body = Buffer.from(body).swap16();
  if (!bom) return body;
  const mark = Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]);
  return Buffer.concat([mark, body]);
}

function writeBytes(name, bytes) {
  const file = path.join(makeTempDir(), name);
  fs.writeFileSync(file, bytes);
  return file;
}

test("a short match reveals at most floor(length/4) characters, never more than 3", () => {
  const three = scanText("see abc here", loadDenylist(denylistFile("abc\n")));
  assert.equal(three[0].excerpt, "…(3)");
  assert.ok(!three[0].excerpt.includes("abc"));
  const eight = scanText("see zedquill here", loadDenylist(denylistFile("zedquill\n")));
  assert.equal(eight[0].excerpt, "ze…(8)");
  const sixteen = "n".repeat(16);
  const long = scanText(`see ${sixteen} here`, loadDenylist(denylistFile(`${sixteen}\n`)));
  assert.equal(long[0].excerpt, "nnn…(16)");
});

test("UTF-16 deny-lists are decoded, including a BOM-less line appended to UTF-8", () => {
  const marker = ["zz", "gate", "marker"].join("-");
  const added = ["zz", "added", "marker"].join("-");
  const clean = denylistFile("nothing to see\n");
  const encodings = [
    ["LE with BOM", utf16Bytes(`${marker}\r\n`)],
    ["LE without BOM", utf16Bytes(`${marker}\r\n`, { bom: false })],
    ["BE with BOM", utf16Bytes(`${marker}\r\n`, { be: true })],
    ["BE without BOM", utf16Bytes(`${marker}\r\n`, { bom: false, be: true })]
  ];
  for (const [label, bytes] of encodings) {
    const list = writeBytes("denylist.txt", bytes);
    const result = gate(["--message", denylistFile(`token ${marker}\n`), "--denylist", list, "--require-denylist"]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /private identifier/, label);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(marker), label);
  }

  // PowerShell 5.1 `>>` appends BOM-less UTF-16LE onto a UTF-8 list. Both rules have to fire.
  const mixed = Buffer.concat([
    Buffer.from(`${marker}\n`, "utf8"),
    utf16Bytes(`${added}\r\n`, { bom: false })
  ]);
  const mixedList = writeBytes("appended.txt", mixed);
  const foundAdded = gate(["--message", denylistFile(`token ${added}\n`), "--denylist", mixedList, "--require-denylist"]);
  assert.equal(foundAdded.status, 1, foundAdded.stdout + foundAdded.stderr);
  assert.match(foundAdded.stdout, /private identifier/);
  const foundKept = gate(["--message", denylistFile(`token ${marker}\n`), "--denylist", mixedList, "--require-denylist"]);
  assert.equal(foundKept.status, 1, foundKept.stdout + foundKept.stderr);

  const comments = writeBytes("comments.txt", utf16Bytes("# only a comment\r\n\r\n"));
  const empty = gate(["--message", clean, "--denylist", comments, "--require-denylist"]);
  assert.equal(empty.status, 3, empty.stderr);
  assert.match(empty.stderr, /no deny-list rules loaded/);
  assert.doesNotMatch(empty.stderr, /deny-list rules\)/);
});

// A `>>` tail that fills 90% of the first 8192 bytes makes the whole list look like UTF-16;
// the original rules, and at an odd prefix length the appended ones too, must still match.
test("a long UTF-16LE tail appended to a UTF-8 deny-list keeps both parts as rules", () => {
  const original = ["zz", "original", "marker"].join("-");
  const appended = ["zz", "appended", "marker"].join("-");
  const tail = utf16Bytes(
    [appended, ...Array.from({ length: 400 }, (_, i) => `zz-tail-rule-${i}`)].join("\r\n") + "\r\n",
    { bom: false }
  );
  const caught = (list, marker, label) => {
    const result = gate(["--message", denylistFile(`token ${marker}\n`), "--denylist", list, "--require-denylist"]);
    assert.equal(result.status, 1, `${label}, ${marker}: ${result.stdout}${result.stderr}`);
  };
  // Odd and even head lengths: an odd one shifts the UTF-16 alignment of the tail.
  for (const prefix of [20, 100, 400, 401, 800]) {
    const body = `${original}\n`;
    const pad = prefix - Buffer.byteLength(body);
    const head = `${"#".repeat(pad - 1)}\n${body}`;
    assert.equal(Buffer.byteLength(head), prefix);
    const list = writeBytes("grown.txt", Buffer.concat([Buffer.from(head, "utf8"), tail]));
    caught(list, original, `prefix ${prefix}`);
    caught(list, appended, `prefix ${prefix}`);
  }
  // `>>` onto a list whose last line has no newline continues that line.
  const joined = writeBytes("joined.txt", Buffer.concat([Buffer.from(`# list\n${original}\n# end`, "utf8"), tail]));
  caught(joined, original, "no trailing newline");
  // A pure BOM-less UTF-16LE list whose first line is empty still decodes as one part.
  const pure = writeBytes("pure.txt", utf16Bytes(`\r\n${original}\r\n`, { bom: false }));
  caught(pure, original, "pure LE, empty first line");
});

// A pure BOM-less UTF-16 file whose first character is above U+00FF has its first NUL after
// that character. A split that cut there would fail open where the whole-file reading decodes
// the file right.
test("a pure BOM-less UTF-16 file that starts above U+00FF is not split as if it had a UTF-8 head", () => {
  const filler = Array.from({ length: 200 }, (_, i) => `zz-filler-rule-${i}`).join("\r\n") + "\r\n";
  const firsts = { stroke: "Łukasz", cyrillic: "Привет", cjk: "日本" };
  for (const [label, word] of Object.entries(firsts)) {
    const rule = `${word}-zz-rule`;
    for (const be of [false, true]) {
      const shape = `${label} ${be ? "BE" : "LE"}`;
      const list = writeBytes("pure.txt", utf16Bytes(`${rule}\r\n${filler}`, { bom: false, be }));
      const listed = gate(["--message", denylistFile(`token ${rule}\n`), "--denylist", list, "--require-denylist"]);
      assert.equal(listed.status, 1, `${shape} deny-list: ${listed.stdout}${listed.stderr}`);
      const message = writeBytes("message.txt", utf16Bytes(`${word} wrote this.\r\n${filler}`, { bom: false, be }));
      const scanned = gate(["--message", message, "--denylist", denylistFile(`${word}\n`), "--require-denylist"]);
      assert.equal(scanned.status, 1, `${shape} message: ${scanned.stdout}${scanned.stderr}`);
    }
  }
});

// Some shapes beat every head test: one Gurmukhi or Gujarati first character (its BE high byte
// 0x0A reads as a clean line break) and a long run of kana. The gate therefore scans both
// readings instead of choosing.
test("when the bytes admit two readings, a finding in either one counts", () => {
  const filler = Array.from({ length: 200 }, (_, i) => `zz-filler-rule-${i}`).join("\r\n") + "\r\n";
  const gujarati = "ક";
  const kana = "あいうえおかきくけこさ";
  const rule = `${gujarati}hello-zz-rule`;
  const list = writeBytes("pure.txt", utf16Bytes(`${rule}\r\n${filler}`, { bom: false, be: true }));
  const listed = gate(["--message", denylistFile(`token ${rule}\n`), "--denylist", list, "--require-denylist"]);
  assert.equal(listed.status, 1, `BE deny-list with a Gujarati first rule: ${listed.stdout}${listed.stderr}`);
  for (const [label, word, be] of [["BE Gujarati", `${gujarati}hello`, true], ["LE kana", kana, false], ["BE kana", kana, true]]) {
    const message = writeBytes("message.txt", utf16Bytes(`${word} wrote this.\r\n${filler}`, { bom: false, be }));
    const scanned = gate(["--message", message, "--denylist", denylistFile(`${word}\n`), "--require-denylist"]);
    assert.equal(scanned.status, 1, `${label} message: ${scanned.stdout}${scanned.stderr}`);
  }
  // A `>>`-grown list whose UTF-8 part has a control byte in a comment still has both parts.
  const original = ["zz", "original", "marker"].join("-");
  const appended = ["zz", "appended", "marker"].join("-");
  const grown = Buffer.concat([
    Buffer.from(`# list \u001b[0m\n${original}\n`, "utf8"),
    utf16Bytes(`${appended}\r\nzz-two\r\nzz-three\r\n`, { bom: false })
  ]);
  const grownList = writeBytes("grown.txt", grown);
  for (const marker of [original, appended]) {
    const result = gate(["--message", denylistFile(`token ${marker}\n`), "--denylist", grownList, "--require-denylist"]);
    assert.equal(result.status, 1, `control byte in the UTF-8 part, ${marker}: ${result.stdout}${result.stderr}`);
  }
});

// A broken rule in the list's own (first) part must stop the release even when a long `>>`
// tail makes the whole file read as UTF-16 too, rather than land in the alternate reading only,
// where unusable lines are skipped.
test("a broken rule in front of a long UTF-16LE tail stops the release", () => {
  const tail = utf16Bytes(Array.from({ length: 500 }, (_, i) => `zz-tail-rule-${i}`).join("\r\n") + "\r\n", { bom: false });
  const ansiName = Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]); // cp1252, not UTF-8
  const shapes = {
    "cp1252 rule line": Buffer.concat([Buffer.from("# private list, kept as ANSI\n", "utf8"), ansiName, Buffer.from("\n", "utf8")]),
    "invalid expression": Buffer.from(`# list \u001b[0m\nzz-fine-rule\nbad(regex\n`, "utf8")
  };
  for (const [label, head] of Object.entries(shapes)) {
    const list = writeBytes("grown.txt", Buffer.concat([head, tail]));
    const result = gate(["--message", denylistFile("nothing here\n"), "--denylist", list, "--require-denylist"]);
    assert.equal(result.status, 3, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /could not use the deny-list: deny-list line \d+/, label);
  }
});

test("a UTF-16 tag message is scanned, and a message that is not text is exit 2 naming the file", () => {
  const marker = ["zz", "tag", "marker"].join("-");
  const encodings = [
    utf16Bytes(`notes\r\n\r\n${USERS}${BS}zed${BS}x and ${marker}\r\n`),
    utf16Bytes(`notes\r\n\r\n${USERS}${BS}zed${BS}x\r\n`, { bom: false }),
    utf16Bytes(`notes\r\n\r\n${USERS}${BS}zed${BS}x\r\n`, { be: true }),
    utf16Bytes(`notes\r\n\r\n${USERS}${BS}zed${BS}x\r\n`, { bom: false, be: true })
  ];
  for (const bytes of encodings) {
    const message = writeBytes("tag-message.txt", bytes);
    const result = gate(["--message", message, "--denylist", denylistFile(`${marker}\n`), "--require-denylist"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /message tag-message\.txt:/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /zed/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(marker));
  }

  const fakeUser = ["quill", "user"].join("");
  const binary = writeBytes("note.txt", Buffer.concat([Buffer.from(`hello ${fakeUser}\n`), Buffer.from([0x00, 0x01, 0xff])]));
  const undecodable = gate(["--message", binary]);
  assert.equal(undecodable.status, 2, undecodable.stderr);
  assert.match(undecodable.stderr, /could not decode message file note\.txt/);
  assert.doesNotMatch(`${undecodable.stdout}${undecodable.stderr}`, new RegExp(fakeUser));
});

test("an odd-length UTF-16BE blob does not throw, and a stray NUL does not hide a home path", () => {
  const odd = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x07]);
  const repo = makeTempDir();
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  initGitRepo(repo);
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "odd-be.bin"), odd);
  const withNul = Buffer.concat([Buffer.from(`see ${USERS}${BS}zed${BS}x\n`, "utf8"), Buffer.from([0x00])]);
  fs.writeFileSync(path.join(repo, "with-nul.txt"), withNul);
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  const { findings, lossy } = scanTree("HEAD", GENERIC_RULES, repo);
  assert.equal(lossy, 1);
  assert.ok(findings.some((f) => f.path === "with-nul.txt" && f.rule === HOME), findings.map((f) => f.path).join("\n"));
  assert.ok(!findings.some((f) => f.path === "odd-be.bin"));

  fs.mkdirSync(path.join(repo, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(repo, "scripts", "check-private-data.mjs"));
  const cli = spawnSync(process.execPath, [path.join(repo, "scripts", "check-private-data.mjs"), "--tree", "HEAD"], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /RangeError|16-bits/);
  assert.match(cli.stderr, /1 file\(s\) scanned as lossy UTF-8/);
});

test("a POSIX home path after a host, a PATH list or a drive letter is still a finding", () => {
  const name = "zed";
  const posix = "POSIX home path with a user name";
  for (const sample of [
    `scp f pi:/home/${name}/x`,
    `rsync x nas:/home/${name}/b`,
    `PATH=/usr/bin:/home/${name}/bin`,
    `docker -v /data:/home/${name}/x`,
    `file:/home/${name}/x`,
    `C:/home/${name}/x`
  ]) {
    assert.deepEqual(rules(sample), [posix], sample);
  }
  assert.deepEqual(rules(`C:/Users/${name}/x`), [HOME], "the Windows rule reports this once");
  assert.deepEqual(rules(`/Users/${"Alice Realname"}/x`), [posix]);
});

test("JSON-escaped slashes, Unicode names, spaced surnames, WSL and UNC shares are findings", () => {
  const jsonSlash = '"p":"C:' + BS + "/Users" + BS + "/zed" + BS + '/x"';
  assert.deepEqual(rules(jsonSlash), [HOME]);
  assert.deepEqual(rules(`${USERS}${BS}${"Özil"}${BS}x`), [HOME]);
  assert.deepEqual(rules("C:" + "Users" + "Özil"), ["backslash-eaten home path"]);
  assert.deepEqual(rules("USERPROFILE=" + USERS + BS + "John Brown"), [HOME]);
  assert.deepEqual(rules('"' + "C:" + BS + BS + "Users" + BS + BS + "Alice Wong" + '"'), [HOME]);
  assert.deepEqual(rules("`" + USERS + BS + "Bob Kowalski" + "`"), [HOME]);
  assert.deepEqual(rules(`${USERS}${BS}John Smith${BS}x`), [], "a known placeholder name stays clean");
  assert.deepEqual(rules(`${USERS}${BS}me then more words`), [], "lower-case prose stays clean");
  const wslDollar = ["", "", "wsl$", "Ubuntu", "home", "zed"].join(BS);
  const wslLocal = ["", "", "wsl.localhost", "Debian", "home", "zed"].join(BS);
  const unc = ["", "", "HOST", "c$", "Users", "zed"].join(BS);
  assert.deepEqual(rules(wslDollar), ["WSL home path with a user name"]);
  assert.deepEqual(rules(wslLocal), ["WSL home path with a user name"]);
  assert.deepEqual(rules(unc), ["UNC home path with a user name"]);
});

test("a long backslash-eaten run is judged in linear time and is still a finding", () => {
  const text = "C:" + "Usersme" + "appdata".repeat(40) + "x";
  const start = process.hrtime.bigint();
  const found = rules(text);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.deepEqual(found, ["backslash-eaten home path"]);
  assert.ok(ms < 100, `took ${ms} ms`);
});

// Every other UTF-16LE sample here carries ASCII or a CRLF, so its bytes hold NULs and a later
// branch would decode the file even without the BOM branch. Greek letters have no zero byte in
// UTF-16LE, and a BOM plus them and nothing else is the one input only the BOM branch decodes:
// without it the file reads as invalid UTF-8, the deny-list is refused (exit 3) and the message
// passes unseen (exit 0).
test("a UTF-16LE file with a BOM and no NUL byte in it is decoded", () => {
  const marker = "αβγδεζ";
  const bytes = utf16Bytes(marker);
  assert.equal(bytes.includes(0), false, "the fixture must contain no NUL, or another branch decodes it");

  const listed = gate(["--message", denylistFile(`token ${marker}\n`), "--denylist", writeBytes("greek-list.txt", bytes), "--require-denylist"]);
  assert.equal(listed.status, 1, `deny-list: ${listed.stdout}${listed.stderr}`);
  assert.match(listed.stdout, /private identifier/);

  const scanned = gate(["--message", writeBytes("greek-message.txt", bytes), "--denylist", denylistFile(`${marker}\n`), "--require-denylist"]);
  assert.equal(scanned.status, 1, `message: ${scanned.stdout}${scanned.stderr}`);
  assert.match(scanned.stdout, /message greek-message\.txt:1: private identifier/);
});

// A deny-list rule is the maintainer's own expression and can be anchored. Without the BOM
// strip, `^marker` never matches a message that starts with EF BB BF, which is what
// PowerShell 5.1 `Out-File` writes, and the gate passes it.
test("a UTF-8 BOM is stripped, so an anchored rule still matches the first line", () => {
  const marker = ["zz", "anchored", "marker"].join("-");
  const message = writeBytes("bom-message.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${marker} opens the message\n`, "utf8")]));
  const result = gate(["--message", message, "--denylist", denylistFile(`^${marker}\n`), "--require-denylist"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

// A backslash-eaten run made only of the placeholder name plus known segments is a placeholder
// at 700 characters; past the 1024 cap the walk is not attempted and the run is a finding,
// because a real eaten path is a handful of segments and a longer one must not be waved through
// as a fixture.
test("a backslash-eaten run past the length cap is a finding even when it is all placeholder segments", () => {
  const eaten = (segments) => "C:" + "Usersme" + "appdata".repeat(segments);
  assert.deepEqual(rules(eaten(100)), [], "700 characters of placeholder segments is a fixture");
  assert.deepEqual(rules(eaten(200)), ["backslash-eaten home path"], "1400 characters is past the cap");
});

test("an unusable deny-list is exit 3 under --require-denylist and exit 2 without it", () => {
  const message = denylistFile("clean\n");
  const bad = denylistFile("ok\nzz-secret-(\n");
  const dir = makeTempDir();
  const cases = [
    ["directory", ["--denylist", dir]],
    ["invalid rule", ["--denylist", bad]],
    ["unprintable rule", ["--denylist", writeBytes("nul.txt", Buffer.concat([Buffer.from("ok\n"), Buffer.from("zz\u0000\n")]))]],
    ["no rules", ["--denylist", denylistFile("# nothing yet\n\n")]]
  ];
  for (const [label, args] of cases) {
    const required = gate(["--message", message, ...args, "--require-denylist"]);
    assert.equal(required.status, 3, `${label} require: ${required.stderr}`);
    const plain = gate(["--message", message, ...args]);
    assert.equal(plain.status, 2, `${label} plain: ${plain.stderr}`);
    assert.doesNotMatch(`${required.stderr}${plain.stderr}`, /zz-secret|zz\u0000/);
  }
  const unprintable = gate(["--message", message, "--denylist", writeBytes("bad-enc.txt", Buffer.from("marker\u0000\n")), "--require-denylist"]);
  assert.match(unprintable.stderr, /line 1 contains an unprintable character — check the file's encoding/);
});

test("nothing the gate prints contains a deny-listed marker or a home-path user name", () => {
  const marker = ["zz", "print", "marker"].join("-");
  const fakeUser = ["quill", "user"].join("");
  const root = makeTempDir();
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo, "scripts", "check-private-data.mjs"));
  const script = path.join(repo, "scripts", "check-private-data.mjs");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  initGitRepo(repo);
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "readme.txt"), "clean\n");
  git("add", "readme.txt");
  git("commit", "-q", "-m", "clean");
  const clean = git("rev-parse", "HEAD").trim();
  fs.mkdirSync(path.join(repo, marker));
  fs.writeFileSync(path.join(repo, marker, "a.txt"), "clean\n");
  git("add", marker);
  git("commit", "-q", "-m", "marked");

  const messageDir = path.join(root, "Users", fakeUser);
  fs.mkdirSync(messageDir, { recursive: true });
  const failingMessage = path.join(messageDir, "failing.txt");
  const passingMessage = path.join(messageDir, "passing.txt");
  fs.writeFileSync(failingMessage, `notes\n\nsee ${USERS}${BS}zed${BS}x\n`);
  fs.writeFileSync(passingMessage, "nothing private in this message\n");
  const list = path.join(root, "list.txt");
  fs.writeFileSync(list, `${marker}\n`);

  const run = (tree, message) =>
    spawnSync(process.execPath, [script, "--tree", tree, "--message", message, "--denylist", list, "--require-denylist"], {
      cwd: repo,
      encoding: "utf8"
    });
  const failing = run("HEAD", failingMessage);
  const passing = run(clean, passingMessage);
  assert.equal(failing.status, 1, failing.stdout + failing.stderr);
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  for (const result of [failing, passing]) {
    const printed = `${result.stdout}${result.stderr}`;
    assert.equal(printed.includes(marker), false, printed);
    assert.equal(printed.includes(fakeUser), false, printed);
    assert.equal(printed.includes("zed"), false, printed);
  }
  assert.match(failing.stdout, /message failing\.txt:/);
  assert.match(passing.stdout, /message passing\.txt/);
});

// The summary on stderr names each message
// file by its base name, so a message file named like a deny-listed identifier is the one thing
// that puts the identifier on stderr; the print test above names its files harmlessly.
test("stderr of a failing run does not carry a deny-listed marker from a message file name", () => {
  const marker = ["zz", "stderr", "marker"].join("-");
  const message = writeBytes(`${marker}.txt`, `notes\n\nsee ${USERS}${BS}zed${BS}x\n`);
  const result = gate(["--message", message, "--denylist", denylistFile(`${marker}\n`), "--require-denylist"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /private-data finding\(s\) in message /, "the summary must have been printed at all");
  assert.equal(result.stderr.includes(marker), false, result.stderr);
  assert.equal(result.stdout.includes(marker), false, result.stdout);
});
