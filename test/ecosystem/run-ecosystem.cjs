#!/usr/bin/env node
/**
 * Port a seeded sample of qualifying pure Elm packages and require each run
 * to exit 0 with verification. Qualifying = direct deps ⊆ supported platform
 * packages (see packages.json).
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, "packages.json"), "utf8"),
);
const packages = catalog.packages;
if (!Array.isArray(packages) || packages.length < 200) {
  console.error(
    `ecosystem catalog must list at least 200 packages, got ${packages?.length}`,
  );
  process.exit(1);
}

const cache = path.join(root, ".test-cache", "ecosystem", "cache");
const outRoot = path.join(root, ".test-cache", "ecosystem", "out");
const cli = path.join(root, "bin", "elm-to-gren.cjs");

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const results = [];
let failed = 0;

for (const pkg of packages) {
  const label = `${pkg.name}@${pkg.version ?? "latest"}`;
  // Pin the catalog version so the seeded sample is reproducible.
  const input = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
  const out = path.join(
    outRoot,
    pkg.name.replace("/", "__") + (pkg.version ? `__${pkg.version}` : ""),
  );
  fs.rmSync(out, { recursive: true, force: true });

  process.stdout.write(`port ${label} ... `);
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [cli, input, "--out", out, "--cache", cache],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const ms = Date.now() - started;
  const ok = result.status === 0;
  const reportPath = path.join(out, "elm-to-gren.report.json");
  let verified = false;
  if (ok && fs.existsSync(reportPath)) {
    try {
      verified = JSON.parse(fs.readFileSync(reportPath, "utf8")).verified === true;
    } catch {
      verified = false;
    }
  }

  if (ok && verified) {
    console.log(`ok (${ms}ms)`);
    results.push({ package: label, status: "ok", ms });
  } else {
    failed += 1;
    const tail = (result.stderr || result.stdout || "")
      .split("\n")
      .slice(-12)
      .join("\n");
    console.log(`FAIL (${ms}ms, exit ${result.status})`);
    if (tail) {
      console.log(tail);
    }
    results.push({
      package: label,
      status: "fail",
      ms,
      exit: result.status,
      verified,
    });
  }
}

const summaryPath = path.join(outRoot, "summary.json");
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      seed: catalog.seed,
      total: packages.length,
      passed: packages.length - failed,
      failed,
      results,
    },
    null,
    2,
  ),
);

if (failed > 0) {
  console.error(
    `\nFAIL: ${failed}/${packages.length} ecosystem packages did not port cleanly`,
  );
  process.exit(1);
}

const method = catalog.methodology || catalog.selection || catalog.seed;
console.log(
  `\nPASS: ${packages.length}/${packages.length} ecosystem packages ported and verified (${typeof method === "string" ? method : JSON.stringify(method)})`,
);
