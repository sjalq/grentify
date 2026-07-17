# Test Framework Mapping: elm-explorations/test -> gren-lang/test

## Overview

elm-explorations/test v2.x maps to gren-lang/test v5.0.0.
The frameworks are structurally very similar. Most APIs have the same name.
Three systematic changes apply across the entire API surface:

1. **List -> Array**: All `List` parameters/returns become `Array`
2. **() -> {}**: Unit type `()` becomes `{}` (affects test thunks, Fuzz.lazy, Fuzz.unit)
3. **Tuples -> Records**: Tuple arguments become records (affects Fuzz.frequency, Fuzz.pair, Fuzz.triple, Test.reportDistribution, Test.expectDistribution, Expect.AbsoluteOrRelative)

## Value Renames (function/constructor name changes)

These are the ONLY name changes. Everything else keeps the same name.

| Module               | Elm name             | Gren name            |
|----------------------|----------------------|----------------------|
| Expect               | equalLists           | equalArrays          |
| Fuzz                 | list                 | array                |
| Fuzz                 | listOfLength         | arrayOfLength        |
| Fuzz                 | listOfLengthBetween  | arrayOfLengthBetween |
| Fuzz                 | shuffledList         | shuffledArray        |
| Test.Runner.Failure  | ListDiff             | ArrayDiff            |
| Test.Runner.Failure  | EmptyList            | EmptyArray           |

## Signature Changes Needing Compat Wrappers

These functions have the same name but different signatures:

| Module | Function         | Elm Signature                                  | Gren Signature                                                 |
|--------|------------------|-------------------------------------------------|-----------------------------------------------------------------|
| Test   | test             | String -> (() -> Expectation) -> Test           | String -> ({} -> Expectation) -> Test                          |
| Test   | reportDistribution | List ( String, a -> Bool ) -> Distribution a | Array { label : String, fn : a -> Bool } -> Distribution a    |
| Test   | expectDistribution | List ( ExpectedDistribution, String, a -> Bool ) -> Distribution a | Array { expectedDistribution, label, fn } -> Distribution a |
| Fuzz   | frequency        | List ( Float, Fuzzer a ) -> Fuzzer a            | Array { weight : Float, fuzzer : Fuzzer a } -> Fuzzer a       |
| Fuzz   | frequencyValues  | List ( Float, a ) -> Fuzzer a                   | Array { weight : Float, value : a } -> Fuzzer a               |
| Fuzz   | pair             | Fuzzer a -> Fuzzer b -> Fuzzer ( a, b )          | Fuzzer a -> Fuzzer b -> Fuzzer { first : a, second : b }      |
| Fuzz   | triple           | Fuzzer a -> b -> c -> Fuzzer ( a, b, c )         | Fuzzer a -> b -> c -> Fuzzer { first, second, third }          |
| Fuzz   | lazy             | (() -> Fuzzer a) -> Fuzzer a                     | ({} -> Fuzzer a) -> Fuzzer a                                   |
| Fuzz   | unit             | Fuzzer ()                                        | Fuzzer {}                                                      |
| Fuzz   | labelExamples    | Int -> List (String, a -> Bool) -> Fuzzer a -> List (List String, Maybe a) | Int -> Array { label, predicate } -> Fuzzer a -> Array { labels : Array String, value : Maybe a } |
| Expect | AbsoluteOrRelative | Float -> Float -> FloatingPointTolerance     | { absolute : Float, relative : Float } -> FloatingPointTolerance |

## Removed in Gren

| Module | Elm function | Notes                      |
|--------|-------------|----------------------------|
| Fuzz   | filterMap   | Use Fuzz.filter instead    |

## What the Core Transpiler Already Handles

These changes are handled by the existing AST transforms (not test-framework-specific):
- List -> Array type transformation (in describe, concat, all, oneOf, sequence, etc.)
- () -> {} unit type transformation (in test thunks)
- Tuple -> record structural changes (in frequency, pair, triple, etc.)
  NOTE: Tuple->record changes for test framework API calls are NOT yet handled.
  The core transpiler handles Elm `( a, b )` tuple LITERALS via `ElmToGren.Compat.Tuple`,
  but function signatures that change from accepting tuples to accepting records need
  per-call-site compat wrappers.

## Kernel Dependencies

gren-lang/test depends on:
- gren-lang/core (7.x) - for Array, Random, String, etc.
- No browser/node platform deps (platform: common)
- Internal kernel JS (test runner internals, not user-facing)

The test framework does NOT use kernel/native modules that would block porting.
All user-facing APIs are pure Gren.

## elm-community/list-extra Test Portability Analysis

### Test File: tests/Tests.elm (~1140 lines, ~135 test cases)

### Test Framework APIs Used

```
Test:      describe, test, fuzz, fuzz2, fuzz3, Test (type)
Expect:    equal, equalLists, all, pass, onFail
Fuzz:      int, intRange, list
```

### Mapping Status for Used APIs

| API Used         | Mapping Status | Notes                                |
|------------------|----------------|--------------------------------------|
| Test.describe    | same name      | List -> Array handled by core        |
| Test.test        | same name      | () -> {} handled by core             |
| Test.fuzz        | same name      | no signature change                  |
| Test.fuzz2       | same name      | no signature change                  |
| Test.fuzz3       | same name      | no signature change                  |
| Test (type)      | same name      | mapped in builtin.json               |
| Expect.equal     | same name      | no change                            |
| Expect.equalLists| RENAME         | -> equalArrays (mapped in builtin.json) |
| Expect.all       | same name      | List -> Array handled by core        |
| Expect.pass      | same name      | no change                            |
| Expect.onFail    | same name      | no change                            |
| Fuzz.int         | same name      | no change                            |
| Fuzz.intRange    | same name      | no change                            |
| Fuzz.list        | RENAME         | -> array (mapped in builtin.json)    |

### Portability Verdict

**HIGHLY PORTABLE**: 12/14 APIs used have the same name. Only 2 need renames
(equalLists -> equalArrays, list -> array), both now mapped in builtin.json.

### Remaining Porting Blockers (not test framework related)

The list-extra tests use these Elm features that need Gren equivalents:
1. **Tuple literals** in expected values: ~30 tests use `( a, b )` tuples for expected results (group, select, splitAt, mapAccuml, mapAccumr, frequencies, etc.). The core transpiler handles these via `ElmToGren.Compat.Tuple`.
2. **Tuple.first/Tuple.pair**: imported and used. Mapped via `ElmToGren.Compat.Tuple`.
3. **List.Extra.Continue/Stop**: Custom types from the library itself, not test framework.
4. **Char literals**: `'a'`, `'b'`, etc. - should be handled by core transpiler.

## Recipe for Porting a Package's Tests

### Step 1: Identify test framework usage

```bash
grep -oE '(Test|Expect|Fuzz)\.[a-zA-Z0-9]+' tests/*.elm | sort -u
```

### Step 2: Check against the mapping table

Cross-reference with the value renames table above. If all used APIs are either:
- Same name (no mapping needed), or
- Listed in the renames table in builtin.json

Then the tests are portable at the API level.

### Step 3: Check for structural blockers

Look for usage of:
- `Fuzz.frequency` / `Fuzz.frequencyValues` (tuple -> record args, needs compat)
- `Fuzz.pair` / `Fuzz.triple` (return type changes, needs compat)
- `Fuzz.filterMap` (removed in Gren)
- `Test.reportDistribution` / `Test.expectDistribution` (tuple -> record args)
- `Expect.AbsoluteOrRelative` with positional args (becomes record)

If none of those are used, the test is fully portable with just the builtin.json renames.

### Step 4: Port the test

The transpiler currently only ports `src/` (library source). To port tests:

1. Port the library: `node bin/elm-to-gren.cjs <package>`
2. Manually copy tests/ into the gren-output workspace
3. Run the transpiler's AST transforms on the test file (currently not automated)
4. Add gren-lang/test as a test-dependency in the output gren.json
5. Run `gren make` on the test entry point

### Step 5: Handle residual issues

Common issues:
- Tuple expected values need record conversion
- `List.head` / `List.tail` references need `Array.first` / compat wrappers
- Import paths may need adjustment (List.Extra -> Array.Extra or similar)

## Status

This mapping is added to `mappings/builtin.json` (the value renames) and documented
in `mappings/test-framework.json` (full mapping with notes on signature changes).

The elm-community/list-extra test suite is ~95% portable at the API level.
The remaining 5% is tuple-to-record conversion in test expected values,
which is handled by the core transpiler's tuple compat layer.
