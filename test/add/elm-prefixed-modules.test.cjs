/**
 * A package whose own modules already start with `Elm.`, under `add`.
 *
 * `add` namespaces ported modules with an `Elm.` prefix. D14 says a module
 * already named `Elm.X` (stil4m/elm-syntax's `Elm.Parser`, `Elm.Dependency`,
 * …) is never double-prefixed — but that rule was only applied to the
 * manifest's exposed-modules. The sources and the importer rewrite map still
 * prefixed unconditionally, so gren.json exposed `Elm.Facts` while the file
 * on disk declared `Elm.Elm.Facts`, and `gren docs` failed the verify with
 * MISSING MODULE on every such package.
 *
 * The fixture pairs an already-prefixed module with an unprefixed sibling
 * that imports it, so one add exercises both sides of the rule.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "elm-to-gren-prefixed-"),
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
      path.join(root, "test/fixtures/elm-prefixed"),
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

  const packageRoot = path.join(
    application,
    ".elm-to-gren/packages/example_elm-prefixed__1_0_0",
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "gren.json"), "utf8"),
  );
  assert.deepEqual(
    [...manifest["exposed-modules"]].sort(),
    ["Elm.Facts", "Elm.Helper"],
    "exposed-modules must keep Elm.Facts single-prefixed and prefix Helper",
  );

  const facts = fs.readFileSync(
    path.join(packageRoot, "src/Elm/Facts.gren"),
    "utf8",
  );
  assert.match(
    facts,
    /^module Elm\.Facts /m,
    "an already-prefixed module was renamed",
  );

  const helper = fs.readFileSync(
    path.join(packageRoot, "src/Elm/Helper.gren"),
    "utf8",
  );
  assert.match(
    helper,
    /^module Elm\.Helper /m,
    "the unprefixed sibling did not receive the Elm. prefix",
  );
  assert.match(
    helper,
    /^import Elm\.Facts$/m,
    "the import of the already-prefixed module must survive unchanged",
  );
  assert.doesNotMatch(
    helper,
    /Elm\.Elm\./,
    "a double Elm.Elm. prefix leaked into the importer rewrite",
  );

  console.log(
    "PASS: modules already named Elm.* keep their names under add; siblings still get the prefix",
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
