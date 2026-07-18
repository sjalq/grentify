#!/usr/bin/env node
/**
 * Resumable behavior-batch runner for behavior testing with ports.
 * Logs behavior status to test/ecosystem/behavior-log.jsonl
 * Exit always 0 (survey tool, not a gate).
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnCapture, mapPool } = require("./lib/suite.cjs");
const { gitStamp } = require("./lib/git-stamp.cjs");

const root = path.resolve(__dirname, "../..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, "packages-canary.json"), "utf8"),
);

// Parse CLI flags
const args = {
  concurrency: 2,
  limit: null,
  fresh: false,
  package: null,
};

for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if ((a === "--concurrency" || a === "-j") && i + 1 < process.argv.length) {
    args.concurrency = Number(process.argv[++i]);
  } else if (a === "--limit" && i + 1 < process.argv.length) {
    args.limit = Number(process.argv[++i]);
  } else if (a === "--fresh") {
    args.fresh = true;
  } else if (a === "--package" && i + 1 < process.argv.length) {
    args.package = process.argv[++i];
  }
}

const cache = path.join(root, ".test-cache", "ecosystem", "cache");
const outRoot = path.join(root, ".test-cache", "behavior-batch", "out");
const logPath = path.join(root, "test", "ecosystem", "behavior-log.jsonl");
const cli = path.join(root, "bin", "elm-to-gren.cjs");
const stamp = gitStamp(root);

// Load and COMPACT the log (last-wins per name@version+commit), so repeated
// proof runs and --fresh reruns never pile up duplicates.
const existingLog = new Map();
if (fs.existsSync(logPath)) {
  try {
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const compacted = new Map();
    for (const line of lines) {
      const entry = JSON.parse(line);
      compacted.set(`${entry.name}@${entry.version}@${entry.commit}`, entry);
    }
    fs.writeFileSync(
      logPath,
      [...compacted.values()].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    if (!args.fresh) {
      for (const entry of compacted.values()) {
        existingLog.set(`${entry.name}@${entry.version}`, entry);
      }
    }
  } catch (err) {
    console.warn(`[behavior-batch] warning: failed to read log: ${err.message}`);
  }
}

fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(outRoot, { recursive: true });

let packages = catalog.packages || [];

// If --package specified, filter to just that one
if (args.package) {
  packages = packages.filter(
    (p) => `${p.name}@${p.version}` === args.package || p.name === args.package
  );
  if (packages.length === 0) {
    console.log(`[behavior-batch] no package matching: ${args.package}`);
    process.exit(0);
  }
}

// If --limit specified, take first N
if (args.limit != null && Number.isFinite(args.limit)) {
  packages = packages.slice(0, args.limit);
}

console.log(
  `[behavior-batch] commit=${stamp.short} dirty=${stamp.dirty} packages=${packages.length} -j${args.concurrency}${args.fresh ? " --fresh" : ""}`
);

const results = [];
const statusCounts = {};
const t0 = Date.now();

mapPool(packages, args.concurrency, async (pkg, index) => {
  const label = `${pkg.name}@${pkg.version}`;
  const key = label;

  // Check for resumability
  if (existingLog.has(key)) {
    const prevEntry = existingLog.get(key);
    if (prevEntry.commit === stamp.commit && !args.fresh) {
      process.stdout.write(`[${index + 1}/${packages.length}] ${label} ... `);
      console.log(`skipped (already logged at ${stamp.short})`);
      results.push({
        name: pkg.name,
        version: pkg.version,
        status: "skipped",
        detail: `already logged at ${stamp.short}`,
      });
      return;
    }
  }

  const out = path.join(outRoot, pkg.name.replace("/", "__") + `__${pkg.version}`);
  fs.rmSync(out, { recursive: true, force: true });

  const cliArgs = [cli, "port", `${pkg.name}@${pkg.version}`, "-o", out, "--with-tests"];

  process.stdout.write(`[${index + 1}/${packages.length}] ${label} ... `);
  const started = Date.now();
  const result = await spawnCapture(process.execPath, cliArgs, root);
  const ms = Date.now() - started;

  let status = "port-failed";
  let detail = "";
  let behavior = null;

  if (result.status === 0) {
    const reportPath = path.join(out, "elm-to-gren.report.json");
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        if (report.behavior) {
          behavior = report.behavior;
          status = behavior.status || "unknown";
          detail = behavior.detail || "";
        } else {
          status = "no-behavior";
          detail = "report missing behavior object";
        }
      } catch (err) {
        status = "report-parse-error";
        detail = err.message;
      }
    } else {
      status = "no-report";
      detail = "report file not found";
    }
  } else {
    // Port process failed
    const stderr = (result.stderr || "").split("\n").filter(Boolean);
    const tail = stderr.slice(-3).join(" ");
    detail = tail || `exit ${result.status}`;
  }

  console.log(`${status} (${ms}ms)`);
  if (detail && status !== "tested") {
    console.log(`  detail: ${detail}`);
  }

  statusCounts[status] = (statusCounts[status] || 0) + 1;

  // Append immediately: a killed batch must never lose completed verdicts
  // (startup compaction collapses any duplicate from an overlapping rerun).
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      status,
      detail,
      commit: stamp.commit,
      date: new Date().toISOString(),
    }) + "\n",
  );

  results.push({
    name: pkg.name,
    version: pkg.version,
    status,
    detail,
  });
})
  .then(() => {
    const wallMs = Date.now() - t0;

    // Print summary (entries were appended per-package as they completed)
    const summary = Object.entries(statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    const totalRun = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const skipped = results.filter((r) => r.status === "skipped").length;

    console.log(`\nbehavior-batch: ${summary || "nothing run"} / ${packages.length}${skipped > 0 ? ` (${skipped} skipped)` : ""} (${wallMs}ms wall)`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(0); // Exit 0 always for survey tool
  });
