#!/usr/bin/env node
// W4.1 completeness law: every catalog mapping tagged with a "propertyRows"
// entry must have a matching P2 test — present both as a top-level definition
// and in the `tests` array of test/MappingSemanticsTest.gren.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const builtinPath = path.join(root, "mappings/builtin.json");
const testPath = path.join(root, "test/MappingSemanticsTest.gren");

const builtin = JSON.parse(fs.readFileSync(builtinPath, "utf-8"));

const tagged = new Set();
for (const pkg of builtin.packages) {
  for (const mod of pkg.modules) {
    if (mod.propertyRows && typeof mod.propertyRows === "object") {
      for (const value of Object.values(mod.propertyRows)) {
        tagged.add(value);
      }
    }
  }
}

if (tagged.size === 0) {
  console.error("FAIL: no propertyRows tags found in builtin.json (vacuity guard)");
  process.exit(1);
}

const testContent = fs.readFileSync(testPath, "utf-8");

const testsInArray = new Set();
const arrayMatch = testContent.match(/tests\s*:\s*Array\s+TestResult\s*\ntests\s*=\s*\[([\s\S]*?)\]/);
if (arrayMatch) {
  for (const entry of arrayMatch[1].match(/\b([a-z][A-Za-z0-9]*)\b/g) || []) {
    testsInArray.add(entry);
  }
}

const definitions = new Set();
for (const line of testContent.split("\n")) {
  const defMatch = line.match(/^([a-z][A-Za-z0-9]*)\s*:/);
  if (defMatch) {
    definitions.add(defMatch[1]);
  }
}

const missing = [...tagged].filter((tag) => !testsInArray.has(tag) || !definitions.has(tag)).sort();

if (missing.length > 0) {
  console.error("FAIL: propertyRows tags without a matching P2 test:");
  for (const name of missing) {
    const where = !testsInArray.has(name) && !definitions.has(name)
      ? "not in tests array or definitions"
      : !testsInArray.has(name)
        ? "not in tests array"
        : "not defined";
    console.error(`  - ${name} (${where})`);
  }
  process.exit(1);
}

console.log(`PASS: property-rows — all ${tagged.size} tagged rows have matching P2 tests`);
