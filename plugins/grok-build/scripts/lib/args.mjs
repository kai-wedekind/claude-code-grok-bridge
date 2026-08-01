// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const unknownMode = config.unknownMode ?? "positional";
  const options = {};
  const positionals = [];
  const unknown = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      // Commands whose positionals are free text (a prompt) opt into POSIX-style
      // "first positional ends option parsing": otherwise a word inside that text which
      // happens to look like a flag — "--write" — would silently change behaviour.
      if (config.stopAtFirstPositional) {
        passthrough = true;
      }
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (unknownMode === "error") {
        throw new Error(`Unknown option --${rawKey}`);
      }
      if (unknownMode === "warn") {
        unknown.push(token);
        continue;
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (unknownMode === "error") {
      throw new Error(`Unknown option -${shortKey}`);
    }
    if (unknownMode === "warn") {
      unknown.push(token);
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals, unknown };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      // A backslash escapes only what it plausibly meant to escape: a quote, another
      // backslash, or a space someone wanted kept. Anything else keeps the backslash.
      //
      // Treating every `\` as an escape is a POSIX-shell habit, and this is a Windows-first
      // project whose own install instructions use `C:\src\…`. It turned `C:\Users\me\app`
      // into `C:Usersmeapp` and `\d+` into `d+`, silently, in the one argument most likely
      // to contain a path — and the run then answered about a file that does not exist.
      if (character === "\\" || character === "\"" || character === "'" || /\s/.test(character)) {
        current += character;
      } else {
        current += `\\${character}`;
      }
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
