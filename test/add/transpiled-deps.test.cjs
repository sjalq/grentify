/**
 * `add` a package whose own dependency has to be transpiled too.
 *
 * Both packages are vendored as siblings under `.elm-to-gren/packages`, and
 * the library's manifest reaches its dependency as `local:../<dir>`. Gren
 * rejects a dependency that declares a local dependency of its own unless the
 * root project points at the same directory, so the application manifest has
 * to name it as well — `local:.elm-to-gren/packages/<dir>`, the same place
 * read from the app root. Without that entry every such add failed
 * verification and rolled back, which is to say `add` worked only for
 * libraries whose whole dependency set was already mapped to Gren.
 *
 * `example/transitive` depends on `elm-community/maybe-extra`, which is not in
 * the catalog, so this fetches from the Elm registry the same way the e2e
 * scenarios do.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "elm-to-gren-transpiled-deps-"),
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
      path.join(root, "test/fixtures/transitive"),
      "--out",
      application,
      "--cache",
      cache,
      "--platform",
      "browser",
    ],
    { cwd: root, encoding: "utf8", timeout: 900_000 },
  );

  assert.equal(
    result.status,
    0,
    `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const vendored = fs
    .readdirSync(path.join(application, ".elm-to-gren/packages"), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.equal(
    vendored.length,
    2,
    `expected the library and its transpiled dependency, got ${vendored.join(", ")}`,
  );

  const dependencyDirectory = vendored.find((name) =>
    name.startsWith("elm-community_maybe-extra__"),
  );
  assert.ok(
    dependencyDirectory,
    `the transpiled dependency was not vendored: ${vendored.join(", ")}`,
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(application, "gren.json"), "utf8"),
  );
  const declared = {
    ...manifest.dependencies.direct,
    ...manifest.dependencies.indirect,
  };

  assert.equal(
    declared["example/transitive"],
    "local:.elm-to-gren/packages/example_transitive__1_0_0",
    "the library is not a local dependency of the application",
  );
  assert.equal(
    declared["elm-community/maybe-extra"],
    `local:.elm-to-gren/packages/${dependencyDirectory}`,
    "the transpiled dependency is not declared by the application, so gren cannot resolve it",
  );

  // The two manifests must name one directory, not two that merely sound
  // alike — that identity is the whole of what gren checks.
  const libraryManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        application,
        ".elm-to-gren/packages/example_transitive__1_0_0/gren.json",
      ),
      "utf8",
    ),
  );
  const fromLibrary = libraryManifest.dependencies["elm-community/maybe-extra"];
  assert.ok(
    typeof fromLibrary === "string" && fromLibrary.startsWith("local:"),
    `the library should reach its dependency locally, got ${fromLibrary}`,
  );
  assert.equal(
    path.resolve(
      application,
      ".elm-to-gren/packages/example_transitive__1_0_0",
      fromLibrary.slice("local:".length),
    ),
    path.resolve(
      application,
      declared["elm-community/maybe-extra"].slice("local:".length),
    ),
    "the application and the library resolve the dependency to different directories",
  );

  console.log(
    "PASS: add vendors a transpiled dependency and declares it where gren can resolve it",
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
