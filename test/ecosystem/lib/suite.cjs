/**
 * Shared ecosystem suite runner.
 *
 * Ground truth rules (do not weaken):
 * 1. Catalogs under test/ecosystem/*.json are CANDIDATE lists, never proof.
 * 2. Only a FULL unfiltered suite run may write suite proof to
 *    .test-cache/ecosystem-proof/LAST_RUN.json
 * 3. Filtered/canary/residual runs write triage artifacts only — not proof.
 * 4. Any other log under .test-cache is disposable scratch.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { gitStamp, proofPath } = require("./git-stamp.cjs");
const {
  scanPackageDirectory,
  findCachedPackageRoot,
  adaptiveTimeoutMs,
  classifyTimeout,
} = require("./volume.cjs");

/**
 * Parse suite CLI flags from process.argv.
 *   --limit N | --offset N | --only a/b@v,c/d
 *   --concurrency N | -j N | --fail-fast
 *   --keep-out
 */
function parseSuiteArgs(argv = process.argv.slice(2)) {
  const opts = {
    limit: null,
    offset: 0,
    only: null,
    concurrency: Number(process.env.CONCURRENCY || 1),
    // Per-package hard cap for normal packages. Volume catalogs get adaptive budgets.
    timeoutMs: Number(process.env.PORT_TIMEOUT_MS || 120000),
    failFast: false,

    keepOut: false,
    writeProof: true,
    adaptiveTimeout: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--offset") opts.offset = Number(argv[++i]);
    else if (a === "--only") opts.only = String(argv[++i] || "");
    else if (a === "--concurrency" || a === "-j")
      opts.concurrency = Number(argv[++i]);
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--fail-fast") opts.failFast = true;
    else if (a === "--keep-out") opts.keepOut = true;
    else if (a === "--no-proof") opts.writeProof = false;
    else if (a === "--no-adaptive-timeout") opts.adaptiveTimeout = false;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
    opts.concurrency = 1;
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) {
    opts.timeoutMs = 120000;
  }
  return opts;
}

function printHelp() {
  console.log(`ecosystem suite flags:
  --limit N          first N packages after offset
  --offset N         skip first N
  --only a@v,b@v     only these packages (comma-separated)
  -j, --concurrency N  parallel ports (default CONCURRENCY or 1)
  --timeout-ms N     base per-package timeout (default 120000; volume packages adapt)
  --no-adaptive-timeout  disable volume adaptive timeouts
  --fail-fast        stop scheduling after first failure
  --keep-out         do not wipe outDir before run
  --no-proof         never write LAST_RUN.json (always true for filtered runs)
`);
}

/**
 * @param {{
 *   root: string,
 *   suiteId: "pure" | "browser" | "canary",
 *   catalogPath: string,
 *   cacheDir: string,
 *   outDir: string,
 *   minPackages: number,
 *   platformArg?: string[],
 *   args?: ReturnType<typeof parseSuiteArgs>,
 *   mode?: "full" | "triage" | "canary",
 * }} options
 */
async function runSuite(options) {
  const {
    root,
    suiteId,
    catalogPath,
    cacheDir,
    outDir,
    minPackages,
    platformArg = [],
    mode = "full",
  } = options;
  const args = options.args || parseSuiteArgs();

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (catalog.role && catalog.role !== "candidate-suite") {
    console.error(
      `catalog ${catalogPath} has role=${catalog.role}; expected candidate-suite`,
    );
    process.exit(1);
  }

  let packages = Array.isArray(catalog.packages) ? [...catalog.packages] : [];
  if (mode === "full" && packages.length < minPackages) {
    console.error(
      `${suiteId} catalog must list at least ${minPackages} packages, got ${packages.length}`,
    );
    process.exit(1);
  }

  const filtered = selectPackages(packages, args);
  const isFullProofRun =
    mode === "full" &&
    args.writeProof &&
    filtered.kind === "full" &&
    filtered.packages.length === packages.length;

  const stamp = gitStamp(root);
  const cli = path.join(root, "bin", "elm-to-gren.cjs");
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  console.log(
    `[ecosystem:${suiteId}] commit=${stamp.short} dirty=${stamp.dirty} mode=${mode} select=${filtered.kind} packages=${filtered.packages.length}/${packages.length} -j${args.concurrency}`,
  );
  if (!isFullProofRun) {
    console.log(
      `[ecosystem:${suiteId}] TRIAGE/partial run — will NOT update suite proof`,
    );
  } else {
    console.log(
      `[ecosystem:${suiteId}] FULL run — will write commit-stamped suite proof`,
    );
  }
  if (stamp.dirty) {
    console.log(
      `[ecosystem:${suiteId}] WARNING: working tree is dirty; proof would be marked dirty`,
    );
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!args.keepOut) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  let failed = 0;
  const failReasons = {};
  let stop = false;

  await mapPool(filtered.packages, args.concurrency, async (pkg, index) => {
    if (stop) {
      return;
    }
    const label = `${pkg.name}@${pkg.version ?? "latest"}`;
    const input = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
    const out = path.join(
      outDir,
      pkg.name.replace("/", "__") + (pkg.version ? `__${pkg.version}` : ""),
    );
    fs.rmSync(out, { recursive: true, force: true });

    const cachedRoot = findCachedPackageRoot(
      cacheDir,
      pkg.name,
      pkg.version,
    );
    const volume = cachedRoot
      ? scanPackageDirectory(cachedRoot)
      : null;
    const budgetMs = args.adaptiveTimeout
      ? adaptiveTimeoutMs(volume, args.timeoutMs)
      : args.timeoutMs;

    const cliArgs = [cli, input, "--out", out, "--cache", cacheDir, ...platformArg];
    // Host always verifies and formats (volume packages auto-skip format).

    const started = Date.now();
    const volNote =
      volume && volume.volume
        ? ` volume[${volume.summary}] budget=${budgetMs}ms`
        : "";
    process.stdout.write(
      `[${index + 1}/${filtered.packages.length}] port ${label}${volNote} ... `,
    );
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
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        verified = report.verified === true;
      } catch {
        verified = false;
      }
    }

    // Re-scan staged out for volume if cache miss pre-port
    const volumeAfter =
      volume ||
      (fs.existsSync(out) ? scanPackageDirectory(out) : null);

    const text = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (result.timedOut) {
      failed += 1;
      const reason = classifyTimeout(true, volumeAfter, budgetMs);
      failReasons[reason] = (failReasons[reason] || 0) + 1;
      console.log(
        `FAIL ${reason} (${ms}ms > ${budgetMs}ms` +
          (volumeAfter && volumeAfter.volume
            ? `; ${volumeAfter.summary}`
            : "") +
          `)`,
      );
      results.push({
        package: label,
        status: "fail",
        ms,
        exit: result.status,
        verified: false,
        reason,
        volume: volumeAfter,
        budgetMs,
      });
      if (args.failFast) stop = true;
    } else if (result.status === 0 && verified) {
      console.log(
        `ok (${ms}ms)` +
          (volumeAfter && volumeAfter.volume ? " [volume]" : ""),
      );
      results.push({
        package: label,
        status: "ok",
        ms,
        volume: volumeAfter && volumeAfter.volume ? volumeAfter : undefined,
      });
    } else {
      failed += 1;
      const reason = classifyFail(text, result.status, verified);
      failReasons[reason] = (failReasons[reason] || 0) + 1;
      const tail = text.split("\n").filter(Boolean).slice(-8).join("\n");
      console.log(`FAIL ${reason} (${ms}ms, exit ${result.status})`);
      if (tail) {
        console.log(tail);
      }
      results.push({
        package: label,
        status: "fail",
        ms,
        exit: result.status,
        verified,
        reason,
      });
      if (args.failFast) {
        stop = true;
      }
    }
  });

  // Preserve input order in results for readability.
  const order = new Map(
    filtered.packages.map((p, i) => [
      `${p.name}@${p.version ?? "latest"}`,
      i,
    ]),
  );
  results.sort(
    (a, b) => (order.get(a.package) ?? 0) - (order.get(b.package) ?? 0),
  );

  const finishedAt = new Date().toISOString();
  const wallMs = Date.now() - t0;
  const suiteRecord = {
    suiteId,
    role: isFullProofRun ? "suite-result" : "triage-result",
    mode,
    select: filtered.kind,
    catalog: path.relative(root, catalogPath),
    catalogPackageCount: packages.length,
    git: stamp,
    startedAt,
    finishedAt,
    wallMs,
    concurrency: args.concurrency,
    total: results.length,
    passed: results.filter((r) => r.status === "ok").length,
    failed,
    failReasons,
    results,
  };

  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        ...suiteRecord,
        note: isFullProofRun
          ? "Scratch copy. Canonical proof: .test-cache/ecosystem-proof/LAST_RUN.json"
          : "Triage/partial only. Not suite proof.",
      },
      null,
      2,
    ),
  );

  // Always write triage snapshot for residual loops.
  writeTriage(root, suiteId, suiteRecord);

  if (isFullProofRun) {
    writeProof(root, suiteId, suiteRecord);
  }

  printHistogram(suiteRecord);

  if (failed > 0) {
    console.error(
      `\nFAIL: ${failed}/${results.length} ${suiteId} packages (${wallMs}ms wall, -j${args.concurrency})`,
    );
    if (isFullProofRun) {
      console.error(
        `Proof written (failed) for commit ${stamp.short}. npm run ecosystem:status`,
      );
    } else {
      console.error(
        `Triage written. Next: npm run ecosystem:residual  OR fix top failReasons`,
      );
    }
    process.exit(1);
  }

  console.log(
    `\nPASS: ${results.length}/${results.length} ${suiteId} packages (${wallMs}ms wall, -j${args.concurrency})`,
  );
  if (isFullProofRun) {
    console.log(
      `Proof written for commit ${stamp.short}${stamp.dirty ? " (dirty tree)" : ""}. npm run ecosystem:status`,
    );
  } else {
    console.log(`Triage only — full proof requires unfiltered suite run.`);
  }
}

function selectPackages(packages, args) {
  if (args.only) {
    const wanted = new Set(
      args.only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const selected = packages.filter((p) => {
      const label = `${p.name}@${p.version ?? "latest"}`;
      return (
        wanted.has(label) ||
        wanted.has(p.name) ||
        wanted.has(`${p.name}@${p.version}`)
      );
    });
    return { kind: "only", packages: selected };
  }
  let list = packages.slice(args.offset || 0);
  if (args.limit != null && Number.isFinite(args.limit)) {
    list = list.slice(0, args.limit);
    return { kind: "limit", packages: list };
  }
  if (args.offset) {
    return { kind: "offset", packages: list };
  }
  return { kind: "full", packages: list };
}

function spawnCapture(program, args, cwd, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    }
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut
          ? `${stderr}\nPORT_TIMEOUT after ${timeoutMs}ms`
          : stderr,
        timedOut,
      });
    });
  });
}

async function mapPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function classifyFail(text, exit, verified) {
  if (text.includes("PORT_TIMEOUT") || text.includes("timed out"))
    return "timeout"; // hang-class; volume budgets use classifyTimeout → scale
  if (text.includes("DOCS MISTAKE")) return "docs";
  if (text.includes("TYPE MISMATCH")) return "type-mismatch";
  if (text.includes("NAMING ERROR")) return "naming";
  if (text.includes("SHADOWING")) return "shadowing";
  if (text.includes("AST_UNPORTED")) return "ast-unported";
  if (text.includes("TOO FEW ARGS") || text.includes("TOO MANY ARGS"))
    return "arity";
  if (text.includes("UNFINISHED")) return "unfinished";
  if (text.includes("GREN_VERIFY_FAILED")) return "gren-verify";
  if (text.includes("kernel") || text.includes("Elm.Kernel")) return "kernel";
  if (text.includes("effect module")) return "effect-module";
  if (text.includes("MODULE_NOT_FOUND") || text.includes("elm-to-gren.js"))
    return "missing-build";
  if (exit === 124) return "timeout";
  if (exit !== 0) return `exit-${exit}`;
  if (!verified) return "unverified";
  return "other";
}

function printHistogram(suiteRecord) {
  const reasons = Object.entries(suiteRecord.failReasons || {}).sort(
    (a, b) => b[1] - a[1],
  );
  if (reasons.length === 0) {
    return;
  }
  console.log("\nfailReasons:");
  for (const [reason, n] of reasons) {
    console.log(`  ${n}\t${reason}`);
  }
  // Top 3 packages per top reason for the next fix batch
  const byReason = {};
  for (const r of suiteRecord.results) {
    if (r.status === "ok") continue;
    byReason[r.reason] = byReason[r.reason] || [];
    if (byReason[r.reason].length < 3) {
      byReason[r.reason].push(r.package);
    }
  }
  console.log("fix-next (up to 3 pkgs per top reason):");
  for (const [reason] of reasons.slice(0, 5)) {
    console.log(`  ${reason}: ${(byReason[reason] || []).join(", ")}`);
  }
}

function triagePath(root) {
  return path.join(root, ".test-cache", "ecosystem-proof", "TRIAGE.json");
}

function writeTriage(root, suiteId, suiteRecord) {
  const dest = triagePath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let triage = {
    schemaVersion: 1,
    role: "triage",
    warning: "Not suite proof. Use for residual loops only.",
    git: suiteRecord.git,
    updatedAt: suiteRecord.finishedAt,
    suites: {},
  };
  if (fs.existsSync(dest)) {
    try {
      const prev = JSON.parse(fs.readFileSync(dest, "utf8"));
      if (
        prev?.role === "triage" &&
        prev.git?.commit === suiteRecord.git.commit
      ) {
        triage = prev;
      }
    } catch {
      /* fresh */
    }
  }
  triage.git = suiteRecord.git;
  triage.updatedAt = suiteRecord.finishedAt;
  triage.suites = triage.suites || {};
  triage.suites[suiteId] = {
    mode: suiteRecord.mode,
    select: suiteRecord.select,
    total: suiteRecord.total,
    passed: suiteRecord.passed,
    failed: suiteRecord.failed,
    failReasons: suiteRecord.failReasons,
    wallMs: suiteRecord.wallMs,
    finishedAt: suiteRecord.finishedAt,
    failures: suiteRecord.results
      .filter((r) => r.status !== "ok")
      .map((r) => ({ package: r.package, reason: r.reason, ms: r.ms })),
  };
  fs.writeFileSync(dest, JSON.stringify(triage, null, 2));
}

function writeProof(root, suiteId, suiteRecord) {
  const dest = proofPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let proof = {
    schemaVersion: 1,
    role: "suite-proof",
    warning:
      "ONLY this file is ecosystem success proof. Ignore every other .test-cache log.",
    git: suiteRecord.git,
    updatedAt: suiteRecord.finishedAt,
    suites: {},
  };

  if (fs.existsSync(dest)) {
    try {
      const prev = JSON.parse(fs.readFileSync(dest, "utf8"));
      if (
        prev &&
        prev.role === "suite-proof" &&
        prev.git &&
        prev.git.commit === suiteRecord.git.commit &&
        prev.git.dirty === suiteRecord.git.dirty
      ) {
        proof = prev;
        proof.git = suiteRecord.git;
        proof.updatedAt = suiteRecord.finishedAt;
        proof.suites = prev.suites || {};
      }
    } catch {
      // rewrite from scratch
    }
  }

  if (
    !proof.suites ||
    proof.git.commit !== suiteRecord.git.commit ||
    proof.git.dirty !== suiteRecord.git.dirty
  ) {
    proof.git = suiteRecord.git;
    proof.suites = {};
  }

  proof.suites[suiteId] = {
    status: suiteRecord.failed === 0 ? "pass" : "fail",
    total: suiteRecord.total,
    passed: suiteRecord.passed,
    failed: suiteRecord.failed,
    failReasons: suiteRecord.failReasons,
    startedAt: suiteRecord.startedAt,
    finishedAt: suiteRecord.finishedAt,
    wallMs: suiteRecord.wallMs,
    catalog: suiteRecord.catalog,
    failures: suiteRecord.results
      .filter((r) => r.status !== "ok")
      .map((r) => ({ package: r.package, reason: r.reason })),
  };

  proof.updatedAt = suiteRecord.finishedAt;
  fs.writeFileSync(dest, JSON.stringify(proof, null, 2));
}

module.exports = {
  runSuite,
  parseSuiteArgs,
  writeProof,
  writeTriage,
  classifyFail,
  triagePath,
  selectPackages,
  mapPool,
  spawnCapture,
};
