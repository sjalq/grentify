#!/usr/bin/env node
/**
 * Print ecosystem port success for THIS git tree only.
 *
 * Never invents counts from catalogs or old logs.
 */
const fs = require("node:fs");
const path = require("node:path");
const { gitStamp, proofPath } = require("./lib/git-stamp.cjs");

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

if (!fs.existsSync(dest)) {
  console.log("Verified on this tree: NO PROOF");
  console.log(`  missing ${path.relative(root, dest)}`);
  console.log("  run: npm run test:ecosystem");
  console.log("       npm run test:ecosystem-browser");
  process.exit(2);
}

let proof;
try {
  proof = JSON.parse(fs.readFileSync(dest, "utf8"));
} catch (err) {
  console.log("Verified on this tree: INVALID PROOF FILE");
  console.log(`  ${err.message}`);
  process.exit(2);
}

if (proof.role !== "suite-proof") {
  console.log("Verified on this tree: INVALID PROOF (bad role)");
  process.exit(2);
}

const sameCommit = proof.git && proof.git.commit === stamp.commit;
const sameDirty =
  proof.git && Boolean(proof.git.dirty) === Boolean(stamp.dirty);

if (!sameCommit || !sameDirty) {
  console.log("Verified on this tree: STALE PROOF");
  console.log(
    `  proof commit: ${proof.git?.short || proof.git?.commit || "?"} dirty=${proof.git?.dirty}`,
  );
  console.log(
    `  this tree:    ${stamp.short} dirty=${stamp.dirty}`,
  );
  console.log("  re-run suites on this commit for a valid count");
  process.exit(2);
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
if (pureOk && browserOk) {
  process.exit(0);
}
// Partial proof is informative but non-zero so automation does not treat it as full green.
process.exit(pureOk || browserOk ? 1 : 2);
