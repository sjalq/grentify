#!/usr/bin/env node
/**
 * Verify the AST-path probe set (host MatchCompile / kernel laws).
 *
 * Catalog: packages-ast-probe.json — plain "author/pkg@version" strings.
 * Expect every package to port with verified: true. Extend this list when
 * adding regression targets for the host AST pipeline.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const packages = JSON.parse(
  fs.readFileSync(path.join(__dirname, "packages-ast-probe.json"), "utf8"),
);
if (!Array.isArray(packages) || packages.length === 0) {
  console.error("packages-ast-probe.json must be a non-empty array of package refs");
  process.exit(1);
}

const cache = path.join(root, ".test-cache", "ecosystem", "cache");
const outRoot = path.join(root, ".test-cache", "ast-probe", "out");
const cli = path.join(root, "bin", "elm-to-gren.cjs");
const dist = path.join(root, "dist", "elm-to-gren.js");

if (!fs.existsSync(dist)) {
  console.error("dist/elm-to-gren.js missing; run npm run build first");
  process.exit(1);
}

fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(outRoot, { recursive: true });

let failed = 0;
const results = [];

for (const input of packages) {
  if (typeof input !== "string" || !input.includes("/")) {
    console.error(`invalid package ref: ${JSON.stringify(input)}`);
    process.exit(1);
  }
  const tag = input.replace(/[/@]/g, "_");
  const out = path.join(outRoot, tag);
  fs.rmSync(out, { recursive: true, force: true });

  process.stdout.write(`port ${input} ... `);
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [cli, input, "--out", out, "--cache", cache],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"]
          .filter(Boolean)
          .join(" "),
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const ms = Date.now() - started;
  const reportPath = path.join(out, "elm-to-gren.report.json");
  let verified = false;
  if (fs.existsSync(reportPath)) {
    try {
      verified = JSON.parse(fs.readFileSync(reportPath, "utf8")).verified === true;
    } catch {
      verified = false;
    }
  }

  if (verified) {
    console.log(`ok (${ms}ms)`);
    results.push({ package: input, status: "ok", ms });
  } else {
    failed += 1;
    const tail = (result.stderr || result.stdout || "")
      .split("\n")
      .slice(-8)
      .join("\n");
    console.log(`FAIL (${ms}ms, exit ${result.status})`);
    if (tail) {
      console.log(tail);
    }
    results.push({ package: input, status: "fail", ms, exit: result.status });
  }
}

const summaryPath = path.join(root, ".test-cache", "ast-probe", "summary.json");
fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      total: packages.length,
      ok: packages.length - failed,
      fail: failed,
      results,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `\nast-probe: ${packages.length - failed}/${packages.length} verified (summary: ${summaryPath})`,
);
process.exit(failed === 0 ? 0 : 1);
