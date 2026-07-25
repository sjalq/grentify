/**
 * Failure signatures — turn a port failure's raw output into a normalized
 * ROOT-CAUSE fingerprint, so a drain can be planned by cause instead of by
 * compiler-message bucket.
 *
 * Law: `classifyFail` answers "which compiler message did we hit" (82
 * type-mismatch, 59 naming, ...). That is a symptom histogram: D41, D45b and
 * D49 each surfaced as a whole spread of those buckets while being ONE
 * transform bug. A signature answers "which shape of thing went wrong", so
 * counting distinct signatures counts distinct fixes.
 *
 * Two functions, both pure and total:
 *
 *   extractEvidence(text) -> string
 *     The error-bearing slice of the tool's combined stdout+stderr. Never the
 *     blind tail: download chatter is the last thing printed on most failures,
 *     which is why the M5 walk banked 447/534 failures with unusable evidence.
 *
 *   failureSignature(text) -> {signature, title, site, detail}
 *     Normalized fingerprint. Identifiers, numbers, and paths are redacted so
 *     the same bug in 40 packages produces one string.
 */

/** Gren/Elm human-readable error banner: `-- TYPE MISMATCH ---- src/Foo.gren` */
const BANNER = /^--\s+([A-Z][A-Z ']*[A-Z])\s+-+\s*(.*)$/;

/** Tool-side refusal codes, most specific first. */
const TOOL_CODES =
  /\b(PORT_TIMEOUT|OUTPUT_FAILED|GREN_VERIFY_FAILED|EXTRACT_LOCK|EXTRACT_FAILED|AST_UNPORTED_[A-Z_]+|SOURCE_INVALID|SOURCE_MANIFEST_MISMATCH|SOURCE_CLONE_FAILED|ARCHIVE_INVALID|DOWNLOAD_FAILED|PACKAGE_NOT_FOUND|PROCESS_FAILED|NO_ELM_SOURCES|REVIEW_[A-Z_]+)\b/;

/** Lines that carry no diagnostic value (progress, downloads, hints). */
const NOISE =
  /^(Starting downloads|Compiling|Success!|Dependencies ready|\s*(gren-lang|elm)\/|\s*-\s*Inspect|Hint:|Read <|\s*$)/;

/**
 * Strip ANSI colour codes; the tool's child processes emit them freely and
 * they would otherwise fragment otherwise-identical signatures.
 * @param {string} s
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || "").replace(/\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * The error-bearing slice of a failed port's output.
 * @param {string} raw combined stderr + stdout
 * @param {number} [limit] max characters to keep
 * @returns {string}
 */
function extractEvidence(raw, limit = 2000) {
  const text = stripAnsi(raw);

  // 1. A gren `--report=json` compile-errors blob is the richest evidence we
  //    get. Summarize it rather than storing a truncated (unparseable) prefix.
  const json = firstCompileErrorsJson(text);
  if (json) {
    const lines = [];
    for (const err of json.errors || []) {
      for (const problem of err.problems || []) {
        const head = String((problem.message || []).join(" ")).split("\n")[0];
        lines.push(
          `${problem.title} @ ${err.name || shortPath(err.path)}: ${head}`.trim(),
        );
        if (lines.length >= 12) break;
      }
      if (lines.length >= 12) break;
    }
    if (lines.length > 0) return lines.join("\n").slice(0, limit);
  }

  // 2. Human-readable banners: keep each banner plus its first message line.
  const rows = text.split("\n");
  const kept = [];
  for (let i = 0; i < rows.length; i += 1) {
    const banner = BANNER.exec(rows[i].trim());
    if (!banner) continue;
    const detail = rows
      .slice(i + 1, i + 8)
      .map((r) => r.trim())
      .find((r) => r && !NOISE.test(r));
    kept.push(`${banner[1]} @ ${shortPath(banner[2])}: ${detail || ""}`.trim());
    if (kept.length >= 12) break;
  }
  if (kept.length > 0) return kept.join("\n").slice(0, limit);

  // 3. Tool refusal code plus its message.
  const coded = rows.map((r) => r.trim()).filter((r) => TOOL_CODES.test(r));
  if (coded.length > 0) return coded.slice(0, 6).join("\n").slice(0, limit);

  // 4. Last resort: the tail, noise removed. Better than the blind tail
  //    because download chatter can never crowd the real message out.
  return rows
    .map((r) => r.trim())
    .filter((r) => r && !NOISE.test(r))
    .slice(-6)
    .join("\n")
    .slice(0, limit);
}

/**
 * First `{"type":"compile-errors"...}` object in the text, parsed.
 * Tolerates the blob being embedded in other output; returns null if the blob
 * is truncated (walk records banked before this module existed).
 * @param {string} text
 */
function firstCompileErrorsJson(text) {
  const start = text.indexOf('{"type":"compile-errors"');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString && ch === "{") {
      depth += 1;
    } else if (!inString && ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Basename of a path-ish token; leaves non-paths alone. */
function shortPath(value) {
  const s = String(value || "").trim();
  if (!s.includes("/")) return s;
  return s.split("/").filter(Boolean).slice(-2).join("/");
}

/**
 * Redact everything package-specific so one bug yields one signature:
 * backticked/quoted identifiers, bare capitalized qualified names, numbers,
 * and paths.
 * @param {string} line
 */
function normalize(line) {
  return String(line || "")
    .replace(/`[^`]*`/g, "‹id›")
    .replace(/"[^"]*"/g, "‹str›")
    .replace(/\b[A-Z][A-Za-z0-9_]*(\.[A-Z][A-Za-z0-9_]*)+\b/g, "‹Mod›")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Root-cause fingerprint for one failed port.
 * @param {string} raw combined output (or a banked evidence string)
 * @returns {{signature: string, title: string, site: string, detail: string}}
 */
function failureSignature(raw) {
  const text = stripAnsi(raw);

  if (/PORT_TIMEOUT|timed out/.test(text)) {
    return {
      signature: "timeout",
      title: "TIMEOUT",
      site: "-",
      detail: "budget exhausted",
    };
  }

  const json = firstCompileErrorsJson(text);
  if (json) {
    const err = (json.errors || [])[0] || {};
    const problem = (err.problems || [])[0] || {};
    const head = String((problem.message || []).join(" ")).split("\n")[0];
    return build(problem.title || "COMPILE ERROR", err.path || err.name, head);
  }

  for (const row of text.split("\n")) {
    const banner = BANNER.exec(row.trim());
    if (banner) {
      const detail = detailAfter(text, row);
      return build(banner[1], banner[2], detail);
    }
  }

  const evidence = extractEvidence(text, 400);
  const summarized = /^([A-Z][A-Z ']*[A-Z]) @ ([^:]*): ?(.*)$/.exec(
    evidence.split("\n")[0] || "",
  );
  if (summarized) return build(summarized[1], summarized[2], summarized[3]);

  const coded = TOOL_CODES.exec(text);
  if (coded) {
    const line =
      text
        .split("\n")
        .map((r) => r.trim())
        .find((r) => r.includes(coded[1])) || coded[1];
    return build(coded[1], "-", line.slice(coded[1].length + 1));
  }

  return {
    signature: "unclassified:no-evidence",
    title: "UNCLASSIFIED",
    site: "-",
    detail: "",
  };
}

function detailAfter(text, bannerRow) {
  const rows = text.split("\n");
  const at = rows.indexOf(bannerRow);
  if (at < 0) return "";
  return (
    rows
      .slice(at + 1, at + 8)
      .map((r) => r.trim())
      .find((r) => r && !NOISE.test(r)) || ""
  );
}

/**
 * A failure inside `.elm-to-gren/packages/` is a DEPENDENCY's port failing,
 * not the root's — a distinction that decides whether a fix is a hub fix.
 */
function build(title, pathOrName, detail) {
  const raw = String(pathOrName || "");
  const site = /\.elm-to-gren[/\\]packages/.test(raw) ? "dep" : "root";
  return {
    signature: `${title} @ ${site}: ${normalize(detail)}`,
    title: String(title),
    site,
    detail: normalize(detail),
  };
}

module.exports = {
  extractEvidence,
  failureSignature,
  firstCompileErrorsJson,
  normalize,
  stripAnsi,
};
