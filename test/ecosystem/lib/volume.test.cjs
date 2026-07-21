#!/usr/bin/env node
/**
 * Unit tests for test/ecosystem/lib/volume.cjs.
 *
 * Covers: volume detection thresholds, adaptive timeouts, and
 * the classifyTimeout decision table (D9 fix).
 */
"use strict";

const assert = require("node:assert/strict");
const {
  THRESHOLDS,
  isVolume,
  adaptiveTimeoutMs,
  classifyTimeout,
} = require("./volume.cjs");

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

function metrics(over) {
  return Object.assign(
    {
      modules: 50,
      totalBytes: 100_000,
      maxModuleBytes: 5_000,
      volume: false,
      summary: "50 modules, 100000 bytes, max 5000",
    },
    over,
  );
}

// --- volume detection --------------------------------------------------------

check("THRESHOLDS match spec (100KB max module, 200 modules, 400KB total)", () => {
  assert.equal(THRESHOLDS.maxModuleBytes, 100_000);
  assert.equal(THRESHOLDS.modules, 200);
  assert.equal(THRESHOLDS.totalBytes, 400_000);
});

check("isVolume: maxModuleBytes >= 100KB triggers volume", () => {
  assert.ok(isVolume(metrics({ maxModuleBytes: 100_000 })));
  assert.ok(!isVolume(metrics({ maxModuleBytes: 99_999 })));
});

check("isVolume: modules >= 200 triggers volume", () => {
  assert.ok(isVolume(metrics({ modules: 200 })));
  assert.ok(!isVolume(metrics({ modules: 199 })));
});

check("isVolume: totalBytes >= 400KB triggers volume", () => {
  assert.ok(isVolume(metrics({ totalBytes: 400_000 })));
  assert.ok(!isVolume(metrics({ totalBytes: 399_999 })));
});

// --- adaptive timeouts -------------------------------------------------------

check("adaptiveTimeoutMs: non-volume returns base timeout", () => {
  const base = 120_000;
  const m = metrics({ volume: false });
  assert.equal(adaptiveTimeoutMs(m, base), base);
});

check("adaptiveTimeoutMs: volume raises timeout based on size", () => {
  const m = metrics({ volume: true, modules: 300, totalBytes: 800_000 });
  const timeout = adaptiveTimeoutMs(m, 120_000);
  assert.ok(timeout > 120_000, `volume timeout ${timeout} should exceed base 120000`);
  assert.ok(timeout <= 25 * 60_000, `volume timeout ${timeout} should be capped at 1500000`);
});

// --- classifyTimeout decision table (D9 fix) --------------------------------

check("classifyTimeout: NOT timedOut => 'timeout' (non-volume)", () => {
  const m = metrics({ volume: false });
  assert.equal(classifyTimeout(false, m, 120_000), "timeout");
});

check("classifyTimeout: NOT timedOut => 'timeout' (volume)", () => {
  const m = metrics({ volume: true });
  assert.equal(classifyTimeout(false, m, 500_000), "timeout");
});

check("classifyTimeout: timedOut AND volume => 'scale'", () => {
  const m = metrics({ volume: true });
  assert.equal(classifyTimeout(true, m, 120_000), "scale");
  assert.equal(classifyTimeout(true, m, 25 * 60_000), "scale");
});

check("classifyTimeout: timedOut AND NOT volume => 'hang' (small budget)", () => {
  const m = metrics({ volume: false });
  assert.equal(classifyTimeout(true, m, 120_000), "hang");
});

check("classifyTimeout: timedOut AND NOT volume => 'hang' (D9 regression: large budget)", () => {
  const m = metrics({ volume: false });
  // D9 bug: budget >= 8 min used to excuse non-volume timeouts as "scale"
  // Fixed: non-volume timeouts are ALWAYS "hang", regardless of budget
  assert.equal(classifyTimeout(true, m, 8 * 60_000), "hang");
  assert.equal(classifyTimeout(true, m, 10 * 60_000), "hang");
  assert.equal(classifyTimeout(true, m, 25 * 60_000), "hang");
});

check("classifyTimeout: null metrics with timeout => 'hang'", () => {
  // null metrics = no volume info, cannot be scale
  assert.equal(classifyTimeout(true, null, 120_000), "hang");
  assert.equal(classifyTimeout(true, null, 8 * 60_000), "hang");
});

check("classifyTimeout: undefined metrics with timeout => 'hang'", () => {
  // undefined metrics = no volume info, cannot be scale
  assert.equal(classifyTimeout(true, undefined, 120_000), "hang");
});

// --- exit --------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} volume test(s) FAILED`);
  process.exit(1);
}
console.log("\nall volume tests passed");
process.exit(0);
