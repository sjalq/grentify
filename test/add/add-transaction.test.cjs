const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { acquireForArgs } = require("../../bin/add-lock.cjs");

const root = path.resolve(__dirname, "../..");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "elm-to-gren-add-e2e-"),
);
const application = path.join(temporary, "application");
const cache = path.join(temporary, "cache-with-'quote");
const simpleInput = path.join(temporary, "simple");
const creativeInput = path.join(temporary, "creative");

try {
  copyDirectory(path.join(root, "test/fixtures/simple"), simpleInput);
  copyDirectory(path.join(root, "test/fixtures/creative"), creativeInput);
  createApplication(application);
  verifyConcurrentAddLock();

  runAdd(simpleInput);
  const firstDirectory = "example_simple__1_0_0";
  assertPackage(firstDirectory, "src/Elm/Simple.gren");

  runAdd(creativeInput);
  const secondDirectory = "example_creative__1_0_0";
  assertPackage(firstDirectory, "src/Elm/Simple.gren");
  assertPackage(secondDirectory, "src/Elm/Generators.gren");

  const acceptedManifest = fs.readFileSync(
    path.join(application, "gren.json"),
    "utf8",
  );
  const acceptedPackages = packageDirectories();
  assert.match(acceptedManifest, /"example\/simple"/);
  assert.match(acceptedManifest, /"example\/creative"/);
  assert.ok(
    !fs.existsSync(path.join(simpleInput, "elm-stuff")),
    "local simple input was mutated by extraction",
  );
  assert.ok(
    !fs.existsSync(path.join(creativeInput, "elm-stuff")),
    "local creative input was mutated by extraction",
  );

  // D51 law: the consumer's own broken sources are NOT our failure. An
  // application is very often mid-edit exactly when a dependency is added, so
  // the install stands and the breakage is reported.
  fs.writeFileSync(
    path.join(application, "src/Main.gren"),
    "module Main exposing (main)\n\nmain = thisDoesNotCompile\n",
  );

  const overBrokenSources = invokeAdd(creativeInput);
  assert.equal(
    overBrokenSources.status,
    0,
    `add into an application with pre-existing source errors must succeed\nstdout:\n${overBrokenSources.stdout}\nstderr:\n${overBrokenSources.stderr}`,
  );
  assert.match(
    `${overBrokenSources.stdout}${overBrokenSources.stderr}`,
    /this application's own sources do not compile/,
    "a kept install over broken consumer sources must warn",
  );
  assertPackage(secondDirectory, "src/Elm/Generators.gren");
  assert.deepEqual(
    packageDirectories(),
    acceptedPackages,
    "re-adding over broken sources must leave the package set intact",
  );
  assert.match(
    fs.readFileSync(path.join(application, "gren.json"), "utf8"),
    /"example\/creative"/,
    "the install was kept, so the manifest must still name the package",
  );

  // ...but a failure that implicates the manifest or the vendored tree IS
  // ours, and still rolls the whole publication back.
  const manifestBeforeRollback = fs.readFileSync(
    path.join(application, "gren.json"),
    "utf8",
  );
  const packagesBeforeRollback = packageDirectories();
  const withoutIndirect = JSON.parse(manifestBeforeRollback);
  delete withoutIndirect.dependencies.indirect["gren-lang/url"];
  fs.writeFileSync(
    path.join(application, "gren.json"),
    `${JSON.stringify(withoutIndirect, null, 4)}\n`,
  );
  const brokenManifest = fs.readFileSync(
    path.join(application, "gren.json"),
    "utf8",
  );

  const rejected = invokeAdd(simpleInput);
  assert.notEqual(
    rejected.status,
    0,
    "a manifest gren refuses to resolve must fail the add",
  );
  assert.equal(
    fs.readFileSync(path.join(application, "gren.json"), "utf8"),
    brokenManifest,
    "failed host verification did not restore gren.json",
  );
  assert.deepEqual(
    packageDirectories(),
    packagesBeforeRollback,
    "failed host verification did not restore the package tree",
  );

  console.log(
    "PASS: sequential add preserves packages; broken consumer sources warn and keep; manifest-level failure rolls back",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function runAdd(input) {
  const result = invokeAdd(input);
  assert.equal(
    result.status,
    0,
    `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function invokeAdd(input) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "bin/elm-to-gren.cjs"),
      "add",
      input,
      "--out",
      application,
      "--cache",
      cache,
      "--platform",
      "browser",
      "--no-extract-cache",
      "--no-ported-cache",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
}

function verifyConcurrentAddLock() {
  const args = ["add", simpleInput, "--out", application];
  const first = acquireForArgs(args, root);
  assert.equal(first.error, null, "could not acquire the first add lock");

  const second = acquireForArgs(args, root);
  assert.match(
    second.error ?? "",
    /^ADD_LOCKED:/,
    "a concurrent add acquired the same application lock",
  );
  const blockedCli = invokeAdd(simpleInput);
  assert.notEqual(blockedCli.status, 0, "the CLI ignored a live add lock");
  assert.match(blockedCli.stderr, /^ADD_LOCKED:/);

  first.release();
  const afterRelease = acquireForArgs(args, root);
  assert.equal(
    afterRelease.error,
    null,
    "released add lock could not be reused",
  );
  afterRelease.release();
}

function assertPackage(directory, source) {
  assert.ok(
    fs.existsSync(
      path.join(application, ".elm-to-gren/packages", directory, source),
    ),
    `${directory}/${source} is missing`,
  );
}

function packageDirectories() {
  return fs
    .readdirSync(path.join(application, ".elm-to-gren/packages"), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => path.basename(entry) !== "elm-stuff",
  });
}
