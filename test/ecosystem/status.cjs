#!/usr/bin/env node
/**
 * Print ecosystem port success for THIS git tree only.
 *
 * Never invents counts from catalogs or old logs.
 *
 * Also prints a LEDGER section (ledger law): totals by state, coverage vs
 * the registry snapshot, count of STALE entries (entry.commit predates the last
 * src/ change), and — when a valid suite proof exists — reconciliation of suite
 * failures against evidenced working-failure ledger entries. The ledger section
 * is informational: it prints regardless of proof state and does not change the
 * proof-driven exit code.
 */
const fs = require("node:fs");
const path = require("node:path");
const { gitStamp, proofPath } = require("./lib/git-stamp.cjs");
const {
  validateLedger,
  summarizeTotals,
  countStale,
  staleEntries,
  reconcileFailures,
  makeGitResolver,
} = require("./lib/ledger.cjs");

const root = path.resolve(__dirname, "../..");
const stamp = gitStamp(root);
const dest = proofPath(root);

function loadCatalogCount(rel) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    return Array.isArray(c.packages) ? c.packages.length : null;
  } catch {
    return null;
  }
}

const pureCandidates = loadCatalogCount("test/ecosystem/packages.json");
const browserCandidates = loadCatalogCount(
  "test/ecosystem/packages-browser.json",
);

console.log("elm-to-gren ecosystem status");
console.log("===========================");
console.log(
  `git: ${stamp.short} (${stamp.branch})${stamp.dirty ? " DIRTY" : ""}`,
);
console.log(`    ${stamp.subject}`);
console.log("");
console.log("Candidate suite sizes (NOT success counts):");
console.log(`  pure catalog:    ${pureCandidates ?? "?"} packages`);
console.log(`  browser catalog: ${browserCandidates ?? "?"} packages`);
console.log("");

/**
 * Print the "Verified on this tree" proof section exactly as before, but return
 * an { exitCode, proof } pair instead of exiting directly, so the LEDGER
 * section below still prints in every proof state.
 */
function proofSection() {
  if (!fs.existsSync(dest)) {
    console.log("Verified on this tree: NO PROOF");
    console.log(`  missing ${path.relative(root, dest)}`);
    console.log("  run: npm run test:ecosystem");
    console.log("       npm run test:ecosystem-browser");
    return { exitCode: 2, proof: null };
  }

  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(dest, "utf8"));
  } catch (err) {
    console.log("Verified on this tree: INVALID PROOF FILE");
    console.log(`  ${err.message}`);
    return { exitCode: 2, proof: null };
  }

  if (proof.role !== "suite-proof") {
    console.log("Verified on this tree: INVALID PROOF (bad role)");
    return { exitCode: 2, proof: null };
  }

  const sameCommit = proof.git && proof.git.commit === stamp.commit;
  const sameDirty =
    proof.git && Boolean(proof.git.dirty) === Boolean(stamp.dirty);

  if (!sameCommit || !sameDirty) {
    console.log("Verified on this tree: STALE PROOF");
    console.log(
      `  proof commit: ${proof.git?.short || proof.git?.commit || "?"} dirty=${proof.git?.dirty}`,
    );
    console.log(`  this tree:    ${stamp.short} dirty=${stamp.dirty}`);
    console.log("  re-run suites on this commit for a valid count");
    return { exitCode: 2, proof: null };
  }

  const pure = proof.suites?.pure;
  const browser = proof.suites?.browser;

  function line(id, rec, candidateN) {
    if (!rec) {
      return `  ${id}: NOT RUN (catalog has ${candidateN ?? "?"} candidates)`;
    }
    const tag = rec.status === "pass" ? "PASS" : "FAIL";
    return `  ${id}: ${tag} ${rec.passed}/${rec.total}  (${rec.finishedAt})`;
  }

  console.log("Verified on this tree (commit-stamped proof only):");
  console.log(line("pure", pure, pureCandidates));
  console.log(line("browser", browser, browserCandidates));

  if (pure?.failures?.length) {
    console.log("  pure failures:");
    for (const f of pure.failures.slice(0, 20)) {
      console.log(`    - ${f.package} [${f.reason}]`);
    }
    if (pure.failures.length > 20) {
      console.log(`    ... +${pure.failures.length - 20} more`);
    }
  }
  if (browser?.failures?.length) {
    console.log("  browser failures:");
    for (const f of browser.failures.slice(0, 20)) {
      console.log(`    - ${f.package} [${f.reason}]`);
    }
    if (browser.failures.length > 20) {
      console.log(`    ... +${browser.failures.length - 20} more`);
    }
  }

  console.log("");
  console.log(`proof file: ${path.relative(root, dest)}`);
  console.log(
    "Do not cite .test-cache/**/summary.json, prove-log.json, or *.log as success.",
  );

  const pureOk = pure?.status === "pass";
  const browserOk = browser?.status === "pass";
  let exitCode;
  if (pureOk && browserOk) {
    exitCode = 0;
  } else {
    // Partial proof is informative but non-zero so automation does not treat it
    // as full green.
    exitCode = pureOk || browserOk ? 1 : 2;
  }
  return { exitCode, proof };
}

/**
 * LEDGER section (ledger law). Always prints. `proof` is the loaded suite
 * proof, or null when there is no valid proof on this tree.
 */
function ledgerSection(proof) {
  const ledgerPath = path.join(root, "test/ecosystem/ledger.json");
  const snapshotPath = path.join(root, "test/ecosystem/registry-snapshot.json");

  console.log("");
  console.log("LEDGER (test/ecosystem/ledger.json)");
  console.log("-----------------------------------");

  if (!fs.existsSync(ledgerPath)) {
    console.log("  no ledger yet — run: node test/ecosystem/seed-ledger.cjs");
    return;
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch (err) {
    console.log(`  INVALID LEDGER FILE: ${err.message}`);
    return;
  }

  const errs = validateLedger(ledger);
  if (errs.length) {
    console.log(`  LEDGER INVALID (${errs.length} error(s)):`);
    for (const m of errs.slice(0, 10)) console.log(`    - ${m}`);
  }

  const { total, byState } = summarizeTotals(ledger);
  console.log("  totals by state:");
  for (const [state, n] of Object.entries(byState)) {
    if (n > 0) console.log(`    ${n}\t${state}`);
  }

  // Coverage vs registry snapshot.
  let coverage = "no registry snapshot (run: node test/ecosystem/fetch-snapshot.cjs)";
  if (fs.existsSync(snapshotPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      const denom = snap.packageCount ?? (snap.packages || []).length;
      const pct = denom ? ((total / denom) * 100).toFixed(1) : "?";
      coverage = `${total}/${denom} registry packages walked (${pct}%)`;
    } catch (err) {
      coverage = `snapshot invalid: ${err.message}`;
    }
  }
  console.log(`  coverage: ${coverage}`);

  // D8 residual (W3.5 decision, Option B): volume-classified packages are
  // verified RAW — gren-format costs ~9.5 min on the largest specimen
  // (jfmengels/elm-review, measured 2026-07-21) vs the <60s Option-A bar.
  // Surface the class size from the latest suite proofs so the two-artifact
  // reality is never invisible.
  const volumeCounts = [];
  for (const suite of ["pure", "browser"]) {
    const results = proof?.suites?.[suite]?.results || [];
    const n = results.filter((r) => r.volume && r.volume.volume).length;
    if (n > 0) volumeCounts.push(`${n} ${suite}`);
  }
  console.log(
    `  D8 residual: volume packages verified raw (format skipped): ${
      volumeCounts.length > 0 ? volumeCounts.join(", ") : "none in loaded proofs"
    }`,
  );

  // STALE law: entry.commit predates the last commit touching src/.
  const git = makeGitResolver(root);
  const lastSrc = git.lastSrcChangeCommit();
  const stale = countStale(ledger, lastSrc, git);
  console.log(
    `  STALE entries: ${stale} (last src/ change: ${
      lastSrc ? lastSrc.slice(0, 7) : "?"
    })`,
  );
  if (stale > 0) {
    for (const e of staleEntries(ledger, lastSrc, git).slice(0, 10)) {
      console.log(`    - ${e.name} @ ${e.commit}`);
    }
    console.log("    re-walk these on HEAD and reseed the ledger");
  }

  // Reconciliation law: every suite failure -> evidenced working-failure entry.
  if (proof && proof.suites) {
    const failures = [];
    for (const id of Object.keys(proof.suites)) {
      for (const f of proof.suites[id].failures || []) failures.push(f);
    }
    if (failures.length === 0) {
      console.log("  reconciliation: proof has no failures to reconcile");
    } else {
      const rec = reconcileFailures(failures, ledger);
      if (rec.ok) {
        console.log(
          `  reconciliation: OK — all ${failures.length} suite failure(s) have evidenced working-failure entries`,
        );
      } else {
        console.log("  reconciliation: FAIL");
        if (rec.unmatched.length)
          console.log(`    no ledger entry: ${rec.unmatched.join(", ")}`);
        if (rec.wrongState.length)
          console.log(`    not working-failure: ${rec.wrongState.join(", ")}`);
        if (rec.withoutEvidence.length)
          console.log(`    missing evidence: ${rec.withoutEvidence.join(", ")}`);
      }
    }
  } else {
    console.log(
      "  reconciliation: skipped (no valid suite proof on this tree)",
    );
  }
}

const { exitCode, proof } = proofSection();
ledgerSection(proof);
process.exit(exitCode);
