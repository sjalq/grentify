#!/usr/bin/env node
/**
 * Pure-platform candidate suite. Catalog is not proof; full unfiltered run is.
 */
const path = require("node:path");
const { runSuite, parseSuiteArgs } = require("./lib/suite.cjs");

const root = path.resolve(__dirname, "../..");
const args = parseSuiteArgs();
runSuite({
  root,
  suiteId: "pure",
  catalogPath: path.join(__dirname, "packages.json"),
  cacheDir: path.join(root, ".test-cache", "ecosystem", "cache"),
  outDir: path.join(root, ".test-cache", "ecosystem", "out"),
  minPackages: 200,
  args,
  mode: "full",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
