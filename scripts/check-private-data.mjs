#!/usr/bin/env node
/**
 * Refuse to publish private data: scan a commit's tree (and optionally commit or tag message
 * files) for things a stranger reading the public repository does not need.
 *
 *   node scripts/check-private-data.mjs [--tree <commit>] [--message <file>]... [--denylist <file>] [--require-denylist]
 *
 * Exit 0 clean, 1 findings, 2 usage or internal error, 3 --require-denylist and the deny-list
 * could not be loaded into at least one usable rule (missing, a directory, unreadable, an
 * invalid or unprintable rule, or no rules). Without --require-denylist those are exit 2.
 *
 * ⚠ WHY IT EXISTS. A real user name can reach a published tree through a code comment that
 * quotes a path, through the backslash-eaten form `C:Users<name>…` that a search for
 * `\Users\<name>\` misses, or through a test fixture. Nothing checks that unless a step is
 * built to check it.
 *
 * Two kinds of rule, kept apart on purpose:
 *   - GENERIC rules live here: a real-looking user name in a home path (Windows with backslash,
 *     forward slash or a JSON-escaped `\/`, backslash-eaten Windows, POSIX, WSL and a UNC admin
 *     share), e-mail addresses outside the example and noreply domains, private and link-local
 *     addresses (IPv4 and IPv6), and credential shapes. They name no one, so they can be public.
 *     URL-encoded paths are not covered.
 *   - The maintainer's OWN identifiers — user name, host names, other accounts, institutions —
 *     cannot live in this file: the deny-list would itself publish what it guards. They are read
 *     from a file outside the published tree, one regular expression per line (case-insensitive,
 *     `#` starts a comment). The release step passes --require-denylist, so a missing or empty
 *     list stops the release instead of quietly checking less.
 *
 * Every input (a tree blob, a --message file, the deny-list) goes through one decoder: UTF-8
 * with or without a BOM, UTF-16LE and UTF-16BE with a BOM, and BOM-less UTF-16. A blob that
 * contains NULs but is not UTF-16 is still scanned, as lossy UTF-8, and the summary counts
 * those files. A --message file that cannot be decoded is an error, not a pass.
 *
 * Everything printed is masked first (findings, paths, message-file names, the summary, errors).
 * The mask keeps at most floor(length/4) characters and never more than 3, so a match of 3
 * characters or fewer reveals only its length. Message files are named by their base name.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Names that are placeholders in fixtures and docs, not somebody's account.
const PLACEHOLDER_USERS = new Set([
  "user", "users", "username", "you", "me", "name", "someone", "test", "john", "john smith",
  "alice", "bob", "runneradmin", "public", "default", "example"
]);
const isPlaceholder = (name) => {
  const lower = name.toLowerCase();
  return /^\.+$/.test(lower) || PLACEHOLDER_USERS.has(lower);
};

// `app` / `appdata` / `data` under one `*` would backtrack 2^n on a tail that cannot match, so
// this walks the segment list instead, then allows only trailing dots. A run longer
// than the cap is a finding — a real eaten path is a handful of segments, and a hang fails
// the release closed with no message.
const EATEN_SEGMENTS = ["appdata", "desktop", "documents", "downloads", "projects", "project", "app", "src", "local", "temp", "data", ".claude", ".grok"];
const EATEN_CAP = 1024;

function eatenRestIsSegments(rest) {
  if (rest.length > EATEN_CAP) return false;
  const s = rest.toLowerCase();
  const n = s.length;
  const can = new Uint8Array(n + 1);
  can[0] = 1;
  for (let i = 0; i < n; i++) {
    if (!can[i]) continue;
    for (const seg of EATEN_SEGMENTS) {
      if (i + seg.length <= n && s.startsWith(seg, i)) can[i + seg.length] = 1;
    }
  }
  let end = n;
  while (end > 0 && s.charCodeAt(end - 1) === 46) end--;
  return can[end] === 1;
}

const eatenIsPlaceholder = (run) =>
  [...PLACEHOLDER_USERS].some((name) => run.toLowerCase().startsWith(name) && eatenRestIsSegments(run.slice(name.length)));

// A separator, quote or backtick closes the name. Otherwise a Capitalised
// word continues it (so a placeholder first name plus a surname is one name) and a lower-case
// word is prose, which stays out of the name.
function isCapitalised(word) {
  const ch = word.charAt(0);
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function pathName(match, first, rest) {
  const extra = rest ?? "";
  const after = match.input.slice(match.index + match[0].length);
  let name = first;
  if (extra && /^(?:\\+|\/|["'`])/.test(after)) {
    name = first + extra;
  } else if (extra) {
    const kept = [];
    for (const word of extra.split(" ")) {
      if (!word) continue;
      if (!isCapitalised(word)) break;
      kept.push(word);
    }
    if (kept.length) name = `${first} ${kept.join(" ")}`;
  }
  const stripped = name.replace(/\.+$/, "");
  return stripped || name;
}

const ALLOWED_EMAIL = /@(?:users\.)?noreply\.github\.com$|@example\.(?:com|org|net|invalid)$|\.(?:invalid|test|example)$/i;
// Credential-shaped strings that are plainly fixtures. Narrow on purpose: a real token that
// happens to contain "test" or "secret" must still be caught.
const DUMMY_SECRET = /abcdefghij|0123456789|x{8,}/i;

export const GENERIC_RULES = [
  {
    // `\/` is tried before a backslash run: the run would otherwise swallow the backslash
    // of a JSON-escaped slash.
    name: "home path with a user name",
    re: /[A-Za-z]:(?:\\\/|\\+|\/)users(?:\\\/|\\+|\/)([\p{L}\p{N}._-]+)((?: [\p{L}\p{N}._-]+)*)/giu,
    keep: (m) => !isPlaceholder(pathName(m, m[1], m[2]))
  },
  {
    name: "backslash-eaten home path",
    re: /[A-Za-z]:users(\p{L}[\p{L}\p{N}._-]*)/giu,
    keep: (m) => !eatenIsPlaceholder(m[1])
  },
  {
    // MSYS `/<letter>/users` and `/home` in any case; `/Users` (macOS) as spelled. Lowercase
    // `/users/` alone is left out: it is a URL path segment (`api.github.com/users/<login>`),
    // not a home. The Users alternatives are dropped only after a lone
    // drive letter (a letter not itself preceded by a letter or digit), which the Windows rule
    // already reports. `/home/<name>` is never dropped.
    name: "POSIX home path with a user name",
    re: /(?:(?<!(?<![A-Za-z0-9])[A-Za-z]:)\/(?:[A-Za-z]\/[Uu][Ss][Ee][Rr][Ss]|Users)|\/[Hh][Oo][Mm][Ee])\/([\p{L}\p{N}._-]+)((?: [\p{L}\p{N}._-]+)*)/gu,
    keep: (m) => !isPlaceholder(pathName(m, m[1], m[2]))
  },
  {
    // `\\wsl$\<distro>\home\<name>` and `\\wsl.localhost\<distro>\home\<name>`.
    name: "WSL home path with a user name",
    re: /\\{2,}wsl(?:\$|\.localhost)\\([^\\]+)\\home\\([\p{L}\p{N}._-]+)/giu,
    keep: (m) => !isPlaceholder(m[2])
  },
  {
    // `\\<host>\<letter>$\Users\<name>`.
    name: "UNC home path with a user name",
    re: /\\{2,}[^\\]+\\[A-Za-z]\$\\users\\([\p{L}\p{N}._-]+)/giu,
    keep: (m) => !isPlaceholder(m[1])
  },
  {
    name: "e-mail address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    keep: (m) => !ALLOWED_EMAIL.test(m[0])
  },
  {
    name: "private or link-local IPv4 address",
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}\b/g,
    keep: () => true
  },
  {
    name: "private or link-local IPv6 address",
    re: /\b(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){1,6}/gi,
    keep: () => true
  },
  {
    name: "credential",
    re: /\bxai-[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{24,}|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi,
    keep: (m) => !DUMMY_SECRET.test(m[0])
  }
];

// At most floor(length/4) characters, and never more than 3. A match of
// three or fewer reveals nothing but its length.
const mask = (value) => {
  const keep = Math.min(3, Math.floor(String(value).length / 4));
  const shown = keep === 0 ? "" : String(value).slice(0, keep);
  return `${shown}…(${value.length})`;
};

// U+0000 through the C0 controls, except tab, plus U+FFFD. A deny-list rule with any of
// these was not decoded as text.
const UNPRINTABLE_RULE = /[\u0000-\u0008\u000A-\u001F\uFFFD]/;

function nulRatio(buffer, start) {
  let nuls = 0;
  let slots = 0;
  const end = Math.min(buffer.length, 8192);
  for (let i = start; i < end; i += 2) {
    slots++;
    if (buffer[i] === 0) nuls++;
  }
  return slots === 0 ? 0 : nuls / slots;
}

// BOM-less UTF-16: NULs in the odd bytes are little-endian, in the even bytes big-endian.
// 90% of one parity, so a stray NUL in UTF-8 does not qualify and a Latin-1 text still does.
function utf16Kind(buffer) {
  if (buffer.length < 4) return null;
  const odd = nulRatio(buffer, 1);
  const even = nulRatio(buffer, 0);
  if (odd >= 0.9 && odd >= even) return "le";
  if (even >= 0.9) return "be";
  return null;
}

// Drop an odd trailing byte before swapping: on `FE FF` plus an odd length, swap16 would throw
// a RangeError inside the scan and exit 2 naming no file.
function decodeUtf16(buffer, kind) {
  const even = buffer.subarray(0, buffer.length - (buffer.length % 2));
  if (even.length === 0) return "";
  if (kind === "le") return even.toString("utf16le");
  return Buffer.from(even).swap16().toString("utf16le");
}

// A UTF-8 prefix with a BOM-less UTF-16LE tail is what PowerShell 5.1 `>>` writes onto an
// existing list. Decode each part, instead of reading the tail as
// NUL-interleaved UTF-8 that matches nothing.
//
// The split is the byte BEFORE the first NUL: in a UTF-16LE tail that byte is the low byte of
// the first appended character. A split that searched back for a newline, or ran only after the
// whole-buffer check, would let a tail that fills 90% of the first 8192 bytes make the whole
// file read as UTF-16 — the original identifiers would stop being rules (and, at an odd prefix
// length, the appended ones too), the list would still load, and the gate would pass. A first
// NUL at index 0 or 1 is a pure UTF-16 file, which has no head to keep. A BOM-less UTF-16BE
// tail is not split; nothing on this path writes that shape.
function splitMixed(buffer) {
  const nul = buffer.indexOf(0);
  if (nul < 2) return null;
  const tail = buffer.subarray(nul - 1);
  if (tail.length < 4 || utf16Kind(tail) !== "le") return null;
  return { head: buffer.subarray(0, nul - 1), text: buffer.subarray(0, nul - 1).toString("utf8") + decodeUtf16(tail, "le") };
}

// Which reading comes first when the bytes admit both a split and a whole-file UTF-16 reading:
// the split, when its head is at least HEAD_MIN_BYTES long, or is valid UTF-8 with no control
// character other than tab, CR and LF and ends in LF. This only orders the two; both are
// scanned (decodeText), and only the first is held to the rule checks. As a gate on its own,
// any such test is beaten by a pure BOM-less UTF-16 file the other reading decodes right — a
// first character above U+00FF, then one Gurmukhi or Gujarati character (a BE high byte of
// 0x0A reads as a clean line break), then a run of kana — and each such file would fail open.
const HEAD_MIN_BYTES = 16;
const HEAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function headLooksLikeUtf8List(head) {
  // A long head is a real list whatever bytes it holds, so its lines are the ones held to the
  // rule checks. Otherwise a cp1252 `Müller` rule line (what PowerShell 5.1 `Set-Content`
  // writes) in front of a long `>>` tail would make the whole-file reading the likelier one, and
  // the broken rule would vanish silently from the alternate instead of stopping the release.
  // Misread UTF-16 rarely gives 16 bytes without a NUL, and when it does, the whole-file reading
  // is still scanned as the alternate.
  if (head.length >= HEAD_MIN_BYTES) return true;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(head);
  } catch {
    return false;
  }
  if (HEAD_CONTROL.test(text)) return false;
  return text.endsWith("\n");
}

/**
 * `{ text, lossy, alternate }`. `lossy` means the bytes contained NULs and were not UTF-16.
 * `alternate` is a second reading of the same bytes, or null: a BOM-less file with NULs can be
 * a UTF-8 head plus a UTF-16LE tail and a whole UTF-16 file at once, and nothing in the bytes
 * settles which. The gate does not bet on one — callers scan both, so a finding in either counts
 * and the deny-list takes rules from both. `text` is the likelier reading (headLooksLikeUtf8List);
 * only its rule lines are held to the unprintable and regex checks.
 */
export function decodeText(buffer) {
  let input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return { text: decodeUtf16(input.subarray(2), "le"), lossy: false, alternate: null };
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    return { text: decodeUtf16(input.subarray(2), "be"), lossy: false, alternate: null };
  }
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    input = input.subarray(3);
  }
  if (input.length === 0 || !input.includes(0)) {
    return { text: input.toString("utf8"), lossy: false, alternate: null };
  }
  const mixed = splitMixed(input);
  const kind = utf16Kind(input);
  const whole = kind ? decodeUtf16(input, kind) : null;
  if (mixed && whole !== null) {
    return headLooksLikeUtf8List(mixed.head)
      ? { text: mixed.text, lossy: false, alternate: whole }
      : { text: whole, lossy: false, alternate: mixed.text };
  }
  if (mixed) return { text: mixed.text, lossy: false, alternate: null };
  if (whole !== null) return { text: whole, lossy: false, alternate: null };
  return { text: input.toString("utf8"), lossy: true, alternate: null };
}

/** Rules from one reading. `strict`: an unusable line is an error, not a skipped line. */
function parseDenylistRules(text, strict) {
  const rules = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      return;
    }
    if (UNPRINTABLE_RULE.test(line)) {
      if (!strict) return;
      throw new Error(`deny-list line ${index + 1} contains an unprintable character — check the file's encoding`);
    }
    let re;
    try {
      re = new RegExp(line, "gi");
    } catch {
      if (!strict) return;
      // Never echo the pattern: the list is exactly what must not be printed.
      throw new Error(`deny-list line ${index + 1} is not a valid regular expression`);
    }
    rules.push({ name: "private identifier", re, keep: () => true });
  });
  return rules;
}

/**
 * The deny-list's rules. Lines of the alternate reading (see decodeText) are rules too, marked
 * `alternate` and left out of the count; a line that is unusable in that reading is skipped,
 * because that reading may simply be the wrong one.
 */
export function loadDenylist(file) {
  const { text, alternate } = decodeText(fs.readFileSync(file));
  const rules = parseDenylistRules(text, true);
  if (alternate !== null) {
    for (const rule of parseDenylistRules(alternate, false)) rules.push({ ...rule, alternate: true });
  }
  return rules;
}

/**
 * Findings in every reading of one decoded text; a match both readings put on the same line is
 * reported once. The line is part of the key, so two different matches that share a rule and a
 * mask are never merged — this can print more, never less.
 */
function scanDecoded(decoded, rules) {
  const findings = scanText(decoded.text, rules);
  if (decoded.alternate === null) return findings;
  const seen = new Set(findings.map((f) => `${f.line}\0${f.rule}\0${f.excerpt}`));
  for (const finding of scanText(decoded.alternate, rules)) {
    const key = `${finding.line}\0${finding.rule}\0${finding.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  return findings;
}

/** Findings in one text: [{ line, rule, excerpt }], every excerpt masked. */
export function scanText(text, rules) {
  const findings = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      for (const match of line.matchAll(rule.re)) {
        if (!rule.keep(match)) {
          continue;
        }
        findings.push({ line: index + 1, rule: rule.name, excerpt: mask(match[0]) });
      }
    }
  });
  return findings;
}

/**
 * Apply every rule and replace each kept match with the mask. One pass, so a mask is never
 * scanned again. File-name findings, message paths and error text all go through this, so the
 * gate's own report cannot carry what it guards.
 */
export function redact(text, rules = GENERIC_RULES) {
  const input = String(text);
  const spans = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const match of input.matchAll(rule.re)) {
      if (match.index === undefined || !rule.keep(match)) continue;
      spans.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
    }
  }
  if (spans.length === 0) return input;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += input.slice(cursor, span.start) + mask(span.value);
    cursor = span.end;
  }
  return out + input.slice(cursor);
}

/** Findings for every file in a commit's tree, names and contents: { findings, lossy }. */
export function scanTree(commit, rules, repo = REPO) {
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30 });
  const entries = git(["ls-tree", "-r", "-z", commit]).toString("utf8").split("\0").filter(Boolean);
  const findings = [];
  let lossy = 0;
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [, type, sha] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    for (const finding of scanText(file, rules)) {
      findings.push({ path: file, ...finding, line: 0 });
    }
    if (type !== "blob") {
      continue;
    }
    const decoded = decodeText(git(["cat-file", "blob", sha]));
    // A NUL that is not UTF-16 does not exempt the blob: it is scanned anyway.
    if (decoded.lossy) lossy++;
    for (const finding of scanDecoded(decoded, rules)) {
      findings.push({ path: file, ...finding });
    }
  }
  return { findings, lossy };
}

function parseCli(argv) {
  const options = { tree: null, messages: [], denylist: null, requireDenylist: false };
  const value = (flag, index) => {
    const v = argv[index];
    if (v === undefined || v === "" || v.startsWith("--")) {
      throw Object.assign(new Error(`${flag} needs a value`), { usage: true });
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tree") options.tree = value(arg, ++i);
    else if (arg === "--message") options.messages.push(value(arg, ++i));
    else if (arg === "--denylist") options.denylist = value(arg, ++i);
    else if (arg === "--require-denylist") options.requireDenylist = true;
    else throw Object.assign(new Error(`unknown argument: ${arg}`), { usage: true });
  }
  if (!options.tree && options.messages.length === 0) {
    options.tree = "HEAD";
  }
  return options;
}

function describeDenyError(error) {
  if (error.code === "ENOENT") return "file not found";
  // The node message for EISDIR and EACCES includes the path. The code does not.
  if (error.code) return error.code;
  return error.message;
}

// Rules currently in force, so the crash path can mask with whatever was loaded.
let printRules = GENERIC_RULES;
const out = (text) => console.log(redact(text, printRules));
const err = (text) => console.error(redact(text, printRules));

function main(argv) {
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    err(error.message);
    return 2;
  }

  const rules = [...GENERIC_RULES];
  let denyRules = 0;
  if (options.denylist) {
    try {
      const loaded = loadDenylist(options.denylist);
      denyRules = loaded.filter((rule) => !rule.alternate).length;
      rules.push(...loaded);
    } catch (error) {
      err(`could not use the deny-list: ${describeDenyError(error)}`);
      return options.requireDenylist ? 3 : 2;
    }
  }
  printRules = rules;
  if (options.requireDenylist && denyRules === 0) {
    err("--require-denylist: no deny-list rules loaded. Pass --denylist <file> with at least one of the maintainer's own identifiers; without them this check would pass things it was never shown.");
    return 3;
  }
  if (options.denylist && denyRules === 0) {
    err("could not use the deny-list: no rules loaded");
    return 2;
  }

  const findings = [];
  let lossy = 0;
  try {
    if (options.tree) {
      const scanned = scanTree(options.tree, rules);
      findings.push(...scanned.findings);
      lossy = scanned.lossy;
    }
    for (const file of options.messages) {
      const base = path.basename(file);
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch (error) {
        err(`could not read message file ${base}: ${error.code ?? "unreadable"}`);
        return 2;
      }
      const decoded = decodeText(buffer);
      // A message that is not text is an error, not a NUL-interleaved pass.
      if (decoded.lossy) {
        err(`could not decode message file ${base}`);
        return 2;
      }
      for (const finding of scanDecoded(decoded, rules)) {
        findings.push({ path: `message ${base}`, ...finding });
      }
    }
  } catch (error) {
    err(`private-data check could not run: ${error.message}`);
    return 2;
  }

  for (const f of findings) {
    out(`${f.path}:${f.line}: ${f.rule}: ${f.excerpt}`);
  }
  const what = [options.tree ? `tree ${options.tree}` : null, ...options.messages.map((m) => `message ${path.basename(m)}`)]
    .filter(Boolean)
    .join(", ");
  const tally = `${GENERIC_RULES.length} generic and ${denyRules} deny-list rules${lossy ? `, ${lossy} file(s) scanned as lossy UTF-8` : ""}`;
  if (findings.length > 0) {
    err(`\n✗ ${findings.length} private-data finding(s) in ${what} (${tally}). Nothing may be published until they are gone.`);
    return 1;
  }
  out(`✓ no private data found in ${what} (${tally})`);
  return 0;
}

// Compare real paths: node gives the main module its realpath but leaves argv[1] as typed, so a
// plain comparison skipped main() entirely when the script was reached through a junction or
// symlink — and exited 0 with no output, which reads as a pass.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // An uncaught crash exits 1, which this script's contract reserves for "findings".
    err(`private-data check crashed: ${error?.stack ?? error}`);
    process.exitCode = 2;
  }
}
