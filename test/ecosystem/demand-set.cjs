#!/usr/bin/env node
/**
 * The demand set: which packages actually carry the ecosystem.
 *
 * The registry is not uniform. Measured on the cached manifests, the top 25
 * community packages carry half of ALL community dependency edges and only
 * ~500 of the 2,055 are depended on by anything at all. Porting the long tail
 * of leaves proves far less per unit of work than porting the hubs everything
 * else stands on.
 *
 * This ranks packages by fan-in (how many distinct packages depend on them),
 * splits them by platform (browser if the closure touches elm/browser, html,
 * svg or virtual-dom; pure otherwise), and joins the result against the walk
 * log so the output is a work list with live verdicts, not a popularity chart.
 *
 * Usage:
 *   node test/ecosystem/demand-set.cjs [--top N] [--platform pure|browser]
 *     [--failing] [--list] [--json]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { failureSignature } = require("./lib/failure-signature.cjs");

const root = path.resolve(__dirname, "../..");
const registryRoot = path.join(root, ".test-cache/ecosystem/cache/registry/packages");
const walkLogPath = path.join(root, "test/ecosystem/walk-log.jsonl");

/** Packages that ARE the platform layer; never candidates, never counted. */
const PLATFORM = /^(elm|elm-explorations)\//;
/** Direct evidence that a package's closure is browser-bound. */
const BROWSER = new Set(["elm/browser", "elm/html", "elm/svg", "elm/virtual-dom"]);
/** Always in the set regardless of rank: the tooling hubs. */
const ALWAYS = ["stil4m/elm-syntax", "jfmengels/elm-review"];

function parseArgs(argv) {
  const opts = { top: 200, platform: null, failing: false, list: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--platform") opts.platform = argv[++i];
    else if (a === "--failing") opts.failing = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--json") opts.json = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Newest manifest per package name from the acquisition cache. */
function loadManifests() {
  const byName = new Map();
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "elm-stuff" || e.name === "node_modules") continue;
        walk(p, depth + 1);
      } else if (e.name === "elm.json") {
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          if (!j.name || !j.name.includes("/")) continue;
          const prev = byName.get(j.name);
          if (!prev || compareVersions(j.version, prev.version) > 0) {
            byName.set(j.name, {
              name: j.name,
              version: j.version,
              deps: Object.keys(j.dependencies || {}).filter((k) => k.includes("/")),
            });
          }
        } catch {
          /* unreadable manifest */
        }
      }
    }
  };
  walk(registryRoot, 0);
  return byName;
}

function compareVersions(a, b) {
  const pa = String(a || "0.0.0").split(".").map(Number);
  const pb = String(b || "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Browser if anything in the transitive closure pulls a browser platform package. */
function isBrowser(name, manifests, memo = new Map(), seen = new Set()) {
  if (memo.has(name)) return memo.get(name);
  if (seen.has(name)) return false;
  seen.add(name);
  const entry = manifests.get(name);
  let result = false;
  if (entry) {
    for (const dep of entry.deps) {
      if (BROWSER.has(dep) || (!PLATFORM.test(dep) && isBrowser(dep, manifests, memo, seen))) {
        result = true;
        break;
      }
    }
  }
  memo.set(name, result);
  return result;
}

function loadWalk() {
  const latest = new Map();
  const read = (buf) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.name && rec.status !== "DRY-CANDIDATE") latest.set(rec.name, rec);
      } catch {
        /* torn line */
      }
    }
  };
  let n = 1;
  while (fs.existsSync(`${walkLogPath}.${n}.gz`)) {
    read(zlib.gunzipSync(fs.readFileSync(`${walkLogPath}.${n}.gz`)));
    n += 1;
  }
  if (fs.existsSync(walkLogPath)) read(fs.readFileSync(walkLogPath));
  return latest;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifests = loadManifests();
  const walk = loadWalk();

  const fanIn = new Map();
  for (const entry of manifests.values()) {
    for (const dep of new Set(entry.deps)) {
      if (PLATFORM.test(dep)) continue;
      fanIn.set(dep, (fanIn.get(dep) || 0) + 1);
    }
  }

  const memo = new Map();
  const ranked = [...fanIn.entries()]
    .map(([name, count]) => ({
      name,
      fanIn: count,
      platform: isBrowser(name, manifests, memo, new Set()) ? "browser" : "pure",
      walked: walk.get(name),
    }))
    .sort((a, b) => b.fanIn - a.fanIn || (a.name < b.name ? -1 : 1));

  const pick = (platform) => ranked.filter((r) => r.platform === platform).slice(0, opts.top);
  const set = new Map();
  for (const r of [...pick("pure"), ...pick("browser")]) set.set(r.name, r);
  for (const name of ALWAYS) {
    if (!set.has(name)) {
      const found = ranked.find((r) => r.name === name);
      if (found) set.set(name, found);
      else set.set(name, { name, fanIn: fanIn.get(name) || 0, platform: "pure", walked: walk.get(name) });
    }
  }

  const target = [...set.values()].sort((a, b) => b.fanIn - a.fanIn);
  const verdict = (r) =>
    !r.walked ? "NOT-WALKED" : r.walked.status === "PASS" ? "PASS" : r.walked.status === "EXEMPT" ? "EXEMPT" : "FAIL";

  const tally = {};
  for (const r of target) tally[verdict(r)] = (tally[verdict(r)] || 0) + 1;

  if (opts.json) {
    console.log(JSON.stringify({ tally, target: target.map((r) => ({ ...r, verdict: verdict(r) })) }, null, 2));
    return;
  }

  const pureCount = target.filter((r) => r.platform === "pure").length;
  console.log(`DEMAND SET  top ${opts.top} per platform by fan-in, plus ${ALWAYS.join(" + ")}`);
  console.log(`  ${target.length} packages (${pureCount} pure, ${target.length - pureCount} browser)`);
  const edges = [...fanIn.values()].reduce((a, b) => a + b, 0);
  const covered = target.reduce((a, r) => a + r.fanIn, 0);
  console.log(`  covers ${((covered / edges) * 100).toFixed(1)}% of all community dependency edges`);
  console.log("");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  const failing = target.filter((r) => verdict(r) === "FAIL" || verdict(r) === "NOT-WALKED");
  if (opts.failing || opts.list) {
    console.log("\nWORK LIST (highest fan-in first):");
    for (const r of failing) {
      const reason = r.walked ? r.walked.reason : "not walked";
      const sig = r.walked ? failureSignature(r.walked.evidence || "").signature : "-";
      console.log(`  ${String(r.fanIn).padStart(4)}  ${r.name.padEnd(42)} ${r.platform.padEnd(8)} ${reason}`);
      if (opts.list) console.log(`        ${sig}`);
    }
  }

  const bySig = new Map();
  for (const r of failing) {
    const sig = r.walked ? failureSignature(r.walked.evidence || "").signature : "not-walked";
    bySig.set(sig, (bySig.get(sig) || 0) + 1);
  }
  console.log("\nFAILURES BY ROOT-CAUSE SIGNATURE:");
  for (const [sig, n] of [...bySig.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${sig}`);
  }
}

main();
