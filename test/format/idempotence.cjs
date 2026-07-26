#!/usr/bin/env node
/**
 * W6.5 — format/collapse idempotence on real package output.
 *
 * Law: after gren-format + collapse-record-patterns, re-applying the collapse
 * transform is a fixed point. That is the property that would have caught
 * D48 (string split on second apply), D67a (header repair thrash), D71's
 * class of layout damage, and D82 (ENDLESS STRING / expression-let join).
 *
 * Corpus:
 *   1. Defect specimens ported fresh (the-sett/elm-syntax-dsl, hrldcpr/elm-cons)
 *   2. Any trees already under .test-cache/ecosystem-canary/out (canary run)
 *
 * Prefix NODE_OPTIONS= when invoking from shells that set a preload.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { transform } = require("../../tools/gren-format/collapse-record-patterns.cjs");

const root = path.resolve(__dirname, "../..");
const cache = path.join(root, ".test-cache/ecosystem/cache");
const outRoot = path.join(root, ".test-cache/format-idempotence");
const cli = path.join(root, "bin/elm-to-gren.cjs");

const SPECIMENS = [
  "the-sett/elm-syntax-dsl",
  "hrldcpr/elm-cons",
];

function walkGren(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "gren_packages" ||
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".elm-to-gren" ||
      entry.name === ".gren" ||
      entry.name === "elm-stuff"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkGren(full, files);
    else if (entry.isFile() && entry.name.endsWith(".gren")) files.push(full);
  }
  return files;
}

/**
 * @param {string} label
 * @param {string} dir
 * @param {{ requirePipelineStable?: boolean }} [opts]
 *   requirePipelineStable — assert transform(text) === text. True for packages
 *   we just ran through format+collapse in this process. False for canary /
 *   ported-cache trees: those may still carry multi-line simple records that
 *   a *first* collapse would tighten (layout-only, token-preserving). The law
 *   that stops D48/D82 is idempotence after one apply, not "every historical
 *   byte is already collapsed".
 */
function assertCollapseFixedPoint(label, dir, opts = {}) {
  const requirePipelineStable = opts.requirePipelineStable === true;
  const files = walkGren(dir);
  assert.ok(files.length > 0, label + ": expected at least one .gren under " + dir);
  let checked = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const once = transform(text);
    const twice = transform(once);
    assert.equal(
      twice,
      once,
      label + " transform not idempotent on " + path.relative(dir, file),
    );
    if (requirePipelineStable) {
      // Fresh format+collapse output must already be a fixed point — a second
      // collapse walk (the D48 re-entry class) must not change a single byte.
      assert.equal(
        once,
        text,
        label +
          " pipeline output not collapse-stable on " +
          path.relative(dir, file),
      );
    }
    checked += 1;
  }
  return checked;
}

function port(spec) {
  const name = spec.replace("/", "__");
  const out = path.join(outRoot, name);
  fs.rmSync(out, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [cli, spec, "--out", out, "--cache", cache],
    {
      encoding: "utf8",
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.equal(
    result.status,
    0,
    "port " + spec + " failed:\n" + (result.stderr || result.stdout),
  );
  return out;
}

fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(cache, { recursive: true });

let total = 0;
for (const spec of SPECIMENS) {
  process.stdout.write("W6.5 port " + spec + " ... ");
  const out = port(spec);
  const n = assertCollapseFixedPoint(spec, out, { requirePipelineStable: true });
  total += n;
  console.log("ok (" + n + " modules, collapse fixed point)");
}

// Canary trees when present (ecosystem:canary leaves them under this path).
const canaryOut = path.join(root, ".test-cache/ecosystem-canary/out");
if (fs.existsSync(canaryOut)) {
  const pkgs = fs
    .readdirSync(canaryOut, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const pkg of pkgs) {
    const dir = path.join(canaryOut, pkg);
    const n = assertCollapseFixedPoint("canary:" + pkg, dir, {
      requirePipelineStable: false,
    });
    total += n;
    console.log("W6.5 canary " + pkg + " ok (" + n + " modules, idempotent)");
  }
} else {
  console.log("W6.5 canary corpus skipped (no .test-cache/ecosystem-canary/out yet)");
}

console.log("W6.5 format idempotence: " + total + " modules at collapse fixed point");
