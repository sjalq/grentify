#!/usr/bin/env node
/**
 * Browser-platform candidate suite. Catalog is not proof; full unfiltered run is.
 */
const path = require("node:path");
const { runSuite, parseSuiteArgs } = require("./lib/suite.cjs");

const root = path.resolve(__dirname, "../..");
const args = parseSuiteArgs();
runSuite({
  root,
  suiteId: "browser",
  catalogPath: path.join(__dirname, "packages-browser.json"),
  cacheDir: path.join(root, ".test-cache", "ecosystem-browser", "cache"),
  outDir: path.join(root, ".test-cache", "ecosystem-browser", "out"),
  minPackages: 200,
  platformArg: ["--platform", "browser"],
  args,
  mode: "full",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
