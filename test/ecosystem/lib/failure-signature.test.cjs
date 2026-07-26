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

// --- D69: gren's {"type":"error"} reports ------------------------------------

/** The wrapper `Verify.Package` puts in front of gren's own output. */
function wrapped(dir, body) {
  return [
    "[phase] verify some/package",
    "GREN_VERIFY_FAILED: some/package 1.0.0 failed `gren docs` in " + dir,
    "gren exited with code 1.",
    body,
    CHATTER,
  ].join("\n");
}

const DEP_DIR =
  "/tmp/.out.elm-to-gren-abc/.elm-to-gren/packages/elmcraft_core-extra__2_3_0";

const AMBIGUOUS = JSON.stringify({
  type: "error",
  path: "gren.json",
  title: "AMBIGUOUS MODULE NAME",
  message: [
    'The "exposed-modules" of your gren.json lists the following module:\n\n    Dict.Extra\n\nBut a module from elm-community/dict-extra already uses that name.',
  ],
});

// gren emits this one pretty-printed, with `message` as a bare string.
const INCOMPATIBLE = JSON.stringify(
  {
    type: "error",
    title: "INCOMPATIBLE PACKAGE",
    path: "",
    message:
      "elm-community/typed-svg targets the browser platform.\n\nHowever, the current project targets the common, which is not compatible.",
  },
  null,
  4,
);

check("evidence: {\"type\":\"error\"} report beats the wrapper line", () => {
  const evidence = extractEvidence(wrapped(DEP_DIR, AMBIGUOUS));
  assert.match(evidence, /AMBIGUOUS MODULE NAME/);
  assert.match(evidence, /Dict\.Extra/);
  assert.doesNotMatch(evidence, /exited with code/);
});

check("evidence: pretty-printed report with a string message is read", () => {
  const evidence = extractEvidence(wrapped("/tmp/out.staging", INCOMPATIBLE));
  assert.match(evidence, /INCOMPATIBLE PACKAGE/);
  assert.match(evidence, /targets the browser platform/);
});

check("signature: a gren error report names the real problem", () => {
  const { title, detail } = failureSignature(wrapped(DEP_DIR, AMBIGUOUS));
  assert.equal(title, "AMBIGUOUS MODULE NAME");
  assert.match(detail, /lists the following module/);
});

check("signature: the verify wrapper sites a dependency's failure as 'dep'", () => {
  assert.equal(failureSignature(wrapped(DEP_DIR, AMBIGUOUS)).site, "dep");
  assert.equal(
    failureSignature(wrapped("/tmp/out.staging", AMBIGUOUS)).site,
    "root",
  );
});

check("signature: banked evidence re-signatures to the same dep siting", () => {
  const raw = wrapped(DEP_DIR, AMBIGUOUS);
  const banked = extractEvidence(raw);
  assert.equal(failureSignature(banked).site, failureSignature(raw).site);
  assert.equal(failureSignature(banked).title, failureSignature(raw).title);
});

check("signature: styled message chunks are never `[object Object]`", () => {
  const styled = JSON.stringify({
    type: "compile-errors",
    errors: [
      {
        path: "src/Main.gren",
        name: "Main",
        problems: [
          {
            title: "TYPE MISMATCH",
            message: [
              "The 1st argument to ",
              { bold: false, underline: false, color: "yellow", string: "sortBy" },
              " is not what I expect:",
            ],
          },
        ],
      },
    ],
  });
  const { detail } = failureSignature(styled);
  assert.doesNotMatch(detail, /object Object/);
  assert.match(detail, /is not what I expect/);
});

check("signature: two packages hitting one gren error report collapse", () => {
  const a = failureSignature(
    wrapped(DEP_DIR, AMBIGUOUS.replace(/Dict\.Extra/g, "List.Extra")),
  );
  const b = failureSignature(wrapped(DEP_DIR, AMBIGUOUS));
  assert.equal(a.signature, b.signature);
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
