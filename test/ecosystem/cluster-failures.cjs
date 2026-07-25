#!/usr/bin/env node
/**
 * Cluster walk failures by ROOT CAUSE, not by compiler-message bucket.
 *
 * Why: the M5 histogram counts symptoms (type-mismatch 82, naming 59, ...).
 * D41, D45b and D49 each spread across several of those buckets while being
 * ONE transform bug, so the bucket counts say nothing about how many fixes
 * remain. This groups by `failure-signature` fingerprint instead, which is
 * the unit a drain loop actually consumes.
 *
 * Also re-states the accounting honestly (§1 admits no size-based and no
 * tool-policy exemption), and reports triage debt: failures whose banked
 * evidence contains no error at all and therefore still need a solo re-run.
 *
 * Usage:
 *   node test/ecosystem/cluster-failures.cjs [--top N] [--reason R] [--json]
 *     [--site dep|root] [--examples N]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { failureSignature } = require("./lib/failure-signature.cjs");

const root = path.resolve(__dirname, "../..");
const walkLogPath = path.join(root, "test/ecosystem/walk-log.jsonl");
const snapshotPath = path.join(root, "test/ecosystem/registry-snapshot.json");

/** Our own refusals, banked as EXEMPT before D51 split them out. */
const TOOL_REFUSAL = /ARCHIVE_INVALID|SOURCE_INVALID|SOURCE_MANIFEST_MISMATCH/;

function parseArgs(argv) {
  const opts = { top: 25, examples: 3, json: false, reason: null, site: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--examples") opts.examples = Number(argv[++i]);
    else if (a === "--reason") opts.reason = argv[++i];
    else if (a === "--site") opts.site = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Latest verdict wins, across the live log and every rotation. */
function loadRecords() {
  const latest = new Map();
  const read = (buf) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (!rec.name || rec.status === "DRY-CANDIDATE") continue;
        latest.set(`${rec.name}@${rec.version}`, rec);
      } catch {
        /* tolerate torn tail line */
      }
    }
  };
  let n = 1;
  while (fs.existsSync(`${walkLogPath}.${n}.gz`)) {
    read(zlib.gunzipSync(fs.readFileSync(`${walkLogPath}.${n}.gz`)));
    n += 1;
  }
  if (fs.existsSync(walkLogPath)) read(fs.readFileSync(walkLogPath));
  return [...latest.values()];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const records = loadRecords();
  if (records.length === 0) {
    console.error("no walk records found — run scripts/walk-universe.cjs first");
    process.exit(1);
  }

  const pass = records.filter((r) => r.status === "PASS");
  const exempt = records.filter((r) => r.status === "EXEMPT");
  const failures = records.filter((r) => r.status === "working-failure");

  // D51: exemptions that are really our own refusals belong in the queue.
  const misfiled = exempt.filter((r) => TOOL_REFUSAL.test(r.evidence || ""));
  const trueExempt = exempt.length - misfiled.length;
  const queue = failures.length + misfiled.length;

  const clusters = new Map();
  let noEvidence = 0;
  for (const rec of [...failures, ...misfiled]) {
    if (opts.reason && rec.reason !== opts.reason) continue;
    const sig = rec.signature
      ? { signature: rec.signature, site: rec.site || "?" }
      : failureSignature(rec.evidence || "");
    if (sig.signature === "unclassified:no-evidence") noEvidence += 1;
    if (opts.site && sig.site !== opts.site) continue;
    const entry = clusters.get(sig.signature) || {
      signature: sig.signature,
      site: sig.site,
      count: 0,
      reasons: {},
      packages: [],
    };
    entry.count += 1;
    entry.reasons[rec.reason] = (entry.reasons[rec.reason] || 0) + 1;
    entry.packages.push(`${rec.name}@${rec.version}`);
    clusters.set(sig.signature, entry);
  }

  const ranked = [...clusters.values()].sort((a, b) => b.count - a.count);
  const snapshot = fs.existsSync(snapshotPath)
    ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")).packages.length
    : records.length;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          snapshot,
          pass: pass.length,
          exempt: trueExempt,
          misfiledExempt: misfiled.length,
          queue,
          distinctSignatures: ranked.length,
          noEvidence,
          clusters: ranked.slice(0, opts.top),
        },
        null,
        2,
      ),
    );
    return;
  }

  const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
  console.log("WALK ACCOUNTING (latest verdict wins)");
  console.log(`  snapshot                ${String(snapshot).padStart(6)}`);
  console.log(`  walked                  ${String(records.length).padStart(6)}`);
  console.log(`  PASS                    ${String(pass.length).padStart(6)}   ${pct(pass.length, records.length)} of universe`);
  console.log(`  EXEMPT (kernel/glsl/gone)${String(trueExempt).padStart(5)}`);
  console.log(`  EXEMPT misfiled (D51)   ${String(misfiled.length).padStart(6)}   our refusals — returned to the queue`);
  console.log(`  QUEUE (working failures)${String(queue).padStart(6)}`);
  console.log(
    `  pass rate over non-exempt ${pct(pass.length, pass.length + queue)}  (${pass.length}/${pass.length + queue})`,
  );
  console.log("");
  console.log(
    `ROOT-CAUSE CLUSTERS: ${ranked.length} distinct signatures over ${queue} packages`,
  );
  if (noEvidence > 0) {
    console.log(
      `  TRIAGE DEBT: ${noEvidence} failures banked with no error in their evidence (D52).`,
    );
    console.log(
      "  Those need a re-run to be diagnosed; records walked after the D52 fix carry signatures.",
    );
  }
  console.log("");
  for (const c of ranked.slice(0, opts.top)) {
    const reasons = Object.entries(c.reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    console.log(`${String(c.count).padStart(5)}  ${c.signature}`);
    console.log(`       site=${c.site}  ${reasons}`);
    console.log(`       e.g. ${c.packages.slice(0, opts.examples).join(", ")}`);
  }
  const shown = ranked.slice(0, opts.top).reduce((s, c) => s + c.count, 0);
  if (ranked.length > opts.top) {
    console.log(
      `\n  ... ${ranked.length - opts.top} more signatures covering ${queue - shown} packages (--top N)`,
    );
  }
}

main();
