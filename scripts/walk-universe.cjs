#!/usr/bin/env node
/**
 * W5.6 — the universe walker (replaces the scripts/temp walker trio).
 *
 * Laws:
 *  - Reads ONLY the committed snapshot (test/ecosystem/registry-snapshot.json).
 *  - Candidacy = "not kernel, not glsl, not broken-upstream" — nothing else.
 *    Namespace-level kernel exclusion is decided here (unit-testable);
 *    source-level kernel/GLSL/effect refusals come from the port tool and are
 *    mapped to EXEMPT records with the tool's error as evidence.
 *    Every exemption is matched on the tool's exact refusal wording and, for
 *    kernel JS, attributed to the package that ships it — §1 splits
 *    EXEMPT(kernel) into "contains kernel modules" (`kernel:source`) and
 *    "requires an unmapped kernel package" (`kernel:dep`) and requires the
 *    offending module/dep chain as evidence. See D66. A mapped package whose
 *    Gren analogue does not provide an imported module is EXEMPT(mapping-absent)
 *    on the exact `MAPPING_MODULE_ABSENT:` refusal (D74/D81); the message is the
 *    evidence.
 *  - Every decision is one structured line in test/ecosystem/walk-log.jsonl
 *    (rotated to .jsonl.<n>.gz beyond 50MB). The log is append-only ground
 *    truth for ledger ingestion; nothing edits it in place.
 *  - Resumable: coordinates already recorded are skipped (use --only to
 *    re-attempt specific packages in drain loops).
 *
 * Usage:
 *   node scripts/walk-universe.cjs [--dry-run] [--limit N] [--offset N]
 *     [--only a/b@v,c/d@v] [-j N] [--timeout-ms N] [--self-test]
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  spawnCapture,
  mapPool,
  defaultConcurrency,
  classifyFail,
} = require("../test/ecosystem/lib/suite.cjs");
const { gitStamp } = require("../test/ecosystem/lib/git-stamp.cjs");
const {
  extractEvidence,
  failureSignature,
} = require("../test/ecosystem/lib/failure-signature.cjs");

const root = path.resolve(__dirname, "..");
const snapshotPath = path.join(root, "test/ecosystem/registry-snapshot.json");
// Ground truth by default. `--log` points experiments (throughput probes,
// class drains, bisects) at a scratch log so a dirty tree can never append
// to the committed record.
let walkLogPath = path.join(root, "test/ecosystem/walk-log.jsonl");
// Shared with the curated suites: months of elm-home, review-app, source,
// and extract-cache warmth; content-addressed, so the walk only adds to it.
// Override with --cache for an isolated run.
const defaultCacheDir = path.join(root, ".test-cache", "ecosystem", "cache");
const outRoot = path.join(root, ".test-cache", "walk", "out");
const cli = path.join(root, "bin", "elm-to-gren.cjs");

// ---------------------------------------------------------------------------
// Candidacy (namespace level). Unit-tested via --self-test.
// ---------------------------------------------------------------------------

/** Authors whose packages ARE the kernel/platform layer Gren rewrote. */
const KERNEL_AUTHORS = new Set(["elm", "elm-explorations"]);

/**
 * @param {{name: string, version: string}} entry snapshot entry
 * @returns {{candidate: boolean, reason?: string}}
 */
function classifyCandidacy(entry) {
  const author = String(entry.name || "").split("/")[0];
  if (!author || !String(entry.name).includes("/")) {
    return { candidate: false, reason: "broken-upstream:malformed-name" };
  }
  if (KERNEL_AUTHORS.has(author)) {
    return { candidate: false, reason: "kernel:core-namespace" };
  }
  if (!entry.version) {
    return { candidate: false, reason: "broken-upstream:no-version" };
  }
  return { candidate: true };
}

/**
 * Port-tool refusal codes that mean "excluded by design", not "bug".
 *
 * D66: every pattern here is the tool's OWN refusal vocabulary, quoted exactly.
 * The word "kernel" or "GLSL" appearing somewhere in a package's output proves
 * nothing — `/KERNEL/i` matched stack frames inside a bundled review app
 * (abinayasudhir/html-parser) and `/GLSL/` matched a dependency banner
 * (jfmengels/elm-review-common), so two working failures were banked terminal
 * and became invisible to every drain. That is D51's mistake pointing the other
 * way, and a terminal state is the one verdict nothing ever revisits.
 */
const EXEMPT_SIGNATURES = [
  // Acquire/Hazard.gren, surfaced as `UNSUPPORTED_ELM_SOURCE: <module> ...`.
  {
    pattern: /references Elm\.Kernel, whose native Elm kernel code/,
    reason: "kernel:source",
  },
  {
    pattern: /declares an Elm effect module, which is reserved/,
    reason: "effect-module:source",
  },
  {
    pattern: /contains an Elm \[glsl\|\.\.\.\|\] shader block/,
    reason: "glsl:source",
  },
  // Transform/Pipeline.gren synthetic diagnostics (rendered UNSUPPORTED_*).
  {
    pattern: /Elm kernel (module imports cannot be transpiled|calls cannot be emitted)/,
    reason: "kernel:source",
  },
  {
    pattern: /Elm effect modules depend on privileged runtime/,
    reason: "effect-module:source",
  },
  // A literal Elm shader block echoed back from the offending source.
  { pattern: /\[glsl\|/, reason: "glsl:source" },
  // Genuinely gone upstream: the coordinate's GitHub tag no longer exists, so
  // `elm install` cannot fetch it either (verified against the zipball URL Elm
  // itself uses, and against `git ls-remote --tags`). Terminal per §1.
  //
  // D79: a bare `DOWNLOAD_FAILED` is NOT that fact. The tool raises it for every
  // network outcome — timeout, DNS failure, GitHub 429 rate-limiting mid-walk,
  // a 5xx — and a terminal verdict is the one thing no drain revisits. Only a
  // status that means PERMANENTLY ABSENT counts (404/410); everything else is a
  // working failure to retry. `Elm/Acquire.gren` names the URL in the message,
  // so the banked evidence identifies the artifact, not just the code (D64).
  {
    pattern:
      /(DOWNLOAD_FAILED[^\n]*\b(404|410)\b)|SOURCE_CLONE_FAILED|couldn't find a compatible version|NO_ELM_SOURCES/,
    reason: "broken-upstream:unfetchable",
  },
  // D90: two packages in one Gren dependency graph may not expose the same
  // module name. Elm permits it while no single module imports both, so
  // gampleman/elm-visualization exposes `Force` and so does its own dependency
  // ianmackenzie/elm-units. `Port/Plan.gren` states at length why no sound
  // automatic rename exists — it would not be a pure function of the module
  // name, and any (package, module) scheme rewrites the package's public API.
  //
  // The refusal is therefore CORRECT output, and it names both packages, which
  // is the evidence §1 asks for. Banking it as a working failure counted a
  // right answer as a defect and put a permanent language rule on the drain
  // queue. Packages that fail only because they depend on such a package
  // (jxxcarlson/elm-stat -> elm-visualization) carry the same message and are
  // terminal for the same reason.
  {
    pattern: /AMBIGUOUS_MODULE_NAME[^\n]*exposes the module/,
    reason: "module-name-collision",
  },
  // D97: a Dict/Set key tuple Gren cannot represent at all. Gren compares
  // ints, floats, chars, strings and arrays of comparable values, and an array
  // is homogeneous, so `Set ( String, List Int )` (logicus-pl) and
  // `Set ( ModuleName, String )` (elm-review-unused) have no encoding —
  // rendering one element to String to unify the types is not order-preserving
  // (`"10" < "9"`). Elm accepts both because its `comparable` admits tuples and
  // lists directly.
  //
  // Terminal for the same reason as a module-name collision: a language-level
  // difference with no sound automatic fix, and the diagnostic names the module
  // and the container kind. Porting it would mean changing the package's data
  // structures, which is the author's call, not the tool's.
  {
    pattern: /UNSUPPORTED_TUPLE_KEY[^\n]*no common Gren comparable type/,
    reason: "tuple-key-unrepresentable",
  },
];

// ---------------------------------------------------------------------------
// Kernel attribution (D66). §1 makes EXEMPT(kernel) terminal for a package that
// "contains Elm.Kernel/effect modules, OR transitively requires an unmapped
// kernel package", and demands the "offending module/dep chain" as evidence.
// Those are two different facts about a package and the ledger must not blur
// them, so the refusal is attributed to the package that actually ships the
// native JS instead of being filed as if the walked package wrote it.
// ---------------------------------------------------------------------------

/** `Acquire.gren` refusal; the capture group is a `, `-joined list of paths. */
const KERNEL_JS_REFUSAL =
  /UNSUPPORTED_KERNEL: Elm package contains native JavaScript under src: (.+?)\. Add an explicit/g;

/**
 * Acquisition cache layout:
 *   <cache>/registry/packages/<author>/<name>/<version>/source-<sha>/<tarball>/<file>
 * The walked package and its dependencies are unpacked side by side under it,
 * so the path is what says WHOSE kernel this is.
 */
const REGISTRY_SOURCE_PATH =
  /registry[/\\]packages[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]source-[^/\\]+[/\\][^/\\]+[/\\](.+)$/;

/**
 * @param {string} filePath absolute path to an offending kernel .js
 * @returns {{owner: string|null, module: string}} owner = "author/name@version"
 */
function attributeKernelFile(filePath) {
  const raw = String(filePath || "").trim();
  const m = REGISTRY_SOURCE_PATH.exec(raw);
  if (!m) return { owner: null, module: raw.split(/[/\\]/).slice(-3).join("/") };
  return { owner: `${m[1]}/${m[2]}@${m[3]}`, module: m[4].replace(/\\/g, "/") };
}

/**
 * Classify an `UNSUPPORTED_KERNEL` native-JS refusal against the package we
 * asked to port.
 *
 * Unattributable paths count as the walked package's own kernel: the refusal
 * literally says "Elm package contains native JavaScript under src", so
 * "cannot prove it was a dependency" must never soften into "it was".
 *
 * @param {string} text combined tool output
 * @param {string} coordinate walked "author/name@version"
 * @returns {{reason: string, evidence: string}|null}
 */
function classifyKernelRefusal(text, coordinate) {
  const self = String(coordinate || "").split("@")[0];
  /** @type {Map<string, Set<string>>} owner -> modules */
  const offenders = new Map();
  let ownKernel = false;
  let matched = false;
  for (const hit of String(text || "").matchAll(KERNEL_JS_REFUSAL)) {
    matched = true;
    for (const file of hit[1].split(", ")) {
      if (!file.trim()) continue;
      const { owner, module } = attributeKernelFile(file);
      const key = owner || coordinate;
      if (!owner || owner.split("@")[0] === self) ownKernel = true;
      if (!offenders.has(key)) offenders.set(key, new Set());
      offenders.get(key).add(module);
    }
  }
  if (!matched) return null;
  const chain = [...offenders.entries()].map(([owner, modules]) =>
    owner === coordinate
      ? `${coordinate} ships ${[...modules].sort().join(", ")}`
      : `${coordinate} -> ${owner} ships ${[...modules].sort().join(", ")}`,
  );
  return {
    // A package that ships kernel JS itself is `kernel:source` even when a
    // dependency does too: the nearer, stronger fact wins.
    reason: ownKernel ? "kernel:source" : "kernel:dep",
    evidence: `kernel dep chain: ${chain.sort().join(" | ")}`,
  };
}

/**
 * D51: OUR refusals, previously filed as `broken-upstream:unfetchable` — 67 of
 * M5's 301 exemptions. A package we decline to unpack is a working failure
 * (§1 admits no tool-policy exemption); filing it as upstream breakage made it
 * terminal and therefore invisible to every later drain.
 */
const TOOL_REFUSAL_SIGNATURES = [
  { pattern: /ARCHIVE_INVALID/, reason: "tool-archive-refused" },
  {
    pattern: /SOURCE_INVALID|SOURCE_MANIFEST_MISMATCH/,
    reason: "tool-identity-mismatch",
  },
];

function classifyToolRefusal(text) {
  for (const sig of TOOL_REFUSAL_SIGNATURES) {
    if (sig.pattern.test(text)) return sig.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapping-absent (D81). A mapped package's Gren analogue does not provide a
// module the source imports. D74 makes the gap legible as MAPPING_MODULE_ABSENT
// at transform time; this classifier makes it terminal. No transform work can
// grow a module that gren-lang/test (etc.) does not ship — the package becomes
// portable only when the Gren package grows a counterpart, or never.
//
// Exact refusal wording only (D66/D79). The word "mapping" or "absent" in any
// other diagnostic proves nothing. The tool's message already names the
// importing module, the absent module, mapped-from, mapped-to, and the reason
// printed verbatim from mappings/builtin.json `absentModules`.
// ---------------------------------------------------------------------------

/** Full D74 refusal line; capture groups are unused — the line IS the evidence. */
const MAPPING_MODULE_ABSENT_LINE =
  /MAPPING_MODULE_ABSENT: \S+ imports \S+, which \S+ provides and its Gren mapping target \S+ does not: [^\n]+/g;

/**
 * @param {string} text combined tool output
 * @returns {{reason: string, evidence: string}|null}
 */
function classifyMappingAbsent(text) {
  const lines = [...String(text || "").matchAll(MAPPING_MODULE_ABSENT_LINE)].map(
    (m) => m[0].trim(),
  );
  if (lines.length === 0) return null;
  // Dedup: a package can trip the same absent module from many importers; keep
  // order of first appearance so the evidence stays stable across re-runs.
  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
  }
  return {
    reason: "mapping-absent",
    evidence: unique.join(" | "),
  };
}

/**
 * @param {string} text combined tool output
 * @param {string} coordinate walked "author/name@version"
 * @returns {{reason: string, evidence: string|null}|null} null = not exempt
 */
function classifyExempt(text, coordinate) {
  const kernel = classifyKernelRefusal(text, coordinate);
  if (kernel) return kernel;
  const mappingAbsent = classifyMappingAbsent(text);
  if (mappingAbsent) return mappingAbsent;
  for (const sig of EXEMPT_SIGNATURES) {
    if (sig.pattern.test(text)) return { reason: sig.reason, evidence: null };
  }
  return null;
}

/** Browser-platform heuristic on the port tool's own failure output. */
const BROWSER_DEP_PATTERN = /elm\/(browser|html|svg|virtual-dom)/;

// ---------------------------------------------------------------------------
// Walk log (append-only, rotating)
// ---------------------------------------------------------------------------

const ROTATE_BYTES = 50 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(walkLogPath);
    if (stat.size < ROTATE_BYTES) return;
    let n = 1;
    while (fs.existsSync(`${walkLogPath}.${n}.gz`)) n += 1;
    fs.writeFileSync(
      `${walkLogPath}.${n}.gz`,
      zlib.gzipSync(fs.readFileSync(walkLogPath)),
    );
    fs.rmSync(walkLogPath);
  } catch {
    /* no log yet */
  }
}

function loadDoneSet() {
  const done = new Set();
  const timeoutCounts = new Map();
  const readLines = (buf) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const starved =
          rec.status === "working-failure" && rec.reason === "timeout";
        const coordinate = `${rec.name}@${rec.version}`;
        if (starved) {
          timeoutCounts.set(coordinate, (timeoutCounts.get(coordinate) || 0) + 1);
        }
        if (rec.name && rec.version && rec.status !== "DRY-CANDIDATE" && !starved) {
          done.add(coordinate);
        }
      } catch {
        /* tolerate torn tail line */
      }
    }
  };
  let n = 1;
  while (fs.existsSync(`${walkLogPath}.${n}.gz`)) {
    readLines(zlib.gunzipSync(fs.readFileSync(`${walkLogPath}.${n}.gz`)));
    n += 1;
  }
  if (fs.existsSync(walkLogPath)) readLines(fs.readFileSync(walkLogPath));
  return { done, timeoutCounts };
}

function appendRecord(record) {
  fs.appendFileSync(walkLogPath, JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// Self-test (tier 0 proof for the candidacy classifier)
// ---------------------------------------------------------------------------

function selfTest() {
  const cases = [
    [{ name: "elm/core", version: "1.0.5" }, false, "kernel:core-namespace"],
    [{ name: "elm/browser", version: "1.0.2" }, false, "kernel:core-namespace"],
    [
      { name: "elm-explorations/test", version: "2.2.0" },
      false,
      "kernel:core-namespace",
    ],
    [{ name: "elm-community/list-extra", version: "8.7.0" }, true, undefined],
    [{ name: "rtfeldman/elm-hex", version: "1.0.0" }, true, undefined],
    [{ name: "noslash", version: "1.0.0" }, false, "broken-upstream:malformed-name"],
    [{ name: "a/b", version: "" }, false, "broken-upstream:no-version"],
  ];
  let failed = 0;
  for (const [entry, wantCandidate, wantReason] of cases) {
    const got = classifyCandidacy(entry);
    const ok = got.candidate === wantCandidate && got.reason === wantReason;
    if (!ok) {
      failed += 1;
      console.error(
        `FAIL candidacy ${entry.name}: got ${JSON.stringify(got)}, want candidate=${wantCandidate} reason=${wantReason}`,
      );
    }
  }
  // A real acquisition refusal, verbatim, with the cache paths it names.
  const cache = "/repo/.test-cache/ecosystem/cache/registry/packages";
  const linAlgJs = `${cache}/elm-explorations/linear-algebra/1.0.3/source-f9d8397/elm-explorations-linear-algebra-182fab3/src/Elm/Kernel/MJS.js`;
  const ownJs = `${cache}/some/pkg/1.0.0/source-abc1234/some-pkg-deadbee/src/Elm/Kernel/Local.js`;
  const kernelRefusal = (files) =>
    `UNSUPPORTED_KERNEL: Elm package contains native JavaScript under src: ${files}. Add an explicit Gren mapping instead of transpiling kernel code.`;

  const exemptCases = [
    [
      "some/pkg@1.0.0",
      "UNSUPPORTED_ELM_SOURCE: src/Foo.elm references Elm.Kernel, whose native Elm kernel code cannot be emitted as Gren package source.",
      "kernel:source",
    ],
    [
      "some/pkg@1.0.0",
      "UNSUPPORTED_FEATURE: Elm kernel module imports cannot be transpiled to portable Gren package source.",
      "kernel:source",
    ],
    ["some/pkg@1.0.0", "contains [glsl| shader", "glsl:source"],
    [
      "some/pkg@1.0.0",
      "UNSUPPORTED_ELM_SOURCE: src/Fx.elm declares an Elm effect module, which is reserved for core/runtime packages.",
      "effect-module:source",
    ],
    [
      "some/pkg@1.0.0",
      "UNSUPPORTED_KERNEL: Elm effect modules depend on privileged runtime and kernel APIs.",
      "effect-module:source",
    ],
    ["some/pkg@1.0.0", "SOURCE_CLONE_FAILED: gone", "broken-upstream:unfetchable"],
    [
      "some/pkg@1.0.0",
      "DOWNLOAD_FAILED: Bad status: 404 - Not Found",
      "broken-upstream:unfetchable",
    ],
    // D79: the URL-naming form, which is what the tool emits now.
    [
      "Skinney/murmur3@2.0.8",
      "DOWNLOAD_FAILED: GET https://github.com/Skinney/murmur3/zipball/2.0.8/ failed: Bad status: 404 - Not Found",
      "broken-upstream:unfetchable",
    ],
    // D79 negatives: a transient network outcome is a working failure. Banking
    // any of these terminal is the D51 mistake with a fresh face.
    [
      "some/pkg@1.0.0",
      "DOWNLOAD_FAILED: GET https://github.com/some/pkg/zipball/1.0.0/ failed: Bad status: 429 - Too Many Requests",
      null,
    ],
    [
      "some/pkg@1.0.0",
      "DOWNLOAD_FAILED: GET https://package.elm-lang.org/packages/some/pkg/1.0.0/endpoint.json failed: Bad status: 503 - Service Unavailable",
      null,
    ],
    ["some/pkg@1.0.0", "DOWNLOAD_FAILED: Timeout", null],
    ["some/pkg@1.0.0", "TYPE MISMATCH in Main.elm", null],
    // D51: our own refusals must NOT be exempt — they stay in the queue.
    ["some/pkg@1.0.0", "ARCHIVE_INVALID: Package archive contains a symbolic link.", null],
    ["some/pkg@1.0.0", "SOURCE_INVALID: Downloaded Elm package identity does not match.", null],
    // D66 negatives: the WORD is not the fact. These are working failures.
    ["some/pkg@1.0.0", "    at _Kernel_f (/tmp/review-applications/abc-debug.js:3827:5)", null],
    ["some/pkg@1.0.0", "GREN_VERIFY_FAILED: gren-lang/core ok; GLSL notes ignored", null],
    ["some/pkg@1.0.0", "NAMING ERROR: I cannot find a `kernel` variable.", null],
    ["some/pkg@1.0.0", "-- TYPE MISMATCH --- src/Effect/Module.elm", null],
    // D66 positives: kernel JS attributed to whoever ships it.
    ["ianmackenzie/elm-3d-camera@4.0.1", kernelRefusal(linAlgJs), "kernel:dep"],
    ["some/pkg@1.0.0", kernelRefusal(ownJs), "kernel:source"],
    // Own kernel plus a dependency's: the nearer fact wins.
    ["some/pkg@1.0.0", kernelRefusal(`${ownJs}, ${linAlgJs}`), "kernel:source"],
    // Unattributable path: never soften into "it was a dependency".
    ["some/pkg@1.0.0", kernelRefusal("/elsewhere/src/Elm/Kernel/X.js"), "kernel:source"],
    // D81 positives: the tool's exact MAPPING_MODULE_ABSENT refusal (D74 shape).
    [
      "avh4/elm-program-test@4.0.1",
      "MAPPING_MODULE_ABSENT: ProgramTest imports Test.Html.Event, which elm-explorations/test provides and its Gren mapping target gren-lang/test does not: gren-lang/test 5.0.0 exposes no Test.Html.* modules; Gren has no HTML-testing analogue.",
      "mapping-absent",
    ],
    [
      "drathier/elm-graph@4.0.0",
      "MAPPING_MODULE_ABSENT: Graph.Random imports Shrink, which elm-explorations/test provides and its Gren mapping target gren-lang/test does not: gren-lang/test 5.0.0 exposes no Shrink; shrinking is internal (Simplify) and there is no user-facing shrinker API to map onto.",
      "mapping-absent",
    ],
    // D81 negatives: near-misses must stay working failures. The word "mapping",
    // "absent", or a MODULE NOT FOUND for the same module is not the refusal.
    [
      "avh4/elm-program-test@4.0.1",
      "MODULE NOT FOUND @ ProgramTest: You are trying to import a `Test.Html.Event` module:",
      null,
    ],
    [
      "drathier/elm-graph@4.0.0",
      "MODULE NOT FOUND @ Graph.Random: You are trying to import a `Shrink` module:",
      null,
    ],
    [
      "some/pkg@1.0.0",
      "NAMING ERROR: I cannot find a `MAPPING_MODULE_ABSENT` variable.",
      null,
    ],
    [
      "some/pkg@1.0.0",
      "GREN_VERIFY_FAILED: mapping module absent from the Gren analogue of something",
      null,
    ],
    // Incomplete code-only / truncated shape: do not widen to a bare code match.
    ["some/pkg@1.0.0", "MAPPING_MODULE_ABSENT: something went wrong", null],
    ["some/pkg@1.0.0", "MAPPING_MODULE_ABSENT", null],
  ];
  for (const [coordinate, text, want] of exemptCases) {
    const got = classifyExempt(text, coordinate);
    const reason = got ? got.reason : null;
    if (reason !== want) {
      failed += 1;
      console.error(`FAIL exempt "${text.slice(0, 60)}": got ${reason}, want ${want}`);
    }
  }

  // The chain, not the word: §1 requires the offending module/dep chain.
  const chainCases = [
    [
      "ianmackenzie/elm-3d-camera@4.0.1",
      kernelRefusal(linAlgJs),
      "kernel dep chain: ianmackenzie/elm-3d-camera@4.0.1 -> elm-explorations/linear-algebra@1.0.3 ships src/Elm/Kernel/MJS.js",
    ],
    [
      "some/pkg@1.0.0",
      kernelRefusal(ownJs),
      "kernel dep chain: some/pkg@1.0.0 ships src/Elm/Kernel/Local.js",
    ],
    // D81: evidence is the refusal itself — importing module, absent module,
    // mapped-from, mapped-to, and the mapping file's reason.
    [
      "avh4/elm-program-test@4.0.1",
      "MAPPING_MODULE_ABSENT: ProgramTest imports Test.Html.Event, which elm-explorations/test provides and its Gren mapping target gren-lang/test does not: gren-lang/test 5.0.0 exposes no Test.Html.* modules; Gren has no HTML-testing analogue.",
      "MAPPING_MODULE_ABSENT: ProgramTest imports Test.Html.Event, which elm-explorations/test provides and its Gren mapping target gren-lang/test does not: gren-lang/test 5.0.0 exposes no Test.Html.* modules; Gren has no HTML-testing analogue.",
    ],
    [
      "drathier/elm-graph@4.0.0",
      "MAPPING_MODULE_ABSENT: Graph.Random imports Shrink, which elm-explorations/test provides and its Gren mapping target gren-lang/test does not: gren-lang/test 5.0.0 exposes no Shrink; shrinking is internal (Simplify) and there is no user-facing shrinker API to map onto.",
      "MAPPING_MODULE_ABSENT: Graph.Random imports Shrink, which elm-explorations/test provides and its Gren mapping target gren-lang/test does not: gren-lang/test 5.0.0 exposes no Shrink; shrinking is internal (Simplify) and there is no user-facing shrinker API to map onto.",
    ],
  ];
  for (const [coordinate, text, want] of chainCases) {
    const got = classifyExempt(text, coordinate);
    if (!got || got.evidence !== want) {
      failed += 1;
      console.error(
        `FAIL chain ${coordinate}: got ${got && got.evidence}, want ${want}`,
      );
    }
  }
  const refusalCases = [
    ["ARCHIVE_INVALID: contains a symbolic link.", "tool-archive-refused"],
    ["SOURCE_INVALID: identity does not match", "tool-identity-mismatch"],
    ["SOURCE_MANIFEST_MISMATCH: nope", "tool-identity-mismatch"],
    ["DOWNLOAD_FAILED: 404", null],
    ["TYPE MISMATCH in Main.gren", null],
  ];
  for (const [text, want] of refusalCases) {
    const got = classifyToolRefusal(text);
    if (got !== want) {
      failed += 1;
      console.error(`FAIL tool-refusal "${text}": got ${got}, want ${want}`);
    }
  }
  if (failed > 0) {
    console.error(`walker self-test: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log(
    `walker self-test: ${cases.length + exemptCases.length + chainCases.length + refusalCases.length} checks green`,
  );
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    selfTest: false,
    limit: null,
    offset: 0,
    only: null,
    // Cold walks are extraction-bound and serialized by the D30 lock:
    // -j beyond ~4 only deepens the queue until per-package budgets
    // starve (sample walk: 23/32 bogus timeouts at -j9). Warm reruns
    // can pass -j 9 explicitly — cache hits skip the lock.
    concurrency: defaultConcurrency(4),
    timeoutMs: Number(process.env.PORT_TIMEOUT_MS || 360000),
    cacheDir: defaultCacheDir,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--self-test") opts.selfTest = true;
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--offset") opts.offset = Number(argv[++i]);
    else if (a === "--only") opts.only = String(argv[++i] || "");
    else if (a === "-j" || a === "--concurrency")
      opts.concurrency = defaultConcurrency(Number(argv[++i]));
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--cache") opts.cacheDir = String(argv[++i] || defaultCacheDir);
    else if (a === "--log") opts.logPath = path.resolve(String(argv[++i] || ""));
  }
  return opts;
}

const MIN_FREE_BYTES = 2 * 1024 ** 3;

function freeBytes() {
  try {
    const st = fs.statfsSync(root);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

/** Outputs and per-package extraction litter are transient: the walk-log is
 * the ground truth. Delete both after the record is written, or the walk
 * eats the disk (observed: ENOSPC at ~700 packages, ~40MB elm-stuff each). */
function cleanupAfterRecord(entry, out, cacheDir) {
  fs.rmSync(out, { recursive: true, force: true });
  const coordDir = path.join(
    cacheDir,
    "registry",
    "packages",
    ...entry.name.split("/"),
    entry.version,
  );
  const stack = [coordDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p2 = path.join(dir, e.name);
      if (e.name === "elm-stuff") fs.rmSync(p2, { recursive: true, force: true });
      else stack.push(p2);
    }
  }
}

async function portOne(entry, stamp, opts) {
  const coordinate = `${entry.name}@${entry.version}`;
  const out = path.join(outRoot, entry.name.replace("/", "__") + `__${entry.version}`);
  fs.rmSync(out, { recursive: true, force: true });

  const attempt = (platformArgs) =>
    spawnCapture(
      process.execPath,
      [cli, coordinate, "--out", out, "--cache", opts.cacheDir, ...platformArgs],
      root,
      opts.timeoutMs,
    );

  const started = Date.now();
  let platform = "pure";
  let result = await attempt([]);
  let text = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (result.status !== 0 && BROWSER_DEP_PATTERN.test(text)) {
    platform = "browser";
    fs.rmSync(out, { recursive: true, force: true });
    result = await attempt(["--platform", "browser"]);
    text = `${result.stderr || ""}\n${result.stdout || ""}`;
  }
  const ms = Date.now() - started;

  let verified = false;
  let moduleCount = null;
  const reportPath = path.join(out, "elm-to-gren.report.json");
  if (result.status === 0 && fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      verified = report.verified === true;
      moduleCount = Array.isArray(report.packages)
        ? report.packages.reduce((sum, p) => sum + (p.moduleCount || 0), 0)
        : null;
    } catch {
      /* unreadable report counts as unverified */
    }
  }

  if (result.status === 0 && verified) {
    return {
      status: "PASS",
      platform,
      ms,
      moduleCount,
    };
  }
  const exempt = classifyExempt(text, coordinate);
  if (exempt) {
    return {
      status: "EXEMPT",
      reason: exempt.reason,
      platform,
      ms,
      // §1 requires the offending module/dep chain, and D52 applies to
      // exemptions too: the blind tail banked machine-local cache paths from
      // whichever shard happened to run the package, which name nothing.
      evidence: exempt.evidence || extractEvidence(text, 500),
    };
  }
  // D52: evidence is the error-bearing slice, never the blind tail. Download
  // chatter is the last thing printed on most failures, so slice(-4) banked
  // 447 of M5's 534 failures with nothing triageable in them — every one of
  // those had to be re-run solo to be diagnosed. `signature` is the
  // root-cause fingerprint the drain loop groups by (npm run ecosystem:clusters).
  const { signature } = failureSignature(text);
  return {
    status: "working-failure",
    reason:
      classifyToolRefusal(text) || classifyFail(text, result.status, verified),
    platform,
    ms,
    signature,
    evidence: extractEvidence(text),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    selfTest();
    return;
  }

  if (freeBytes() < MIN_FREE_BYTES * 2) {
    console.error("[walk] refusing to start: need at least 4GB free disk");
    process.exit(3);
  }
  if (opts.logPath) {
    walkLogPath = opts.logPath;
    fs.mkdirSync(path.dirname(walkLogPath), { recursive: true });
    console.log(`[walk] SCRATCH LOG ${walkLogPath} — ground truth untouched`);
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const stamp = gitStamp(root);
  rotateIfNeeded();
  const { done, timeoutCounts } = loadDoneSet();

  let entries = snapshot.packages;
  if (opts.only) {
    const wanted = new Set(opts.only.split(","));
    entries = entries.filter((e) => wanted.has(`${e.name}@${e.version}`));
  } else {
    entries = entries.slice(opts.offset, opts.limit ? opts.offset + opts.limit : undefined);
  }

  const pending = [];
  let skippedDone = 0;
  for (const entry of entries) {
    const coordinate = `${entry.name}@${entry.version}`;
    if (!opts.only && done.has(coordinate)) {
      skippedDone += 1;
      continue;
    }
    pending.push(entry);
  }
  // Repeat-timeout packages go LAST: re-queuing them first made every
  // fleet spend its opening hour re-burning 900s on the same megamodule
  // pathologicals and look dead at the first heartbeat.
  pending.sort((a, b) => {
    const ta = timeoutCounts.get(`${a.name}@${a.version}`) || 0;
    const tb = timeoutCounts.get(`${b.name}@${b.version}`) || 0;
    return ta - tb;
  });

  console.log(
    `[walk] commit=${stamp.short} dirty=${stamp.dirty} snapshot=${snapshot.packages.length} selected=${entries.length} done=${skippedDone} pending=${pending.length} -j${opts.concurrency}${opts.dryRun ? " DRY-RUN" : ""}`,
  );

  fs.mkdirSync(opts.cacheDir, { recursive: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const tally = {};
  let processed = 0;
  await mapPool(pending, opts.concurrency, async (entry) => {
    const coordinate = `${entry.name}@${entry.version}`;
    const candidacy = classifyCandidacy(entry);
    const base = {
      ts: new Date().toISOString(),
      name: entry.name,
      version: entry.version,
      commit: stamp.short,
      dirty: stamp.dirty,
    };

    let record;
    if (!candidacy.candidate) {
      record = { ...base, status: "EXEMPT", reason: candidacy.reason, ms: 0 };
    } else if (opts.dryRun) {
      record = { ...base, status: "DRY-CANDIDATE", ms: 0 };
    } else {
      record = { ...base, ...(await portOne(entry, stamp, opts)) };
    }

    if (!opts.dryRun) {
      appendRecord(record);
      if (candidacy.candidate) {
        const out = path.join(outRoot, entry.name.replace("/", "__") + `__${entry.version}`);
        try {
          cleanupAfterRecord(entry, out, opts.cacheDir);
        } catch {
          /* cleanup is best-effort */
        }
      }
      if (freeBytes() < MIN_FREE_BYTES) {
        console.error(`[walk] ABORT: free disk below ${MIN_FREE_BYTES} bytes — resume after cleanup`);
        process.exit(3);
      }
    }
    processed += 1;
    const key = record.reason ? `${record.status}:${record.reason}` : record.status;
    tally[key] = (tally[key] || 0) + 1;
    const note = record.status === "PASS" ? `ok (${record.ms}ms)` : `${record.status} ${record.reason || ""} (${record.ms}ms)`;
    console.log(`[${processed}/${pending.length}] ${coordinate} ${note}`);
  });

  console.log("\n[walk] histogram:");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
