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
// Tuple-pattern list cases still use outer popFirst.
assert.match(useOutput, /when Array\.popFirst \(values\) of/u);
// Pure list-shape cases compile via Array.length dispatch.
assert.match(useOutput, /list_scrut_elmToGren/u);
assert.match(useOutput, /Array\.length list_scrut_elmToGren is/u);
assert.match(useOutput, /Array\.pushFirst/u);
assert.match(
  useOutput,
  /Nothing -> Nothing Just \{ first = \{ first = first, second = second \}, rest = rest \}/u,
);
assert.match(
  useOutput,
  /Pairish \{ first = \{ first = first, second = second \} , second = \{ first = third, second = fourth \} \}/u,
);
const useRawOutput = transformedFixtureModule("structural", use);
// Nested / triple / exact multi-cons pure lists bind heads after length match.
assert.match(useRawOutput, /nestedConsPattern[\s\S]*?Array\.length list_scrut_elmToGren is/u);
assert.match(useRawOutput, /nestedConsPattern[\s\S]*?list_scrut_elmToGren/u);
assert.match(useRawOutput, /tripleConsPattern[\s\S]*?\bthird\b/u);
assert.match(useRawOutput, /exactDoubleCons[\s\S]*?Array\.length list_scrut_elmToGren is/u);
// Scrutinee cons is rewritten inside the length-dispatch let-binding.
assert.match(useRawOutput, /consScrutinee[\s\S]*?Array\.pushFirst/u);
assert.match(useOutput, /Result\.map Array\.popFirst/u);
assert.match(useOutput, /when Array\.popFirst rest_r\d+_c\d+_elmToGren_list is/u);
// Embedded ctor empty-list sibling supplies the Nothing fallback body.
assert.match(
  useOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren_list is\s+Just \{ first = first, rest = rest \} ->\s+first \+ List\.length rest\s+Nothing ->\s+0/u,
);
// Embedded exact `Ctor (x :: [])` needs an empty-rest guard.
assert.match(
  useRawOutput,
  /when Array\.popFirst rest_r\d+_c\d+_elmToGren_list is\n( +)Just \{ first = first, rest = rest_r\d+_c\d+_elmToGren_list_e \} ->\n\1 {4}when rest_r\d+_c\d+_elmToGren_list_e is\n\1 {8}\[\] ->\n\1 {12}first\n\1 {8}_ ->\n\1 {12}-1\n\1Nothing ->\n\1 {4}0/u,
);
// Pure list-shape cases (including former "unsafe" open/exact mixes and named
// catch-alls) compile via length dispatch. Remaining :: diagnostics are
// non-pure shapes (ctor-embedded refuse paths, etc.).
assert.ok(
  use.diagnostics.filter((d) => /cannot stay as \(::\)/u.test(d.message)).length
    >= 2,
);
assert.match(
  useRawOutput,
  /unsafeExactThenOpenRest[\s\S]*?Array\.length/u,
);
// Ctor-embedded open+exact still refuses (not a pure list scrutinee).
assert.match(
  useRawOutput,
  /unsafeEmbeddedExactThenOpen[\s\S]*?Box \(first :: \[\]\)[\s\S]*?Box \(first :: rest\)/u,
);
assert.match(
  useRawOutput,
  /unsafeExactThenVarCatchAll[\s\S]*?let\s+other\s*=/u,
);
assert.match(
  useRawOutput,
  /unsafeMultiConsVarCatchAll[\s\S]*?Array\.length/u,
);
assert.match(
  useRawOutput,
  /unsafeMultiConsOtherThenAll[\s\S]*?Array\.length/u,
);
assert.match(
  useRawOutput,
  /unsafeEmbeddedVarCatchAll[\s\S]*?Box \(first :: \[\]\)[\s\S]*?other/u,
);
// Tuple/Maybe multi-cons still use the classic popFirst path.
assert.match(
  useRawOutput,
  /unsafeTupleMultiConsVar[\s\S]*?other/u,
);
assert.match(
  useRawOutput,
  /unsafeMaybeMultiConsVar[\s\S]*?Just other|unsafeMaybeMultiConsVar[\s\S]*?Array\.length/u,
);
// `_` before a later `Ctor []`: empty-list Nothing must paste `_` body (-1).
assert.match(
  useRawOutput,
  /embeddedEmptyAfterAll[\s\S]*?when Array\.popFirst rest_r\d+_c\d+_elmToGren_list is\n( +)Just \{ first = first, rest = rest \} ->\n\1 {4}first \+ List\.length rest\n\1Nothing ->\n\1 {4}-1/u,
);
// Tuple multi-cons short peel pastes fully-wild `(_, _)` body (-1).
assert.match(
  useRawOutput,
  /tupleMultiConsWild[\s\S]*?when Array\.popFirst rest_r\d+_c\d+_elmToGren is\n( +)Just \{ first = second, rest = rest \} ->\n\1 {4}first \+ second \+ List\.length rest \+ n\n\1Nothing ->\n\1 {4}-1/u,
);
// Maybe multi-cons short peel pastes `Just _` body (-1).
assert.match(
  useRawOutput,
  /maybeMultiConsWild[\s\S]*?when Array\.popFirst rest_r\d+_c\d+_elmToGren is\n( +)Just \{ first = second, rest = rest \} ->\n\1 {4}first \+ second \+ List\.length rest\n\1Nothing ->\n\1 {4}-1/u,
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
