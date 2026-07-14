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
 *
 * Must NOT join a nullary constructor *expression* onto the next `when` arm's
 * record pattern:
 *   Loading\n    { first = _, second = Loading } ->
 * is two arms; joining yields `Loading { first = _, second = Loading } ->`
 * which Gren parses as a broken record expression (MISSING EXPRESSION on `_`).
 *
 * Word boundary is required: `totalDays\n{ first = months` must not match the
 * trailing `Days` inside a camelCase value name (iso8601 fromTime UNEXPECTED
 * EQUALS).
 */
function joinCtorPayloads(source) {
  return source.replace(
    /(?<![A-Za-z0-9_])([A-Z][A-Za-z0-9_.]*)\n(\s*)(\(?\{)/g,
    (match, name, _indent, brace, offset, full) => {
      // Line starting at the brace (pattern or payload).
      const braceAt = offset + match.length - brace.length;
      const lineEnd = full.indexOf("\n", braceAt);
      const braceLine = full.slice(
        braceAt,
        lineEnd === -1 ? full.length : lineEnd,
      );
      // Case arm patterns end with `->`. Ctor payloads do not.
      if (braceLine.includes("->")) {
        return match;
      }
      // Multi-line blank between name and brace: sibling let binding, not payload.
      // `Ctor\n\n    { first` is never a format-broken payload (format keeps one
      // newline). Two+ newlines → leave alone.
      if (match.includes("\n\n")) {
        return match;
      }
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

/**
 * Walk back through emitted lines for a let binding whose indent is strictly
 * shallower than `lineIndent`. Used to place a recovered sibling binding.
 */
function findSiblingBindIndent(outLines, lineIndent) {
  for (let k = outLines.length - 1; k >= 0; k--) {
    const t = outLines[k];
    if (t.trim() === "") continue;
    if (/^[ \t]*(let|in)\b/.test(t)) break;
    // Pattern or name binding: `foo =` / `{ first = a, second = b } =`
    const bm = t.match(/^([ \t]+)(\{[^\n]*\}|[a-z_][\w]*)[ \t]*=[ \t]*$/);
    if (bm && bm[1].length < lineIndent) {
      return bm[1];
    }
  }
  return null;
}

/**
 * gren-format may glue the end of an expression onto the next let-binding's
 * record pattern (plain or parenthesized by a later pass):
 *   daysToYears … totalDays { first = months, second = daysInMonth } =
 *   daysToYears … totalDays ({ first = months, second = daysInMonth }) =
 * → daysToYears … totalDays\n\n    { first = months, second = daysInMonth } =
 * Only when the previous non-empty line does not end with `=` / `->` (i.e. we
 * are mid-expression, not starting a new binding/function).
 */
function separateGluedExprAndRecordBind(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only split a *simple* trailing record bind after a value token.
    // Do not touch function heads like:
    //   consume char { first = …, second = { … }, third = … } =
    // (nested `{` in `before` or balanced full-line record args).
    // Optional parens: parenRecordFnArgs may have wrapped the pattern already.
    const m = line.match(
      /^([ \t]*)([a-z_][\w]*)[ \t]+\(?(\{[^{};\n]+=[^{};\n]*\})\)?[ \t]*=[ \t]*$/,
    );
    if (m && !KEYWORD_NAME.test(m[2])) {
      let prev = "";
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].trim() !== "") {
          prev = out[k];
          break;
        }
      }
      const prevTrim = prev.trim();
      const lineIndent = m[1].length;
      const prevIndent = (prev.match(/^[ \t]*/) || [""])[0].length;
      // Mid-expression continuation: value line is deeper than the call line
      // above it (format wrap). Same-or-shallower indent is a real fn head
      // (e.g. `helper ({ first = a, second = b }) =` after a sibling body).
      // Never "fix" keyword lines like `let ({ … }) =`.
      // Never undo a local under `let` that parenRecordFnArgs just joined
      // (list-extra permutations: `let\n  f ({ first = y }) =`).
      const isContinuation =
        prevTrim &&
        prevTrim !== "let" &&
        !prevTrim.endsWith("=") &&
        !prevTrim.endsWith("->") &&
        !prevTrim.endsWith(" is") &&
        lineIndent > prevIndent;
      if (isContinuation) {
        const indent = m[1];
        const before = m[2];
        const rec = m[3];
        // Prefer the nearest shallower let-binding indent (sibling), not just -4
        // which leaves the pattern nested under if/else (iso8601 fromTime).
        const bindIndent = findSiblingBindIndent(out, lineIndent) || (
          indent.length >= 4 ? indent.slice(0, indent.length - 4) : indent
        );
        out.push(indent + before);
        out.push("");
        out.push(bindIndent + rec + " =");
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * gren-format breaks nested record patterns in multi-arg function heads:
 *   consume char { first = hs, second =\n\n{ first = bc, second = w }, third = t } =
 * Join `field =\n{` so the pattern stays one logical unit.
 */
function joinBrokenRecordFieldValues(source) {
  let s = source;
  let prev = "";
  while (s !== prev) {
    prev = s;
    // `second =\n\n{ first = …` (one or more newlines)
    s = s.replace(/(\w+\s*=)[ \t]*[\r\n]+[ \t]*\{/g, "$1 {");
  }
  return s;
}

/**
 * Function head split across lines before a record-pattern argument:
 *   maxBy x\n\n{ first = y, second = fy } =\n
 * → maxBy x ({ first = y, second = fy }) =\n
 * Also: predWithIndex { a } \n { b } =  stays one line with parens if needed.
 *
 * Must NOT join a mid-expression last arg onto the next let binding:
 *   daysToYears Before 1969\n            totalDays\n\n    { first = m, second = d } =\n
 * The value line is *more* indented than the sibling let binding; joining yields
 * `totalDays ({ first = m, second = d }) =` under `else` (UNEXPECTED EQUALS).
 * Only join when the name line indent is <= the record binding indent.
 */
/** Gren/Elm keywords that must never be treated as function names. */
const KEYWORD_NAME =
  /^(let|in|if|then|else|when|is|case|of|type|alias|module|import|exposing|port|as|where|infix|infixl|infixr)$/;

function parenRecordFnArgs(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cases:
    // 1) let-local / top:  f\n\n{ first = y, second = ys } =
    // 2) after annotation: maxBy x\n\n{ first = y, second = fy } =
    // Never: splitAt index1 l\n\n{ first = h, second = t } =  (value, not fn head)
    //   detected when the name line has 2+ tokens that look like call args
    //   without a preceding type annotation.
    // Never: bare `let` / `else` / `in` (keywords) treated as fn names — that
    // yields `let ({ first = … }) =` → UNFINISHED LET (list-extra swapAt).
    const singleName = /^[ \t]*([a-z_][\w]*)[ \t]*$/.exec(line);
    if (singleName && KEYWORD_NAME.test(singleName[1])) {
      out.push(line);
      continue;
    }
    const multiName =
      /^[ \t]*[a-z_][\w]*(?:\s+[a-z_][\w]*)+[ \t]*$/.test(line) &&
      !line.includes("=");
    if (singleName || multiName) {
      let prev = "";
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].trim() !== "") {
          prev = out[k];
          break;
        }
      }
      const isAfterAnnotation =
        prev.includes(":") &&
        (prev.includes("->") || /:\s*[A-Z{]/.test(prev));
      // single-name local fn always ok; multi-name only after annotation
      const allow = singleName || isAfterAnnotation;
      if (allow) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length) {
          const recLine = lines[j];
          const rm = recLine.match(
            /^([ \t]*)(\{[^{};\n]+=[^{};\n]*\})[ \t]*=[ \t]*$/,
          );
          if (rm) {
            const nameIndent = (line.match(/^[ \t]*/) || [""])[0].length;
            const recIndent = rm[1].length;
            // Deeper name than binding → usually expression continuation
            // (iso8601 totalDays under else). Exception: bare local under
            // `let` where format outdented the record arg
            // (list-extra permutations: `let\n  f\n{ first = y } =`).
            // Do NOT treat prev ending with `=` as let context: that is the
            // value binding itself (`totalDays =\n  ms\n{ first = years } =`
            // must not join ms to the next sibling pattern).
            if (nameIndent > recIndent) {
              const prevTrim = prev.trim();
              const letContext = prevTrim === "let" || isAfterAnnotation;
              if (!letContext) {
                out.push(line);
                continue;
              }
            }
            out.push(line.replace(/\s+$/, "") + " (" + rm[2] + ") =");
            i = j;
            continue;
          }
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function transform(source) {
  // separateGlued* after parenRecordFnArgs so a false join is still split when
  // context proves mid-expression glue (iso8601 fromTime / daysToYears).
  return separateGluedExprAndRecordBind(
    separateGluedLetPatterns(
      parenRecordFnArgs(
        separateDocComments(
          joinBrokenRecordFieldValues(
            joinCtorPayloads(joinTypeHeaders(collapse(source))),
          ),
        ),
      ),
    ),
  );
}

// Export for unit tests (node -e / require). CLI still runs when main.
module.exports = {
  collapse,
  joinTypeHeaders,
  joinCtorPayloads,
  separateDocComments,
  separateGluedLetPatterns,
  separateGluedExprAndRecordBind,
  joinBrokenRecordFieldValues,
  parenRecordFnArgs,
  transform,
};

if (require.main === module) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: collapse-record-patterns.cjs <package-root>");
    process.exit(2);
  }
  for (const file of walk(root)) {
    const before = fs.readFileSync(file, "utf8");
    const after = transform(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
    }
  }
}
