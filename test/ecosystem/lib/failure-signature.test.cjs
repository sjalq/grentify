#!/usr/bin/env node
/**
 * Unit tests for test/ecosystem/lib/failure-signature.cjs.
 *
 * Covers: evidence extraction never returns download chatter when a real
 * error is present (the M5 walk's blind-tail defect), JSON and banner error
 * paths, dep-vs-root siting, and signature stability across packages that
 * differ only in identifiers.
 */
"use strict";

const assert = require("node:assert/strict");
const {
  extractEvidence,
  failureSignature,
  normalize,
} = require("./failure-signature.cjs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (err) {
    failed += 1;
    console.error("  FAIL " + name + "\n        " + err.message);
  }
}

const CHATTER = [
  "Starting downloads...",
  "    gren-lang/core [32m✔[39m",
  "    gren-lang/url [32m✔[39m",
  "  - Inspect elm-to-gren.report.json for the transformed package diagnostics.",
].join("\n");

const BANNER_FAIL = [
  "-- TYPE MISMATCH ------------- src/Csv/Decode.gren",
  "",
  "The 1st argument to `sortBy` is not what I expect:",
  "",
  CHATTER,
].join("\n");

const JSON_FAIL = JSON.stringify({
  type: "compile-errors",
  errors: [
    {
      path: "/tmp/out/.elm-to-gren/packages/elmcraft_core-extra__2_3_0/src/Order/Extra.gren",
      name: "Order.Extra",
      problems: [
        {
          title: "NAMING ERROR",
          message: ["I cannot find a `Basics.compare` variable:\n\n12| foo"],
        },
      ],
    },
  ],
});

// --- evidence extraction -----------------------------------------------------

check("evidence: banner beats trailing download chatter", () => {
  const evidence = extractEvidence(BANNER_FAIL);
  assert.match(evidence, /TYPE MISMATCH/);
  assert.doesNotMatch(evidence, /Starting downloads/);
});

check("evidence: summarizes compile-errors JSON instead of truncating it", () => {
  const evidence = extractEvidence(`${JSON_FAIL}\n${CHATTER}`);
  assert.match(evidence, /NAMING ERROR @ Order\.Extra/);
  assert.doesNotMatch(evidence, /gren-lang\/core/);
});

check("evidence: falls back to tool refusal codes", () => {
  const evidence = extractEvidence(`${CHATTER}\nPORT_TIMEOUT after 300000ms`);
  assert.match(evidence, /PORT_TIMEOUT/);
});

check("evidence: chatter-only input degrades, never throws", () => {
  assert.equal(typeof extractEvidence(CHATTER), "string");
});

// --- signatures --------------------------------------------------------------

check("signature: timeout is its own class", () => {
  assert.equal(failureSignature("PORT_TIMEOUT after 300000ms").signature, "timeout");
});

check("signature: failure inside a vendored dep is sited 'dep'", () => {
  assert.equal(failureSignature(JSON_FAIL).site, "dep");
});

check("signature: failure in the root package is sited 'root'", () => {
  assert.equal(failureSignature(BANNER_FAIL).site, "root");
});

check("signature: identical bug in two packages collapses to one string", () => {
  const a = failureSignature(
    "-- NAMING ERROR --- src/A.gren\n\nI cannot find a `Alpha.thing` variable:",
  );
  const b = failureSignature(
    "-- NAMING ERROR --- src/Zzz/Other.gren\n\nI cannot find a `Beta.other` variable:",
  );
  assert.equal(a.signature, b.signature);
});

check("signature: different titles never collapse", () => {
  const a = failureSignature("-- NAMING ERROR --- src/A.gren\n\nI cannot find x:");
  const b = failureSignature("-- SHADOWING --- src/A.gren\n\nI cannot find x:");
  assert.notEqual(a.signature, b.signature);
});

check("signature: evidence with no error at all is unclassified", () => {
  assert.equal(failureSignature(CHATTER).signature, "unclassified:no-evidence");
});

check("signature: pre-existing banked evidence lines re-signature", () => {
  // Walk records banked before this module existed store the tool's own
  // summary lines; the same signature must come back out of them.
  const banked = "TYPE MISMATCH @ Csv.Decode: The 1st argument to `sortBy` is not what I expect:";
  assert.match(failureSignature(banked).signature, /^TYPE MISMATCH @ root:/);
});

// --- normalize ---------------------------------------------------------------

check("normalize: redacts identifiers, strings, modules, and numbers", () => {
  assert.equal(
    normalize('`foo` said "bar" in Json.Decode at line 42'),
    "‹id› said ‹str› in ‹Mod› at line N",
  );
});

// --- exit --------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} failure-signature test(s) FAILED`);
  process.exit(1);
}
console.log("\nall failure-signature tests passed");
process.exit(0);
