#!/usr/bin/env node
/**
 * Sub-minute regression set. Never suite proof.
 * Mixes pure + browser packages; browser ones get --platform browser.
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnCapture, parseSuiteArgs, mapPool, classifyFail, writeTriage } = require("./lib/suite.cjs");
const { gitStamp } = require("./lib/git-stamp.cjs");

const root = path.resolve(__dirname, "../..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, "packages-canary.json"), "utf8"),
);
const args = parseSuiteArgs();
// Canary defaults to parallel.
if (!process.argv.includes("--concurrency") && !process.argv.includes("-j")) {
  args.concurrency = Number(process.env.CONCURRENCY || 4);
}
args.writeProof = false;

const cache = path.join(root, ".test-cache", "ecosystem", "cache");
const outRoot = path.join(root, ".test-cache", "ecosystem-canary", "out");
const cli = path.join(root, "bin", "elm-to-gren.cjs");
const stamp = gitStamp(root);
const packages = catalog.packages || [];
const startedAt = new Date().toISOString();
const t0 = Date.now();

fs.mkdirSync(cache, { recursive: true });
if (!args.keepOut) {
  fs.rmSync(outRoot, { recursive: true, force: true });
}
fs.mkdirSync(outRoot, { recursive: true });

console.log(
  `[ecosystem:canary] commit=${stamp.short} dirty=${stamp.dirty} packages=${packages.length} -j${args.concurrency}`,
);
console.log(`[ecosystem:canary] TRIAGE only — never suite proof`);

const results = [];
let failed = 0;
const failReasons = {};
let stop = false;

mapPool(packages, args.concurrency, async (pkg, index) => {
  if (stop) return;
  const label = `${pkg.name}@${pkg.version}`;
  const platform =
    pkg.platform === "browser" ? ["--platform", "browser"] : [];
  const out = path.join(
    outRoot,
    pkg.name.replace("/", "__") + `__${pkg.version}`,
  );
  fs.rmSync(out, { recursive: true, force: true });
  const cliArgs = [
    cli,
    `${pkg.name}@${pkg.version}`,
    "--out",
    out,
    "--cache",
    cache,
    ...platform,
  ];
  if (args.noVerify) cliArgs.push("--no-verify");

  process.stdout.write(
    `[${index + 1}/${packages.length}] port ${label}${pkg.surface ? ` (${pkg.surface})` : ""} ... `,
  );
  const started = Date.now();
  const result = await spawnCapture(process.execPath, cliArgs, root);
  const ms = Date.now() - started;
  let verified = false;
  const reportPath = path.join(out, "elm-to-gren.report.json");
  if (result.status === 0 && fs.existsSync(reportPath)) {
    try {
      verified = args.noVerify
        ? true
        : JSON.parse(fs.readFileSync(reportPath, "utf8")).verified === true;
    } catch {
      verified = false;
    }
  }
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (result.status === 0 && verified) {
    console.log(`ok (${ms}ms)`);
    results.push({ package: label, status: "ok", ms, surface: pkg.surface });
  } else {
    failed += 1;
    const reason = classifyFail(text, result.status, verified);
    failReasons[reason] = (failReasons[reason] || 0) + 1;
    console.log(`FAIL ${reason} (${ms}ms)`);
    const tail = text.split("\n").filter(Boolean).slice(-6).join("\n");
    if (tail) console.log(tail);
    results.push({
      package: label,
      status: "fail",
      ms,
      reason,
      surface: pkg.surface,
    });
    if (args.failFast) stop = true;
  }
})
  .then(() => {
    const finishedAt = new Date().toISOString();
    const wallMs = Date.now() - t0;
    const suiteRecord = {
      suiteId: "canary",
      role: "triage-result",
      mode: "canary",
      select: "canary",
      catalog: "test/ecosystem/packages-canary.json",
      catalogPackageCount: packages.length,
      git: stamp,
      startedAt,
      finishedAt,
      wallMs,
      concurrency: args.concurrency,
      noVerify: args.noVerify,
      total: results.length,
      passed: results.filter((r) => r.status === "ok").length,
      failed,
      failReasons,
      results,
    };
    fs.writeFileSync(
      path.join(outRoot, "summary.json"),
      JSON.stringify(suiteRecord, null, 2),
    );
    writeTriage(root, "canary", suiteRecord);

    console.log("\nfailReasons:");
    for (const [k, v] of Object.entries(failReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v}\t${k}`);
    }
    if (failed > 0) {
      console.error(
        `\nFAIL canary: ${failed}/${results.length} (${wallMs}ms wall). Fix these before full suite.`,
      );
      process.exit(1);
    }
    console.log(
      `\nPASS canary: ${results.length}/${results.length} (${wallMs}ms wall). Still not suite proof.`,
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
