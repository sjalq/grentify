#!/usr/bin/env node
/**
 * gren-format rewrites record patterns onto multiple lines. Gren's compiler
 * only accepts single-line record *patterns* (`{x,y}` or `{ first = x, second = y }`).
 * Multi-line record *expressions* with simple fields are also collapsed (harmless).
 *
 * Nested simple records (tuple-pattern rewrites) are collapsed inside-out until
 * stable so `{ first = a, second = { first = b, second = c } }` becomes one line.
 *
 * Also repairs type/alias headers that format wraps with type variables starting
 * at column 0 (UNFINISHED TYPE ALIAS / CUSTOM TYPE):
 *   type alias Foo a b c\nd e =\n  →  type alias Foo a b c d e =\n
 *
 * Usage: node collapse-record-patterns.cjs <package-root>
 */
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
if (!root) {
  console.error("usage: collapse-record-patterns.cjs <package-root>");
  process.exit(2);
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const TYPE_HEADER =
  /^(type alias|type)(\s+[A-Za-z_][A-Za-z0-9_.]*)((?:\s+[a-z_][A-Za-z0-9_]*)*)\s*$/;
const TYPE_VAR_LINE = /^([a-z_][A-Za-z0-9_]*(?:\s+[a-z_][A-Za-z0-9_]*)*)\s*(=)?\s*$/;

function splitFields(inner) {
  const fields = [];
  let cur = "";
  let inString = false;
  let stringCh = "";
  let depth = 0;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (inString) {
      cur += ch;
      if (ch === "\\" && k + 1 < inner.length) {
        cur += inner[k + 1];
        k += 1;
        continue;
      }
      if (ch === stringCh) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringCh = ch;
      cur += ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      cur += ch;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      cur += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      fields.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0 || fields.length > 0) {
    fields.push(cur);
  }
  return fields;
}

function isCollapsibleField(raw) {
  if (!raw || !raw.trim()) return false;
  // Normalize wrapping whitespace so multi-line labeled fields like
  //   second =\n    { first = a, second = b }\n
  // still count as simple after nested collapse.
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (new RegExp(String.raw`^${IDENT}$`).test(trimmed) || trimmed === "_") {
    return true;
  }
  // label = value (value may itself be a single-line record)
  if (
    new RegExp(String.raw`^${IDENT}\s*=\s*.+$`).test(trimmed) &&
    !trimmed.includes("->") &&
    !/\blet\b/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/**
 * Collapse multi-line brace groups whose fields are simple (including nested
 * single-line records). Nested groups are collapsed inside-out first.
 */
function collapse(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "{") {
      out += source[i];
      i += 1;
      continue;
    }
    let j = i + 1;
    let depth = 1;
    let inString = false;
    let stringCh = "";
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (inString) {
        if (ch === "\\" && j + 1 < source.length) {
          j += 2;
          continue;
        }
        if (ch === stringCh) inString = false;
        j += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringCh = ch;
        j += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      j += 1;
    }
    if (depth !== 0) {
      out += source[i];
      i += 1;
      continue;
    }
    // Recursively collapse nested records first.
    const rawInner = source.slice(i + 1, j - 1);
    // Line comments inside records must stay multi-line. Collapsing
    // `{ a = 1\n-- note\n, b = 2 }` to one line comments out every field
    // after `--` (elm-ui's `classes` record hits this).
    if (/(^|[^\\])--/.test(rawInner) || rawInner.includes("{-")) {
      out += "{" + collapse(rawInner) + "}";
      i = j;
      continue;
    }
    const inner = collapse(rawInner);
    if (!inner.includes("\n")) {
      out += "{" + inner + "}";
      i = j;
      continue;
    }
    const fields = splitFields(inner);
    if (!fields || fields.length < 1) {
      out += "{" + inner + "}";
      i = j;
      continue;
    }
    let allSimple = true;
    for (const f of fields) {
      if (!isCollapsibleField(f)) {
        allSimple = false;
        break;
      }
    }
    if (!allSimple) {
      out += "{" + inner + "}";
      i = j;
      continue;
    }
    out +=
      "{ " +
      fields
        .map((f) => f.trim().replace(/\s+/g, " "))
        .join(", ") +
      " }";
    i = j;
  }
  return out;
}

/**
 * Join format-broken type / type-alias headers back onto one line.
 * gren-format sometimes wraps long generic lists with continuations at column 0,
 * which Gren parses as a new top-level declaration (UNFINISHED TYPE ALIAS).
 */
function joinTypeHeaders(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(TYPE_HEADER);
    if (!m) {
      out.push(line);
      continue;
    }
    let joined = line;
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      // Stop at blank lines, comments, or indented body.
      if (next.trim() === "" || next.startsWith(" ") || next.startsWith("\t")) {
        break;
      }
      const vm = next.match(TYPE_VAR_LINE);
      if (!vm) break;
      joined = joined.replace(/\s*$/, "") + " " + vm[1] + (vm[2] ? " =" : "");
      j += 1;
      if (vm[2]) break; // consumed the `=` line
    }
    // If we joined vars but `=` was still on a following indented line, keep it.
    out.push(joined);
    i = j - 1;
  }
  return out.join("\n");
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "gren_packages" || entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith(".gren")) files.push(full);
  }
  return files;
}

/**
 * gren-format may break `Ctor ({ fields })` / `Ctor { fields }` between the
 * name and the payload. `Node\n{ first` is invalid; `Node { first` is fine.
 */
function joinCtorPayloads(source) {
  return source.replace(
    /([A-Z][A-Za-z0-9_.]*)\n(\s*)(\(?\{)/g,
    (match, name, indent, brace) => {
      // Only join when the brace starts a record payload, not a block body.
      // Keep a single space; drop the newline.
      return name + " " + brace;
    },
  );
}

/**
 * gren-format sometimes glues a short type body to the next declaration's
 * `{-|` doc comment on the same line. Force docs onto their own paragraph.
 */
function separateDocComments(source) {
  return source.replace(/(\S)([ \t]*)(\{-\|)/g, "$1\n\n$3");
}

/**
 * gren-format may treat the next let binding's record pattern as an argument
 * to the previous expression:
 *   spawnedBy =\n    f x { first = a, second = b } =\n
 * →  spawnedBy =\n    f x\n\n    { first = a, second = b } =\n
 * Applications never end with `} =`; let-destructure patterns do.
 * The new binding is indented one level less than the value line (sibling of
 * the previous binding name).
 */
function separateGluedLetPatterns(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([ \t]*)(.*\S) \{([^;\n]+)\} =[ \t]*$/);
    if (m && m[3].includes("=")) {
      // Only split when the previous non-empty line ends with `=` — that means
      // this line is a let *value* that format glued to the next binding's
      // record pattern. Do NOT split function args:
      //   andThen args maybePid msg { first = model, second = cmd } =
      let prev = "";
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].trim() !== "") {
          prev = out[k];
          break;
        }
      }
      if (prev.trim().endsWith("=")) {
        const indent = m[1];
        const before = m[2];
        const fields = m[3];
        const bindIndent =
          indent.length >= 4 ? indent.slice(0, indent.length - 4) : indent;
        out.push(indent + before);
        out.push("");
        out.push(bindIndent + "{ " + fields.trim() + " } =");
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function transform(source) {
  return separateGluedLetPatterns(
    separateDocComments(joinCtorPayloads(joinTypeHeaders(collapse(source)))),
  );
}




for (const file of walk(root)) {
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(file, after);
  }
}
