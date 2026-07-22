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

const root = path.resolve(__dirname, "..");
const snapshotPath = path.join(root, "test/ecosystem/registry-snapshot.json");
const walkLogPath = path.join(root, "test/ecosystem/walk-log.jsonl");
const cacheDir = path.join(root, ".test-cache", "walk", "cache");
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

/** Port-tool refusal codes that mean "excluded by design", not "bug". */
const EXEMPT_SIGNATURES = [
  { pattern: /Elm\.Kernel|KERNEL/i, reason: "kernel:source" },
  { pattern: /\[glsl\||GLSL/, reason: "glsl:source" },
  { pattern: /effect module/i, reason: "effect-module:source" },
  {
    pattern: /SOURCE_CLONE_FAILED|ARCHIVE_INVALID|SOURCE_MANIFEST_MISMATCH|couldn't find a compatible version|NO_ELM_SOURCES/,
    reason: "broken-upstream:unfetchable",
  },
];

function classifyExempt(text) {
  for (const sig of EXEMPT_SIGNATURES) {
    if (sig.pattern.test(text)) return sig.reason;
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
  const readLines = (buf) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.name && rec.version && rec.status !== "DRY-CANDIDATE") {
          done.add(`${rec.name}@${rec.version}`);
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
  return done;
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
  const exemptCases = [
    ["uses Elm.Kernel.Scheduler", "kernel:source"],
    ["contains [glsl| shader", "glsl:source"],
    ["this is an effect module", "effect-module:source"],
    ["SOURCE_CLONE_FAILED: gone", "broken-upstream:unfetchable"],
    ["TYPE MISMATCH in Main.elm", null],
  ];
  for (const [text, want] of exemptCases) {
    const got = classifyExempt(text);
    if (got !== want) {
      failed += 1;
      console.error(`FAIL exempt "${text}": got ${got}, want ${want}`);
    }
  }
  if (failed > 0) {
    console.error(`walker self-test: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log(`walker self-test: ${cases.length + exemptCases.length} checks green`);
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
    concurrency: defaultConcurrency(9),
    timeoutMs: Number(process.env.PORT_TIMEOUT_MS || 360000),
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
  }
  return opts;
}

async function portOne(entry, stamp, opts) {
  const coordinate = `${entry.name}@${entry.version}`;
  const out = path.join(outRoot, entry.name.replace("/", "__") + `__${entry.version}`);
  fs.rmSync(out, { recursive: true, force: true });

  const attempt = (platformArgs) =>
    spawnCapture(
      process.execPath,
      [cli, coordinate, "--out", out, "--cache", cacheDir, ...platformArgs],
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
  const exemptReason = classifyExempt(text);
  if (exemptReason) {
    return {
      status: "EXEMPT",
      reason: exemptReason,
      platform,
      ms,
      evidence: text.split("\n").filter(Boolean).slice(-4).join("\n").slice(0, 500),
    };
  }
  return {
    status: "working-failure",
    reason: classifyFail(text, result.status, verified),
    platform,
    ms,
    evidence: text.split("\n").filter(Boolean).slice(-4).join("\n").slice(0, 500),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    selfTest();
    return;
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const stamp = gitStamp(root);
  rotateIfNeeded();
  const done = loadDoneSet();

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

  console.log(
    `[walk] commit=${stamp.short} dirty=${stamp.dirty} snapshot=${snapshot.packages.length} selected=${entries.length} done=${skippedDone} pending=${pending.length} -j${opts.concurrency}${opts.dryRun ? " DRY-RUN" : ""}`,
  );

  fs.mkdirSync(cacheDir, { recursive: true });
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
