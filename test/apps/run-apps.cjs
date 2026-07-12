#!/usr/bin/env node
/**
 * Port 10 public Elm applications and require each run to exit 0 with
 * gren make verification. Apps are cloned under .test-cache/apps/src once.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, "apps.json"), "utf8"),
);
const apps = catalog.apps;
if (!Array.isArray(apps) || apps.length < 10) {
  console.error(
    `apps catalog must list at least 10 apps, got ${apps?.length}`,
  );
  process.exit(1);
}

const cache = path.join(root, ".test-cache", "apps", "cache");
const srcRoot = path.join(root, ".test-cache", "apps", "src");
const outRoot = path.join(root, ".test-cache", "apps", "out");
const cli = path.join(root, "bin", "elm-to-gren.cjs");

fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(srcRoot, { recursive: true });
fs.mkdirSync(outRoot, { recursive: true });

function ensureClone(app) {
  const dest = path.join(srcRoot, app.id);
  const elmJson = path.join(dest, app.elmJsonPath || "elm.json");
  if (fs.existsSync(elmJson)) {
    return dest;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`clone ${app.repo}@${app.ref} ...`);
  const url = `https://github.com/${app.repo}.git`;
  const result = spawnSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      app.ref,
      url,
      dest,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    // Some repos use main instead of master; retry without --branch.
    const retry = spawnSync(
      "git",
      ["clone", "--depth", "1", url, dest],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    if (retry.status !== 0) {
      console.error(
        `clone failed for ${app.repo}:\n${retry.stderr || result.stderr}`,
      );
      process.exit(1);
    }
  }
  if (!fs.existsSync(elmJson)) {
    console.error(`missing ${elmJson} after clone of ${app.repo}`);
    process.exit(1);
  }
  return dest;
}

const results = [];
let failed = 0;

for (const app of apps) {
  const src = ensureClone(app);
  const out = path.join(outRoot, app.id);
  fs.rmSync(out, { recursive: true, force: true });

  process.stdout.write(`port ${app.id} (${app.repo}) ... `);
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      cli,
      src,
      "--out",
      out,
      "--cache",
      cache,
      "--platform",
      "browser",
    ],
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
  let errorHint = "";
  if (fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      verified = report.verified === true;
    } catch {
      verified = false;
    }
  }
  if (!ok || !verified) {
    const combined = `${result.stderr || ""}\n${result.stdout || ""}`;
    errorHint = combined
      .split("\n")
      .filter(Boolean)
      .slice(-16)
      .join("\n");
  }

  if (ok && verified) {
    console.log(`ok (${ms}ms)`);
    results.push({ app: app.id, repo: app.repo, status: "ok", ms });
  } else {
    failed += 1;
    console.log(`FAIL (${ms}ms, exit ${result.status})`);
    if (errorHint) {
      console.log(errorHint);
    }
    results.push({
      app: app.id,
      repo: app.repo,
      status: "fail",
      ms,
      exit: result.status,
      verified,
      hint: errorHint.slice(0, 2000),
    });
  }
}

const summaryPath = path.join(outRoot, "summary.json");
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      selection: catalog.selection,
      total: apps.length,
      passed: apps.length - failed,
      failed,
      results,
    },
    null,
    2,
  ),
);

console.log(
  `\n${apps.length - failed}/${apps.length} apps passed → ${summaryPath}`,
);
process.exit(failed === 0 ? 0 : 1);
