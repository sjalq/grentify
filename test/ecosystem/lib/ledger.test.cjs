#!/usr/bin/env node
/**
 * Unit tests for test/ecosystem/lib/ledger.cjs (pure ledger laws).
 *
 * Pure node — no real git, no filesystem. The STALE law is exercised through an
 * INJECTED git resolver over a tiny fixture commit graph, so the tests need no
 * repository. Covers: state-key validation, STALE computation, totals
 * summarization, and the reconciliation gate predicate.
 */
"use strict";

const assert = require("node:assert/strict");
const {
  STATES,
  STATE_KEY,
  isValidState,
  validateEntry,
  validateLedger,
  summarizeTotals,
  isStale,
  countStale,
  staleEntries,
  reconcileFailures,
  pkgName,
} = require("./ledger.cjs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (e) {
    failed += 1;
    console.error("  FAIL " + name);
    console.error("    " + (e && e.message ? e.message : e));
  }
}

// --- fixtures ----------------------------------------------------------------

function entry(over) {
  return Object.assign(
    {
      name: "owner/pkg",
      version: "1.0.0",
      state: "PASS-compile-only",
      behavior: "compile-only",
      commit: "aaaaaaa",
      date: "2026-07-15",
    },
    over,
  );
}

/**
 * Fake git resolver over a linear fixture graph old -> mid -> new.
 * resolve() expands the known short hashes; unknown -> null.
 * isAncestor(a,b) uses the fixed ordering.
 */
function fakeGit() {
  const order = ["old0000", "mid0000", "new0000"];
  const full = {
    old: "old0000",
    old0000: "old0000",
    mid: "mid0000",
    mid0000: "mid0000",
    new: "new0000",
    new0000: "new0000",
  };
  return {
    resolve(h) {
      return full[h] || null;
    },
    isAncestor(a, b) {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 || ib === -1) return false;
      // a is an ancestor of b iff a is at or before b in the chain.
      return ia <= ib;
    },
  };
}

// --- state-key validation ----------------------------------------------------

check("STATES has the seven canonical states with matching STATE_KEY", () => {
  assert.deepEqual(STATES, [
    "PASS",
    "PASS-compile-only",
    "EXEMPT-kernel",
    "EXEMPT-glsl",
    "EXEMPT-broken-upstream",
    "EXEMPT-mapping-absent",
    "working-failure",
  ]);
  for (const s of STATES) {
    assert.ok(
      typeof STATE_KEY[s] === "string" && STATE_KEY[s].length > 0,
      `STATE_KEY missing description for ${s}`,
    );
  }
  assert.equal(Object.keys(STATE_KEY).length, STATES.length);
});

check("isValidState accepts canonical, rejects bogus", () => {
  assert.ok(isValidState("PASS-compile-only"));
  assert.ok(isValidState("working-failure"));
  assert.ok(!isValidState("PASS-compile"));
  assert.ok(!isValidState("passed"));
  assert.ok(!isValidState(undefined));
});

check("validateEntry: clean PASS-compile-only entry has no errors", () => {
  assert.deepEqual(validateEntry(entry()), []);
});

check("validateEntry: invalid state is reported", () => {
  const errs = validateEntry(entry({ state: "nope" }));
  assert.ok(errs.some((m) => m.includes("invalid state")));
});

check("validateEntry: working-failure requires reason + evidence", () => {
  const missing = validateEntry(
    entry({ state: "working-failure", behavior: undefined }),
  );
  assert.ok(missing.some((m) => m.includes("requires a reason")));
  assert.ok(missing.some((m) => m.includes("requires evidence")));

  const ok = validateEntry(
    entry({
      state: "working-failure",
      behavior: undefined,
      reason: "type-mismatch",
      evidence: "browser suite @ 0d0ce41",
    }),
  );
  assert.deepEqual(ok, []);
});

check("validateEntry: missing name/version/commit/date reported", () => {
  const errs = validateEntry({ state: "PASS" });
  assert.ok(errs.some((m) => m.includes("missing name")));
  assert.ok(errs.some((m) => m.includes("missing version")));
  assert.ok(errs.some((m) => m.includes("missing commit")));
  assert.ok(errs.some((m) => m.includes("missing date")));
});

check("validateLedger: detects duplicate entries and bad shapes", () => {
  assert.deepEqual(validateLedger({ entries: [entry(), entry({ version: "2.0.0" })] }), []);
  const dup = validateLedger({ entries: [entry(), entry()] });
  assert.ok(dup.some((m) => m.includes("duplicate entry")));
  assert.ok(validateLedger(null).length > 0);
  assert.ok(validateLedger({}).length > 0);
});

// --- totals summarization ----------------------------------------------------

check("summarizeTotals: zero-fills all states and counts", () => {
  const ledger = {
    entries: [
      entry({ name: "a/a" }),
      entry({ name: "b/b" }),
      entry({
        name: "c/c",
        state: "working-failure",
        behavior: undefined,
        reason: "exit-1",
        evidence: "e",
      }),
      entry({ name: "d/d", state: "EXEMPT-kernel", behavior: undefined }),
    ],
  };
  const { total, byState } = summarizeTotals(ledger);
  assert.equal(total, 4);
  assert.equal(byState["PASS-compile-only"], 2);
  assert.equal(byState["working-failure"], 1);
  assert.equal(byState["EXEMPT-kernel"], 1);
  assert.equal(byState["PASS"], 0);
  assert.equal(byState["EXEMPT-glsl"], 0);
});

check("summarizeTotals: empty / missing ledger is total 0", () => {
  assert.equal(summarizeTotals({ entries: [] }).total, 0);
  assert.equal(summarizeTotals(null).total, 0);
});

// --- STALE law ---------------------------------------------------------------

check("isStale: entry predating last src change is STALE", () => {
  const git = fakeGit();
  assert.equal(isStale(entry({ commit: "old" }), "new0000", git), true);
  assert.equal(isStale(entry({ commit: "mid" }), "new0000", git), true);
});

check("isStale: entry on the last-src-change commit is NOT stale", () => {
  const git = fakeGit();
  assert.equal(isStale(entry({ commit: "new" }), "new0000", git), false);
  // short-hash on both sides resolves equal
  assert.equal(isStale(entry({ commit: "new0000" }), "new", git), false);
});

check("isStale: entry AFTER last src change is NOT stale", () => {
  const git = fakeGit();
  assert.equal(isStale(entry({ commit: "new" }), "old0000", git), false);
});

check("isStale: unknown commit cannot be proven stale", () => {
  const git = fakeGit();
  assert.equal(isStale(entry({ commit: "zzzzzzz" }), "new0000", git), false);
  assert.equal(isStale(entry({ commit: "old" }), "unknownnn", git), false);
});

check("countStale / staleEntries aggregate correctly", () => {
  const git = fakeGit();
  const ledger = {
    entries: [
      entry({ name: "a/a", commit: "old" }),
      entry({ name: "b/b", commit: "mid" }),
      entry({ name: "c/c", commit: "new" }),
    ],
  };
  assert.equal(countStale(ledger, "new0000", git), 2);
  assert.deepEqual(
    staleEntries(ledger, "new0000", git).map((e) => e.name),
    ["a/a", "b/b"],
  );
});

// --- reconciliation gate predicate ------------------------------------------

check("pkgName strips version but keeps owner/pkg", () => {
  assert.equal(pkgName("owner/pkg@1.2.3"), "owner/pkg");
  assert.equal(pkgName("owner/pkg"), "owner/pkg");
});

check("reconcileFailures: OK when every failure is an evidenced working-failure", () => {
  const ledger = {
    entries: [
      entry({
        name: "jfmengels/elm-review",
        version: "2.16.6",
        state: "working-failure",
        behavior: undefined,
        reason: "type-mismatch",
        evidence: "pure suite @ 0d0ce41",
      }),
      entry({ name: "avh4/elm-color" }),
    ],
  };
  const rec = reconcileFailures(
    [{ package: "jfmengels/elm-review@2.16.6", reason: "type-mismatch" }],
    ledger,
  );
  assert.ok(rec.ok, JSON.stringify(rec));
  assert.deepEqual(rec.unmatched, []);
});

check("reconcileFailures: unmatched failure fails the gate", () => {
  const rec = reconcileFailures(
    [{ package: "ghost/pkg@1.0.0", reason: "exit-1" }],
    { entries: [entry()] },
  );
  assert.ok(!rec.ok);
  assert.deepEqual(rec.unmatched, ["ghost/pkg"]);
});

check("reconcileFailures: matched but wrong state / no evidence fails", () => {
  const ledger = {
    entries: [
      // present but marked PASS-compile-only (wrong state) and no evidence
      entry({ name: "owner/broke", version: "1.0.0" }),
    ],
  };
  const rec = reconcileFailures(
    [{ package: "owner/broke@1.0.0", reason: "exit-1" }],
    ledger,
  );
  assert.ok(!rec.ok);
  assert.deepEqual(rec.wrongState, ["owner/broke"]);
  assert.deepEqual(rec.withoutEvidence, ["owner/broke"]);
});

check("reconcileFailures: accepts bare string labels", () => {
  const ledger = {
    entries: [
      entry({
        name: "owner/broke",
        state: "working-failure",
        behavior: undefined,
        reason: "exit-1",
        evidence: "browser @ 0d0ce41",
      }),
    ],
  };
  const rec = reconcileFailures(["owner/broke@2.0.0"], ledger);
  assert.ok(rec.ok, JSON.stringify(rec));
});

// --- exit --------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} ledger test(s) FAILED`);
  process.exit(1);
}
console.log("\nall ledger tests passed");
process.exit(0);
