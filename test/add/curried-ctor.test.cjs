/**
 * A multi-argument constructor named across a module boundary, under `add`.
 *
 * `add` prefixes every ported module with `Elm.`, and it does so by mapping
 * the module in the transform registry — which rewrites what importers call
 * the module, but not what the module calls itself. Package-wide facts are
 * keyed by module name, so a constructor's arity used to be filed under the
 * name nobody looks it up by, and `Ast.Tagged` standing on its own was left
 * uncurried against a one-record variant. `gren docs` then rejected the
 * package the tool had just declared verified.
 *
 * The fixture is deliberately dependency-free, so a failure here is about the
 * transform and nothing else.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "elm-to-gren-curried-"),
);
const application = path.join(temporary, "application");
const cache = path.join(temporary, "cache");

try {
  createApplication(application);

  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "bin/elm-to-gren.cjs"),
      "add",
      path.join(root, "test/fixtures/curried"),
      "--out",
      application,
      "--cache",
      cache,
      "--platform",
      "browser",
      "--no-extract-cache",
      "--no-ported-cache",
    ],
    { cwd: root, encoding: "utf8", timeout: 300_000 },
  );

  assert.equal(
    result.status,
    0,
    `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const ported = fs.readFileSync(
    path.join(
      application,
      ".elm-to-gren/packages/example_curried__1_0_0/src/Elm/Curried.gren",
    ),
    "utf8",
  );

  assert.doesNotMatch(
    ported,
    /Ast\.Tagged(?!\s*\()/,
    "a bare cross-module reference to a two-argument constructor survived the transform",
  );
  assert.match(
    ported,
    /ctor_Tagged_elmToGren/,
    "the curried helper for the constructor was never generated",
  );

  console.log(
    "PASS: a multi-argument constructor named across modules stays curried under add",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function createApplication(directory) {
  fs.mkdirSync(path.join(directory, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "gren.json"),
    `${JSON.stringify(
      {
        type: "application",
        platform: "browser",
        "source-directories": ["src"],
        "gren-version": "0.6.6",
        dependencies: {
          direct: {
            "gren-lang/browser": "6.0.2",
            "gren-lang/core": "7.4.2",
          },
          indirect: {
            "gren-lang/url": "6.0.0",
          },
        },
      },
      null,
      4,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "src/Main.gren"),
    `module Main exposing (main)

import Browser
import Html

main =
    Browser.sandbox
        { init = {}
        , update = \\_ model -> model
        , view = \\_ -> Html.text "ok"
        }
`,
  );
}
