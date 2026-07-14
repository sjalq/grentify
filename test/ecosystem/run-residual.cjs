#!/usr/bin/env node
/**
 * Re-port only packages that failed in the latest TRIAGE or LAST_RUN proof.
 * Default concurrency 6. Never writes suite proof.
 *
 * Usage:
 *   npm run ecosystem:residual
 *   npm run ecosystem:residual -- --suite pure
 *   npm run ecosystem:residual -- -j 8 --fail-fast
 *   npm run ecosystem:residual -- --reason type-mismatch
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
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--suite") suiteFilter = argv[++i];
  if (argv[i] === "--reason") reasonFilter = argv[++i];
  if (argv[i] === "--only") onlyFilter = String(argv[++i] || "");
}

let failures = collectFailures(suiteFilter, reasonFilter);
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
if (failures.length === 0) {
  console.log(
    "No residual failures found in TRIAGE.json or LAST_RUN.json. Run canary/suite first.",
  );
  process.exit(0);
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
  `[ecosystem:residual] commit=${stamp.short} failures=${failures.length} -j${args.concurrency}` +
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
      select: "failures",
      catalog: "TRIAGE+LAST_RUN",
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
