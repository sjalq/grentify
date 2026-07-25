#!/usr/bin/env node
/**
 * Ported-cache health: is the bank reachable, or silently all-miss?
 *
 * Why this exists (D56): the ported-cache key is a digest over the tool
 * version, EVERY `mappings/*.json` file, the platform label and the
 * namespacing flag. Editing one mapping byte therefore strands the entire
 * bank — including the four heavyweight hub families the whole drain loop
 * leans on (elm-review, elm-css, elm-syntax, elm-ui). Nothing reports that:
 * a stranded bank looks exactly like a cold one, except that every dependent
 * of a hub now re-ports the hub from scratch and blows its budget.
 *
 * Observed 2026-07-25: mappings/builtin.json edited 07-24 14:59, after the
 * walk banked its hubs on 07-23. 257 entries (every hub) unreachable; three
 * spot-checked packages that banked at 16-32s hit the 300s ceiling.
 *
 * Usage:
 *   node test/ecosystem/cache-health.cjs [--cache DIR] [--json]
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const defaultCacheDir = path.join(root, ".test-cache", "ecosystem", "cache");

/** Hub packages: one stranded entry here costs every dependent a full re-port. */
const HUBS = [
  "jfmengels__elm-review",
  "rtfeldman__elm-css",
  "stil4m__elm-syntax",
  "mdgriffith__elm-ui",
];

function parseArgs(argv) {
  const opts = { cacheDir: defaultCacheDir, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cache") opts.cacheDir = path.resolve(argv[++i]);
    else if (argv[i] === "--json") opts.json = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Byte-for-byte port of `PortedCache.canonicalInput`. Any drift here makes
 * this tool lie, so it is kept adjacent to the law it mirrors:
 *   1. tool version  2. sha256 of each mappings/*.json, sorted by basename
 *   3. platform label  4. namespacing flag
 */
function digest12(toolVersion, mappingsDir, platform, namespacing) {
  const files = fs
    .readdirSync(mappingsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => ({
      filename: e.name,
      contentSha256: sha256(fs.readFileSync(path.join(mappingsDir, e.name), "utf8")),
    }))
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  const canonical = [
    `tool:${toolVersion}`,
    `mappings:\n${files.map((f) => `${f.filename}:${f.contentSha256}`).join("\n")}`,
    `platform:${platform}`,
    namespacing ? "namespace:true" : "namespace:false",
  ].join("\n---ported-cache---\n");

  return sha256(canonical).slice(0, 12);
}

function toolVersion() {
  const main = fs.readFileSync(path.join(root, "src/Main.gren"), "utf8");
  const found = /version =\n\s*"([^"]+)"/.exec(main);
  return found ? found[1] : "0.1.0";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const portedRoot = path.join(opts.cacheDir, "ported");
  if (!fs.existsSync(portedRoot)) {
    console.log(`no ported cache at ${portedRoot} — nothing banked yet`);
    return;
  }

  const version = toolVersion();
  const mappingsDir = path.join(root, "mappings");
  const live = new Map();
  for (const platform of ["pure", "browser", "node"]) {
    for (const namespacing of [false, true]) {
      const d = digest12(version, mappingsDir, platform, namespacing);
      live.set(d, `${platform}${namespacing ? " (add)" : ""}`);
    }
  }

  const generations = new Map();
  for (const name of fs.readdirSync(portedRoot)) {
    const suffix = name.slice(name.lastIndexOf("__") + 2);
    const entry = generations.get(suffix) || { count: 0, newest: 0, hubs: [] };
    entry.count += 1;
    entry.newest = Math.max(
      entry.newest,
      fs.statSync(path.join(portedRoot, name)).mtimeMs,
    );
    for (const hub of HUBS) if (name.startsWith(`${hub}__`)) entry.hubs.push(hub);
    generations.set(suffix, entry);
  }

  const rows = [...generations.entries()]
    .map(([suffix, e]) => ({
      digest: suffix,
      reachable: live.has(suffix),
      label: live.get(suffix) || "stranded",
      ...e,
    }))
    .sort((a, b) => b.newest - a.newest);

  if (opts.json) {
    console.log(JSON.stringify({ toolVersion: version, live: [...live], generations: rows }, null, 2));
    return;
  }

  const reachableHubs = new Set(rows.filter((r) => r.reachable).flatMap((r) => r.hubs));
  const strandedHubs = new Set(
    rows.filter((r) => !r.reachable).flatMap((r) => r.hubs),
  );

  console.log(`PORTED CACHE HEALTH  (${portedRoot})`);
  console.log(`  tool version ${version}; live digests: ${[...live.keys()].join(", ")}`);
  console.log("");
  for (const r of rows) {
    const when = new Date(r.newest).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `  ${r.reachable ? "LIVE     " : "STRANDED "} ${r.digest}  ${String(r.count).padStart(4)} entries  newest ${when}  ${r.label}`,
    );
    if (r.hubs.length > 0) console.log(`            hubs: ${[...new Set(r.hubs)].join(", ")}`);
  }

  const lost = [...strandedHubs].filter((h) => !reachableHubs.has(h));
  console.log("");
  if (lost.length > 0) {
    console.log(`  WARNING: ${lost.length} hub family/families are banked ONLY under a stranded digest:`);
    for (const hub of lost) console.log(`    ${hub}`);
    console.log(
      "  Every dependent of these will re-port the whole hub and is likely to blow its budget.",
    );
    console.log(
      "  Re-bank by porting one small DEPENDENT of each hub (a root package is never cached):",
    );
    console.log(
      "    node scripts/walk-universe.cjs --only jfmengels/elm-review-debug@1.0.8 --log <scratch> --timeout-ms 1800000",
    );
    process.exitCode = 1;
  } else if (reachableHubs.size > 0) {
    console.log(`  OK: hubs reachable under a live digest (${[...reachableHubs].join(", ")}).`);
  } else {
    console.log("  No hub families banked in any generation yet.");
  }
}

main();
