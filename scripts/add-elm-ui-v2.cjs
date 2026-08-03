#!/usr/bin/env node
/**
 * Vendor elm-ui 2.0 (unreleased, GitHub `2.0` branch) into example-project-ui2.
 *
 * elm-ui 2.0 is not on the Elm package registry and its elm.json is WIP:
 * it imports mdgriffith/elm-animator's v2 modules (Animator, Animator.Timeline,
 * Animator.Transition) without declaring the dependency, and its module docs
 * reference an unexposed `palette`. This script reproduces the port:
 *
 *   1. clone mdgriffith/elm-ui @ 2.0 and mdgriffith/elm-animator @ v2
 *   2. copy the animator sources into the elm-ui package (self-contained)
 *   3. patch the stale `@docs palette` entry and stamp version 2.0.0
 *   4. `elm-to-gren add` the patched local package into example-project-ui2
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appRoot = path.join(root, "example-project-ui2");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "elm-ui-v2-"));
const uiDir = path.join(work, "elm-ui");
const animatorDir = path.join(work, "elm-animator");

function run(cmd, args, opts = {}) {
  console.log("+", cmd, args.join(" "));
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} exited with ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

run("git", ["clone", "--depth", "1", "--branch", "2.0", "https://github.com/mdgriffith/elm-ui.git", uiDir]);
run("git", ["clone", "--depth", "1", "--branch", "v2", "https://github.com/mdgriffith/elm-animator.git", animatorDir]);

// elm-ui 2.0 imports Animator* without declaring the dependency; vendor the
// sources beside it. Their dependency sets already agree.
for (const entry of fs.readdirSync(path.join(animatorDir, "src"))) {
  fs.cpSync(path.join(animatorDir, "src", entry), path.join(uiDir, "src", entry), { recursive: true });
}

const uiElmJsonPath = path.join(uiDir, "elm.json");
const uiElmJson = JSON.parse(fs.readFileSync(uiElmJsonPath, "utf8"));
uiElmJson.version = "2.0.0";
fs.writeFileSync(uiElmJsonPath, JSON.stringify(uiElmJson, null, 4));

const uiMainPath = path.join(uiDir, "src", "Ui.elm");
fs.writeFileSync(
  uiMainPath,
  fs.readFileSync(uiMainPath, "utf8").replace("@docs Color, rgb, rgba, palette", "@docs Color, rgb, rgba"),
);

const cliArgs = [path.join(root, "bin", "elm-to-gren.cjs"), "add", uiDir, ...process.argv.slice(2)];
run("node", cliArgs, { cwd: appRoot });

fs.rmSync(work, { recursive: true, force: true });
console.log("elm-ui 2.0 vendored into", appRoot);
