import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reviewRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectRoot = path.dirname(reviewRoot);
// D55: resolve exactly the way the tool does (Orchestrator.binary) — local
// install first, PATH otherwise. Hardcoding the node_modules path made tier 1
// unrunnable whenever node_modules is absent, which is the state of a fresh
// clone: `elm-review` is not in devDependencies at all, only in the lock.
const localElmReview = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  "elm-review",
);
const elmReview = existsSync(localElmReview) ? localElmReview : "elm-review";

function extractFixture(name) {
  const elmJson = path.join(reviewRoot, "fixtures", name, "elm.json");
  const result = spawnSync(
    elmReview,
    [
      "--extract",
      "--report=json",
      "--rules",
      "ElmToGren",
      "--config",
      reviewRoot,
      "--elmjson",
      elmJson,
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.errors, []);
  assert.equal(report.extracts.ElmToGren.schemaVersion, 1);
  return report.extracts.ElmToGren;
}

function offsetAt(source, position) {
  const lines = source.split("\n");
  assert.ok(position.row >= 1 && position.row <= lines.length);
  const line = lines[position.row - 1];
  const prefix = Array.from(line)
    .slice(0, position.column - 1)
    .join("");
  assert.equal(Array.from(prefix).length, position.column - 1);

  let offset = 0;
  for (let row = 0; row < position.row - 1; row += 1) {
    offset += lines[row].length + 1;
  }
  return offset + prefix.length;
}

function applyEdits(source, edits) {
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(source, edit.range.start),
      end: offsetAt(source, edit.range.end),
      edit,
    }))
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.edit.kind.localeCompare(right.edit.kind) ||
        left.edit.replacement.localeCompare(right.edit.replacement),
    );

  for (let leftIndex = 0; leftIndex < resolved.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < resolved.length;
      rightIndex += 1
    ) {
      const left = resolved[leftIndex];
      const right = resolved[rightIndex];
      const leftInsertion = left.start === left.end;
      const rightInsertion = right.start === right.end;
      const collide =
        leftInsertion && rightInsertion
          ? left.start === right.start
          : leftInsertion
            ? left.start > right.start && left.start < right.end
            : rightInsertion
              ? right.start > left.start && right.start < left.end
              : left.start < right.end && right.start < left.end;
      assert.equal(
        collide,
        false,
        `colliding edits: ${JSON.stringify([left.edit, right.edit])}`,
      );
    }
  }

  let output = source;
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    const { start, end, edit } = resolved[index];
    output = output.slice(0, start) + edit.replacement + output.slice(end);
  }
  return output;
}

function moduleNamed(extraction, name) {
  const found = extraction.modules.find(
    (module_) => module_.moduleName === name,
  );
  assert.ok(found, `missing extracted module ${name}`);
  return found;
}

function transformedFixtureModule(fixture, module_) {
  const source = readFileSync(
    path.join(reviewRoot, "fixtures", fixture, module_.path),
    "utf8",
  );
  return applyEdits(source, module_.edits);
}

function compact(source) {
  return source.replace(/\s+/gu, " ").trim();
}

const structural = extractFixture("structural");
const definitions = moduleNamed(structural, "Definitions");
const use = moduleNamed(structural, "Use");
const portBoundary = moduleNamed(structural, "PortBoundary");
const kernelBoundary = moduleNamed(structural, "KernelBoundary");
const reserved = moduleNamed(structural, "Reserved");

assert.deepEqual(Object.keys(use).sort(), [
  "ast",
  "constructors",
  "detectedPlatform",
  "diagnostics",
  "edits",
  "importFacts",
  "importedModules",
  "moduleName",
  "path",
  "recordAliases",
  "references",
  "requiredAdapters",
]);
assert.equal(typeof use.ast, "object");
assert.ok(use.ast !== null);
assert.equal(use.ast.schemaVersion, 1);
assert.equal(use.ast.moduleDefinition.moduleName, "Use");
assert.deepEqual(use.importedModules, ["List", "Tuple", "Definitions"]);
assert.deepEqual(use.requiredAdapters, ["List", "Tuple"]);
assert.deepEqual(
  definitions.constructors.map(({ name, arity }) => [name, arity]),
  [
    ["Pairish", 2],
    ["Single", 1],
    ["Nested", 2],
  ],
);
assert.deepEqual(
  definitions.recordAliases.map(({ name, fields }) => [name, fields]),
  [
    ["Empty", []],
    ["Alias", ["left", "right"]],
  ],
);

const definitionsRawOutput = transformedFixtureModule(
  "structural",
  definitions,
);
const definitionsOutput = compact(definitionsRawOutput);
assert.match(definitionsOutput, /Pairish \{ first : a , second : b \}/u);
assert.match(
  definitionsOutput,
  /Nested \{ first : \{ first : a, second : b \} , second : \{ first : b, second : a \} \}/u,
);
assert.match(
  definitionsOutput,
  /second = Array\.pushFirst \(3 \) \( Array\.pushFirst \(4 \) \( \[\]\)\)/u,
);
assert.match(
  definitionsOutput,
  /Array\.pushFirst \(1 \{- keep :: in this comment -\} \) \( \{- keep this gap -\} \[\]\)/u,
);
assert.match(
  definitionsRawOutput,
  /Array\.pushFirst \(1\n\s*-- keep :: in this line comment\n\s*\) \( \[\]\)/u,
);
assert.match(
  definitionsOutput,
  /Array\.pushFirst \(\(\\arg1_elmToGren arg2_elmToGren -> Pairish \{ first = arg1_elmToGren, second = arg2_elmToGren \}\) 1 2 \) \( Array\.pushFirst \(\(\\arg1_elmToGren arg2_elmToGren/u,
);
assert.match(definitionsOutput, /empty = \{\}/u);
assert.equal(
  definitionsRawOutput
    .replace(/\{-[\s\S]*?-\}/gu, "")
    .replace(/--[^\n]*/gu, "")
    .includes("::"),
  false,
);

const useOutput = compact(transformedFixtureModule("structural", use));
assert.match(
  useOutput,
  /\\arg1_elmToGren arg2_elmToGren -> Pairish \{ first = arg1_elmToGren, second = arg2_elmToGren \}/u,
);
assert.match(
  useOutput,
  /\\arg1_elmToGren arg2_elmToGren -> D\.Pairish \{ first = arg1_elmToGren, second = arg2_elmToGren \}/u,
);
assert.match(
  useOutput,
  /\\arg1_elmToGren arg2_elmToGren -> \{ left = arg1_elmToGren, right = arg2_elmToGren \}/u,
);
assert.match(useOutput, /qualifiedAlias = \(\\arg1_elmToGren arg2_elmToGren/u);
assert.match(useOutput, /empty = \{\}/u);
// List/cons *case* totalization lives on the host (Ast.MatchCompile). The
// rule only renames case→when and still rewrites expression-side (::).
assert.match(useOutput, /when values of/u);
assert.match(useOutput, /Array\.pushFirst/u);
assert.match(
  useOutput,
  /Pairish \{ first = \{ first = first, second = second \} , second = \{ first = third, second = fourth \} \}/u,
);
const useRawOutput = transformedFixtureModule("structural", use);
// Expression cons in scrutinees still rewrites under the edit path.
assert.match(useRawOutput, /consScrutinee[\s\S]*?Array\.pushFirst/u);
// Case arm (::) patterns are left for the host AST path (not string-edited).
assert.match(useRawOutput, /nestedConsPattern[\s\S]*?first :: second :: rest/u);
assert.match(useRawOutput, /embeddedCtorUncons[\s\S]*?Box \(first :: rest\)/u);
assert.match(useRawOutput, /resultUncons[\s\S]*?Ok \(first :: rest\)/u);
// Case-arm (::) no longer emits refuse diagnostics from the rule.
assert.equal(
  use.diagnostics.filter((d) => /cannot stay as \(::\)/u.test(d.message))
    .length,
  0,
);

// Port modules are allowed application targets; no hard refusal diagnostics.
assert.deepEqual(portBoundary.diagnostics.map(({ code }) => code), []);
assert.deepEqual(
  kernelBoundary.diagnostics.map(({ code }) => code),
  ["UNSUPPORTED_KERNEL", "UNSUPPORTED_KERNEL"],
);
// Gren reserved words `when`/`is` are rewritten to `when_`/`is_`, not refused.
assert.equal(reserved.diagnostics.length, 0);
const reservedOutput = transformedFixtureModule("structural", reserved);
assert.match(reservedOutput, /module Reserved exposing \(is_, when_\)/u);
assert.match(reservedOutput, /when_ : Int -> Int/u);
assert.match(reservedOutput, /when_ is_ =/u);
assert.match(reservedOutput, /let\s+when_ =/u);
assert.match(reservedOutput, /\{\s*is_ = when_\s*\}\.is_/u);
assert.doesNotMatch(reservedOutput, /\bwhen\b/u);
assert.doesNotMatch(reservedOutput, /\bis\b/u);

const effect = moduleNamed(extractFixture("effect"), "EffectBoundary");
assert.deepEqual(
  effect.diagnostics.map(({ code }) => code),
  ["UNSUPPORTED_KERNEL"],
);

console.log("elm-review extractor fixtures passed");
