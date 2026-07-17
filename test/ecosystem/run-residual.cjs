#!/usr/bin/env node
/**
 * Re-port packages for triage. Default concurrency 6. Never writes suite proof.
 *
 * Two selection modes:
 *   1. Failure-list mode (default): re-port packages that failed in the latest
 *      TRIAGE.json / LAST_RUN.json. Requires those machine-local lists to exist.
 *   2. Direct catalog mode (--package): port the named package(s) straight from
 *      the candidate catalogs regardless of any failure list, so a fresh machine
 *      can prove a single package without a prior suite run.
 *
 * Usage:
 *   npm run ecosystem:residual
 *   npm run ecosystem:residual -- --suite pure
 *   npm run ecosystem:residual -- -j 8 --fail-fast
 *   npm run ecosystem:residual -- --reason type-mismatch
 *   npm run ecosystem:residual -- --only elm-community/maybe-extra@5.3.0
 *   npm run ecosystem:residual -- --package elm-community/maybe-extra@5.3.0
 *   npm run ecosystem:residual -- --package a/b@1.0.0 --package c/d@2.0.0
 *
 * Exit codes:
 *   0  all selected packages recovered (or nothing to do with no filter)
 *   1  a package still failed, a --package name is in neither catalog, or a
 *      --only/--reason/--suite filter matched nothing (vacuous run != proof)
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  spawnCapture,
  parseSuiteArgs,
  mapPool,
  classifyFail,
  writeTriage,
  triagePath,
} = require("./lib/suite.cjs");
const { gitStamp, proofPath } = require("./lib/git-stamp.cjs");
const {
  scanPackageDirectory,
  findCachedPackageRoot,
  adaptiveTimeoutMs,
  classifyTimeout,
} = require("./lib/volume.cjs");

const root = path.resolve(__dirname, "../..");
const args = parseSuiteArgs();
if (!process.argv.includes("--concurrency") && !process.argv.includes("-j")) {
  args.concurrency = Number(process.env.CONCURRENCY || 6);
}

let suiteFilter = null;
let reasonFilter = null;
let onlyFilter = null;
const packageArgs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--suite") suiteFilter = argv[++i];
  if (argv[i] === "--reason") reasonFilter = argv[++i];
  if (argv[i] === "--only") onlyFilter = String(argv[++i] || "");
  if (argv[i] === "--package") packageArgs.push(String(argv[++i] || ""));
}

let failures;
let sourceLabel;
let selectKind;
if (packageArgs.length > 0) {
  // Direct catalog mode: port the named package(s) straight from the candidate
  // catalogs, independent of any machine-local failure list.
  const { items, missing } = resolveCatalogPackages(packageArgs);
  if (missing.length > 0) {
    console.error(
      `[ecosystem:residual] not in any candidate catalog: ${missing.join(", ")}`,
    );
    console.error(
      `  candidates come from test/ecosystem/packages.json and test/ecosystem/packages-browser.json`,
    );
    process.exit(1);
  }
  failures = items;
  sourceLabel = "catalog-direct";
  selectKind = "package";
} else {
  failures = collectFailures(suiteFilter, reasonFilter);
  if (onlyFilter) {
    const want = new Set(
      onlyFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    failures = failures.filter(
      (f) =>
        want.has(f.package) ||
        [...want].some(
          (w) => f.package === w || f.package.startsWith(w + "@") || w.startsWith(f.package),
        ),
    );
  }
  const filtered = onlyFilter || reasonFilter || suiteFilter;
  if (failures.length === 0) {
    if (filtered) {
      // A filter was supplied but matched nothing. Exiting 0 here would let a
      // vacuous run masquerade as proof, so fail loudly instead.
      const parts = [
        onlyFilter ? `--only ${onlyFilter}` : null,
        reasonFilter ? `--reason ${reasonFilter}` : null,
        suiteFilter ? `--suite ${suiteFilter}` : null,
      ].filter(Boolean);
      console.error(
        `[ecosystem:residual] vacuous filter (${parts.join(" ")}): no residual failure matched. ` +
          `Nothing was ported. Use --package name@version to port a catalog package directly.`,
      );
      process.exit(1);
    }
    console.log(
      "No residual failures found in TRIAGE.json or LAST_RUN.json. Run canary/suite first.",
    );
    process.exit(0);
  }
  sourceLabel = "TRIAGE+LAST_RUN";
  selectKind = "failures";
}

const stamp = gitStamp(root);
const cache = path.join(root, ".test-cache", "ecosystem", "cache");
const outRoot = path.join(root, ".test-cache", "ecosystem-residual", "out");
const cli = path.join(root, "bin", "elm-to-gren.cjs");
const startedAt = new Date().toISOString();
const t0 = Date.now();

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

console.log(
  `[ecosystem:residual] commit=${stamp.short} select=${selectKind} packages=${failures.length} -j${args.concurrency}` +
    (reasonFilter ? ` reason=${reasonFilter}` : "") +
    (suiteFilter ? ` suite=${suiteFilter}` : ""),
);
console.log(`[ecosystem:residual] TRIAGE only — never suite proof`);

const results = [];
let failed = 0;
const failReasons = {};
let stop = false;

mapPool(failures, args.concurrency, async (item, index) => {
  if (stop) return;
  const label = item.package;
  const platform =
    item.suite === "browser" || item.platform === "browser"
      ? ["--platform", "browser"]
      : [];
  const out = path.join(outRoot, label.replace(/[/@]/g, "_"));
  fs.rmSync(out, { recursive: true, force: true });
  const name = label.includes("@") ? label.split("@")[0] : label;
  const version = label.includes("@") ? label.split("@")[1] : null;
  const cachedRoot = findCachedPackageRoot(cache, name, version);
  const volume = cachedRoot ? scanPackageDirectory(cachedRoot) : null;
  const budgetMs = adaptiveTimeoutMs(volume, args.timeoutMs);

  const cliArgs = [cli, label, "--out", out, "--cache", cache, ...platform];

  process.stdout.write(
    `[${index + 1}/${failures.length}] port ${label} (was ${item.reason || "?"}` +
      (volume && volume.volume ? `; volume budget=${budgetMs}ms` : "") +
      `) ... `,
  );
  const started = Date.now();
  const result = await spawnCapture(
    process.execPath,
    cliArgs,
    root,
    budgetMs,
  );
  const ms = Date.now() - started;
  let verified = false;
  const reportPath = path.join(out, "elm-to-gren.report.json");
  if (result.status === 0 && fs.existsSync(reportPath)) {
    try {
      verified =
        JSON.parse(fs.readFileSync(reportPath, "utf8")).verified === true;
    } catch {
      verified = false;
    }
  }
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  const volumeAfter =
    volume || (fs.existsSync(out) ? scanPackageDirectory(out) : null);
  if (result.timedOut) {
    failed += 1;
    const reason = classifyTimeout(true, volumeAfter, budgetMs);
    failReasons[reason] = (failReasons[reason] || 0) + 1;
    console.log(`FAIL ${reason} (${ms}ms > ${budgetMs}ms)`);
    results.push({ package: label, status: "fail", ms, reason });
    if (args.failFast) stop = true;
  } else if (result.status === 0 && verified) {
    console.log(`ok (${ms}ms) RECOVERED`);
    results.push({
      package: label,
      status: "ok",
      ms,
      recoveredFrom: item.reason,
    });
  } else {
    failed += 1;
    const reason = classifyFail(text, result.status, verified);
    failReasons[reason] = (failReasons[reason] || 0) + 1;
    console.log(`FAIL ${reason} (${ms}ms)`);
    results.push({ package: label, status: "fail", ms, reason });
    if (args.failFast) stop = true;
  }
})
  .then(() => {
    const finishedAt = new Date().toISOString();
    const wallMs = Date.now() - t0;
    const recovered = results.filter((r) => r.status === "ok").length;
    const suiteRecord = {
      suiteId: "residual",
      role: "triage-result",
      mode: "residual",
      select: selectKind,
      catalog: sourceLabel,
      catalogPackageCount: failures.length,
      git: stamp,
      startedAt,
      finishedAt,
      wallMs,
      concurrency: args.concurrency,
      total: results.length,
      passed: recovered,
      failed,
      failReasons,
      results,
    };
    fs.writeFileSync(
      path.join(outRoot, "summary.json"),
      JSON.stringify(suiteRecord, null, 2),
    );
    writeTriage(root, "residual", suiteRecord);
    console.log(
      `\nresidual: recovered ${recovered}/${results.length}, still failing ${failed} (${wallMs}ms wall)`,
    );
    for (const [k, v] of Object.entries(failReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v}\t${k}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Resolve `--package name@version` specs against the candidate catalogs.
// Pure catalog wins over browser when a name appears in both. A spec that
// matches no catalog entry is reported in `missing` (caller exits non-zero).
function resolveCatalogPackages(specs) {
  const pure = readCatalogSafe(path.join(__dirname, "packages.json"));
  const browser = readCatalogSafe(path.join(__dirname, "packages-browser.json"));
  const items = [];
  const missing = [];
  const seen = new Set();
  for (const raw of specs) {
    const spec = String(raw).trim();
    if (!spec) continue;
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : null;
    const pureEntry = findCatalogEntry(pure, name, version);
    const browserEntry = pureEntry ? null : findCatalogEntry(browser, name, version);
    const entry = pureEntry || browserEntry;
    if (!entry) {
      missing.push(spec);
      continue;
    }
    const label = `${entry.name}@${entry.version}`;
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({
      package: label,
      reason: "requested",
      suite: browserEntry ? "browser" : "pure",
      platform: browserEntry ? "browser" : undefined,
    });
  }
  return { items, missing };
}

function findCatalogEntry(catalog, name, version) {
  return (catalog.packages || []).find(
    (p) => p.name === name && (version == null || p.version === version),
  );
}

function readCatalogSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { packages: [] };
  }
}

function collectFailures(suiteFilter, reasonFilter) {
  const seen = new Map();
  function add(pkg, reason, suite) {
    if (suiteFilter && suite !== suiteFilter) return;
    if (reasonFilter && reason !== reasonFilter) return;
    if (!pkg) return;
    // Prefer latest reason.
    seen.set(pkg, { package: pkg, reason, suite });
  }

  const triageFile = triagePath(root);
  if (fs.existsSync(triageFile)) {
    try {
      const t = JSON.parse(fs.readFileSync(triageFile, "utf8"));
      for (const [suite, rec] of Object.entries(t.suites || {})) {
        for (const f of rec.failures || []) {
          add(f.package, f.reason, suite);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const proofFile = proofPath(root);
  if (fs.existsSync(proofFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(proofFile, "utf8"));
      for (const [suite, rec] of Object.entries(p.suites || {})) {
        for (const f of rec.failures || []) {
          add(f.package, f.reason, suite);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Canary packages from catalog for browser platform hints
  let canaryBrowser = new Set();
  try {
    const c = JSON.parse(
      fs.readFileSync(path.join(__dirname, "packages-canary.json"), "utf8"),
    );
    for (const p of c.packages || []) {
      if (p.platform === "browser") {
        canaryBrowser.add(`${p.name}@${p.version}`);
      }
    }
  } catch {
    /* ignore */
  }

  return [...seen.values()].map((f) => ({
    ...f,
    platform: canaryBrowser.has(f.package) ? "browser" : undefined,
  }));
}
