import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reviewRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectRoot = path.dirname(reviewRoot);
const elmReview = path.join(projectRoot, "node_modules", ".bin", "elm-review");

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
assert.match(useOutput, /when Array\.popFirst \(values\) of/u);
assert.match(
  useOutput,
  /when Array\.popFirst \(Array\.pushFirst \(1 \) \( values\)\) of/u,
);
assert.match(
  useOutput,
  /Nothing -> Nothing Just \{ first = \{ first = first, second = second \}, rest = rest \}/u,
);
assert.match(
  useOutput,
  /Pairish \{ first = \{ first = first, second = second \} , second = \{ first = third, second = fourth \} \}/u,
);
assert.match(
  useOutput,
  /Just \{ first = first, rest = rest_r\d+_c\d+_elmToGren \} ->/u,
);
assert.match(
  useOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren of/u,
);
assert.match(
  useOutput,
  /Just \{ first = second, rest = rest \} ->/u,
);
// Multi-cons short-list fallthrough uses the `_` branch body, not Debug.todo.
assert.match(
  useOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren of\s+Just \{ first = second, rest = rest \} ->\s+first \+ second \+ List\.length rest\s+Nothing ->\s+0/u,
);
// Nested when branches must be indented past `when` (layout-sensitive).
const useRawOutput = transformedFixtureModule("structural", use);
assert.match(
  useRawOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren of\n +Just \{ first = second, rest = rest \} ->\n +first \+ second \+ List\.length rest\n +Nothing ->\n +0/u,
);
// Triple-cons: each nested `when` must indent its Just/Nothing arms (+4), not
// share a column with the when keyword (Gren layout).
assert.match(
  useRawOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren of\n( +)Just \{ first = second, rest = rest_r\d+_c\d+_elmToGren_n0 \} ->\n\1 {4}when Array\.popFirst rest_r\d+_c\d+_elmToGren_n0 of\n\1 {8}Just \{ first = third, rest = rest \} ->\n\1 {12}first \+ second \+ third \+ List\.length rest\n\1 {8}Nothing ->\n\1 {12}0\n\1Nothing ->\n\1 {4}0/u,
);
// Exact multi-cons (`a :: b :: []`) must not emit non-exhaustive `rest = []`
// inside a nested Just arm; guard with `when rest is []`.
assert.match(
  useRawOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren of\n( +)Just \{ first = second, rest = rest_r\d+_c\d+_elmToGren_n0_e \} ->\n\1 {4}when rest_r\d+_c\d+_elmToGren_n0_e is\n\1 {8}\[\] ->\n\1 {12}first \+ second\n\1 {8}_ ->\n\1 {12}0\n\1Nothing ->\n\1 {4}0/u,
);
assert.match(useOutput, /Result\.map Array\.popFirst/u);
assert.match(useOutput, /when Array\.popFirst rest_r\d+_c\d+_elmToGren_list of/u);
// Embedded ctor empty-list sibling supplies the Nothing fallback body.
assert.match(
  useOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren_list of\s+Just \{ first = first, rest = rest \} ->\s+first \+ List\.length rest\s+Nothing ->\s+0/u,
);
// Embedded exact `Ctor (x :: [])` needs an empty-rest guard. Longer lists use
// the `_` branch body (-1); empty lists use the sibling `Ctor []` body (0).
assert.match(
  useRawOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren_list of\n( +)Just \{ first = first, rest = rest_r\d+_c\d+_elmToGren_e \} ->\n\1 {4}when rest_r\d+_c\d+_elmToGren_e is\n\1 {8}\[\] ->\n\1 {12}first\n\1 {8}_ ->\n\1 {12}-1\n\1Nothing ->\n\1 {4}0/u,
);
// Unsafe exact-then-open-rest shapes must refuse: nested empty-rest guards
// cannot fall through to an open-rest sibling, so :: patterns remain.
// Named catch-alls (`other`) likewise refuse: fallbacks cannot rebind them.
// Named catch-all before `_` must refuse: short-list peels would paste `_`.
// Tuple/Maybe open catch-alls with bindings also refuse.
assert.ok(
  use.diagnostics.filter((d) => /List \(::\) pattern/u.test(d.message)).length
    >= 8,
);
assert.match(
  useRawOutput,
  /unsafeExactThenOpenRest[\s\S]*?first :: second :: \[\][\s\S]*?first :: second :: rest/u,
);
assert.match(
  useRawOutput,
  /unsafeEmbeddedExactThenOpen[\s\S]*?Box \(first :: \[\]\)[\s\S]*?Box \(first :: rest\)/u,
);
assert.match(
  useRawOutput,
  /unsafeExactThenVarCatchAll[\s\S]*?first :: second :: \[\][\s\S]*?other/u,
);
assert.match(
  useRawOutput,
  /unsafeMultiConsVarCatchAll[\s\S]*?first :: second :: rest[\s\S]*?other/u,
);
assert.match(
  useRawOutput,
  /unsafeMultiConsOtherThenAll[\s\S]*?first :: second :: rest[\s\S]*?other[\s\S]*?_/u,
);
assert.match(
  useRawOutput,
  /unsafeEmbeddedVarCatchAll[\s\S]*?Box \(first :: \[\]\)[\s\S]*?other/u,
);
assert.match(
  useRawOutput,
  /unsafeTupleMultiConsVar[\s\S]*?first :: second :: rest[\s\S]*?other/u,
);
assert.match(
  useRawOutput,
  /unsafeMaybeMultiConsVar[\s\S]*?first :: second :: rest[\s\S]*?Just other/u,
);
// `_` before a later `Ctor []`: empty-list Nothing must paste `_` body (-1).
assert.match(
  useRawOutput,
  /embeddedEmptyAfterAll[\s\S]*?when Array\.popFirst rest_r\d+_c\d+_elmToGren_list of\n( +)Just \{ first = first, rest = rest \} ->\n\1 {4}first \+ List\.length rest\n\1Nothing ->\n\1 {4}-1/u,
);
// Tuple multi-cons short peel pastes fully-wild `(_, _)` body (-1).
assert.match(
  useRawOutput,
  /tupleMultiConsWild[\s\S]*?when Array\.popFirst rest_r\d+_c\d+_elmToGren of\n( +)Just \{ first = second, rest = rest \} ->\n\1 {4}first \+ second \+ List\.length rest \+ n\n\1Nothing ->\n\1 {4}-1/u,
);
// Maybe multi-cons short peel pastes `Just _` body (-1).
assert.match(
  useRawOutput,
  /maybeMultiConsWild[\s\S]*?when Array\.popFirst rest_r\d+_c\d+_elmToGren of\n( +)Just \{ first = second, rest = rest \} ->\n\1 {4}first \+ second \+ List\.length rest\n\1Nothing ->\n\1 {4}-1/u,
);

assert.deepEqual(
  portBoundary.diagnostics.map(({ code }) => code),
  ["UNMAPPED_MODULE", "UNMAPPED_SYMBOL"],
);
assert.deepEqual(
  kernelBoundary.diagnostics.map(({ code }) => code),
  ["UNSUPPORTED_KERNEL", "UNSUPPORTED_KERNEL"],
);
assert.ok(reserved.diagnostics.length >= 6);
assert.ok(reserved.diagnostics.every(({ code }) => code === "UNMAPPED_SYMBOL"));
assert.ok(
  reserved.diagnostics.every(({ message }) =>
    /reserved word in Gren/u.test(message),
  ),
);

const effect = moduleNamed(extractFixture("effect"), "EffectBoundary");
assert.deepEqual(
  effect.diagnostics.map(({ code }) => code),
  ["UNSUPPORTED_KERNEL"],
);

console.log("elm-review extractor fixtures passed");
