#!/usr/bin/env node
/**
 * Law: the ledger (ledger law) records the terminal state of every WALKED
 * ecosystem package. This seeder is thin and RERUNNABLE:
 *
 *   1. Enumerates the suite packages from the candidate catalogs (pure +
 *      browser) — these define "the suite".
 *   2. Determines pass/fail + the stamping commit from the commit-stamped suite
 *      proof (.test-cache/ecosystem-proof/LAST_RUN.json) when present; otherwise
 *      falls back to the documented commit-0d0ce41 seed below.
 *   3. Cross-checks every suite package against registry-snapshot.json.
 *   4. Writes ledger.json. Packages not in a suite catalog get NO entry
 *      (not yet walked).
 *
 * All passing suite packages    -> PASS-compile-only (behavior: compile-only).
 * Known failures                -> working-failure with a reason + evidence.
 *
 *   node test/ecosystem/seed-ledger.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { proofPath } = require("./lib/git-stamp.cjs");
const {
  STATE_KEY,
  validateLedger,
  summarizeTotals,
} = require("./lib/ledger.cjs");

const root = path.resolve(__dirname, "../..");
const OUT = path.join(__dirname, "ledger.json");
const SNAPSHOT = path.join(__dirname, "registry-snapshot.json");
const SCHEMA_VERSION = 1;

/**
 * Documented fallback seed (used only when no LAST_RUN.json proof exists in the
 * worktree). Source: latest real suite results — pure 201/202, browser 246/252.
 */
const SEED = {
  commit: "0d0ce41",
  source:
    "documented seed (pure 201/202, browser 246/252) at commit 0d0ce41 — no LAST_RUN.json proof present",
  failures: [
    { name: "jfmengels/elm-review", suite: "pure", reason: "type-mismatch" },
    { name: "mdgriffith/elm-ui", suite: "browser", reason: "exit-1" },
    { name: "eriktim/elm-protocol-buffers", suite: "browser", reason: "exit-1" },
    { name: "j-panasiuk/elm-ionicons", suite: "browser", reason: "timeout" },
    { name: "abinayasudhir/elm-treeview", suite: "browser", reason: "exit-1" },
    {
      name: "curtissimo/elm-native-modal-dialog",
      suite: "browser",
      reason: "type-mismatch",
    },
    { name: "gribouille/elm-treeview", suite: "browser", reason: "exit-1" },
  ],
};

const CATALOGS = [
  { suite: "pure", file: "packages.json" },
  { suite: "browser", file: "packages-browser.json" },
];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadSuitePackages() {
  const out = [];
  for (const { suite, file } of CATALOGS) {
    const catalog = readJson(path.join(__dirname, file));
    for (const pkg of catalog.packages || []) {
      out.push({ name: pkg.name, version: pkg.version, suite });
    }
  }
  return out;
}

/** Collect {name, reason, suite} failures from a commit-stamped proof. */
function failuresFromProof(proof) {
  const rows = [];
  const suites = proof.suites || {};
  for (const suiteId of Object.keys(suites)) {
    const failures = suites[suiteId].failures || [];
    for (const f of failures) {
      const at = String(f.package || "").lastIndexOf("@");
      const name =
        at > 0 ? f.package.slice(0, at) : String(f.package || "");
      rows.push({ name, reason: f.reason || "fail", suite: suiteId });
    }
  }
  return rows;
}

/** ISO date (YYYY-MM-DD) that a commit was authored, via git. */
function commitDate(commitish) {
  const r = spawnSync(
    "git",
    ["show", "-s", "--format=%cs", commitish],
    { cwd: root, encoding: "utf8" },
  );
  if (r.status === 0) {
    const d = (r.stdout || "").trim();
    if (d) return d;
  }
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const suitePackages = loadSuitePackages();

  // Prefer the real commit-stamped proof; fall back to the documented seed.
  let commit;
  let failureRows;
  let seededFrom;
  const dest = proofPath(root);
  if (fs.existsSync(dest)) {
    let proof = null;
    try {
      proof = readJson(dest);
    } catch {
      proof = null;
    }
    if (proof && proof.role === "suite-proof" && proof.git) {
      commit = proof.git.short || proof.git.commit;
      failureRows = failuresFromProof(proof);
      seededFrom = `LAST_RUN.json suite proof @ ${commit}`;
    }
  }
  if (!commit) {
    commit = SEED.commit;
    failureRows = SEED.failures;
    seededFrom = SEED.source;
  }

  const date = commitDate(commit);
  const failByName = new Map(failureRows.map((f) => [f.name, f]));

  const entries = suitePackages
    .map((pkg) => {
      const fail = failByName.get(pkg.name);
      if (fail) {
        return {
          name: pkg.name,
          version: pkg.version,
          state: "working-failure",
          reason: fail.reason,
          evidence: `${fail.suite} suite failure @ ${commit} (${fail.reason})`,
          commit,
          date,
        };
      }
      return {
        name: pkg.name,
        version: pkg.version,
        state: "PASS-compile-only",
        behavior: "compile-only",
        commit,
        date,
      };
    })
    // Stable order (by name) for minimal diffs across reruns.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Cross-check against the registry snapshot (informational).
  let snapshotNote = "registry-snapshot.json not found";
  if (fs.existsSync(SNAPSHOT)) {
    const snap = readJson(SNAPSHOT);
    const registry = new Set((snap.packages || []).map((p) => p.name));
    const missing = entries.filter((e) => !registry.has(e.name));
    snapshotNote =
      missing.length === 0
        ? `all ${entries.length} suite packages present in registry snapshot (${snap.packageCount})`
        : `${missing.length} suite packages NOT in registry snapshot: ${missing
            .map((e) => e.name)
            .join(", ")}`;
  }

  const ledger = {
    schemaVersion: SCHEMA_VERSION,
    role: "ecosystem-ledger",
    law:
      "Every walked package has a terminal state; every suite failure reconciles " +
      "to a working-failure entry with evidence. STALE when entry.commit predates " +
      "the last src/ change (see test/ecosystem/lib/ledger.cjs).",
    stateKey: STATE_KEY,
    seededFrom,
    snapshotCrossCheck: snapshotNote,
    generatedAt: new Date().toISOString(),
    entries,
  };

  const errs = validateLedger(ledger);
  if (errs.length) {
    console.error("ledger validation failed:");
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(ledger, null, 2) + "\n");

  const { total, byState } = summarizeTotals(ledger);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${total} entries`);
  console.log(`  seededFrom: ${seededFrom}`);
  console.log(`  ${snapshotNote}`);
  for (const [state, n] of Object.entries(byState)) {
    if (n > 0) console.log(`  ${state}: ${n}`);
  }
}

main();
