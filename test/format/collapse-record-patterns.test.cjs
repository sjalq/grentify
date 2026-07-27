#!/usr/bin/env node
/**
 * Unit tests for tools/gren-format/collapse-record-patterns.cjs
 * Fast (<50ms). Keeps format post-pass laws under regression.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  transform,
  parenRecordFnArgs,
  separateGluedExprAndRecordBind,
  separateDocComments,
  collapse,
  joinCtorPayloads,
  joinSplitDefinitionHeaders,
  joinTypeHeaders,
} = require("../../tools/gren-format/collapse-record-patterns.cjs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (e) {
    failed += 1;
    console.error("  FAIL " + name);
    console.error("    " + (e && e.message ? e.message : e));
  }
}

// --- iso8601 class: last call arg must not join next let record binding ---
check("parenRecordFnArgs leaves deeper-indented value alone", () => {
  const src = [
    "                    else",
    "                        daysToYears Before 1969",
    "                            totalDays",
    "",
    "                    { first = months, second = daysInMonth } =",
    "                        daysToMonths years 1 remainingDays",
    "",
  ].join("\n");
  const out = parenRecordFnArgs(src);
  assert.ok(
    !out.includes("totalDays ({"),
    "must not glue value arg to next let bind:\n" + out,
  );
  assert.ok(out.includes("totalDays\n"), out);
  assert.ok(out.includes("{ first = months, second = daysInMonth } ="), out);
});

check("parenRecordFnArgs still joins same-indent local fn head", () => {
  const src = [
    "    helper",
    "",
    "    { first = a, second = b } =",
    "        a + b",
    "",
  ].join("\n");
  const out = parenRecordFnArgs(src);
  assert.ok(
    out.includes("helper ({ first = a, second = b }) ="),
    "same-indent fn head should parenthesize record arg:\n" + out,
  );
});

check("parenRecordFnArgs joins local f under let even if record outdented", () => {
  const src = [
    "        xs ->",
    "            let",
    "                f",
    "",
    "            { first = y, second = ys } =",
    "                    Array.map (Array.pushFirst y) (permutations ys)",
    "            in",
    "            Array.mapAndFlatten f (select xs)",
    "",
  ].join("\n");
  const out = parenRecordFnArgs(src);
  assert.ok(
    out.includes("f ({ first = y, second = ys }) =") ||
      out.includes("f ({ first = y, second = ys })="),
    "local f under let must join record arg:\n" + out,
  );
});

check("full transform keeps local f under let joined", () => {
  const src = [
    "        xs ->",
    "            let",
    "                f",
    "",
    "            { first = y, second = ys } =",
    "                    Array.map (Array.pushFirst y) (permutations ys)",
    "            in",
    "            Array.mapAndFlatten f (select xs)",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(
    out.includes("f ({ first = y, second = ys }) ="),
    "separateGlued must not undo let-local join:\n" + out,
  );
  assert.ok(!/^\s+f\s*$/m.test(out.split("let")[1] || ""), out);
});

check("parenRecordFnArgs never treats let as a function name", () => {
  const src = [
    "    else",
    "        let",
    "",
    "            { first = part1, second = tail1 } =",
    "                splitAt index1 l",
    "",
    "            { first = head2, second = tail2 } =",
    "                splitAt (index2 - index1) tail1",
    "        in",
    "        l",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(!out.includes("let ("), "must not glue let to record:\n" + out);
  assert.ok(
    /let\n\s+\{ first = part1/.test(out) ||
      /let\n\n\s+\{ first = part1/.test(out),
    "let body binding must stay under let:\n" + out,
  );
  const letLine = out.split("\n").findIndex((l) => l.trim() === "let");
  const partLine = out
    .split("\n")
    .findIndex((l) => l.includes("{ first = part1"));
  assert.ok(letLine >= 0 && partLine > letLine, out);
  const letIndent = (out.split("\n")[letLine].match(/^[ \t]*/) || [""])[0]
    .length;
  const partIndent = (out.split("\n")[partLine].match(/^[ \t]*/) || [""])[0]
    .length;
  assert.ok(
    partIndent > letIndent,
    "part1 must be indented under let (" +
      partIndent +
      " vs " +
      letIndent +
      "):\n" +
      out,
  );
});

check("parenRecordFnArgs joins after type annotation multi-arg", () => {
  const src = [
    "maxBy : (a -> comparable) -> List a -> Maybe { first : a, second : comparable }",
    "maxBy x",
    "",
    "{ first = y, second = fy } =",
    "    Just y",
    "",
  ].join("\n");
  const out = parenRecordFnArgs(src);
  assert.ok(
    out.includes("maxBy x ({ first = y, second = fy }) ="),
    out,
  );
});

check("separateGluedExprAndRecordBind splits mid-expression glue", () => {
  const src = [
    "                        daysToYears Before 1969",
    "                            totalDays { first = months, second = daysInMonth } =",
    "                    daysToMonths years 1 remainingDays",
    "",
  ].join("\n");
  const out = separateGluedExprAndRecordBind(src);
  assert.ok(!/totalDays \{ first/.test(out), out);
  assert.ok(out.includes("totalDays\n") || out.includes("totalDays\r\n"), out);
  assert.ok(out.includes("{ first = months, second = daysInMonth } ="), out);
});

check("separateGluedExprAndRecordBind splits parenthesized false join", () => {
  const src = [
    "                        daysToYears Before 1969",
    "                            totalDays ({ first = months, second = daysInMonth }) =",
    "                    daysToMonths years 1 remainingDays",
    "",
  ].join("\n");
  const out = separateGluedExprAndRecordBind(src);
  assert.ok(!/totalDays \(/.test(out), out);
  assert.ok(out.includes("{ first = months, second = daysInMonth } ="), out);
});

check("full transform: iso8601 fromTime shape stays valid", () => {
  const src = [
    "        ISO8601.Extras.Before ->",
    "            let",
    "                rem =",
    "                    ms |> (Math.modBy iday)",
    "",
    "                totalDays =",
    "                    ms // iday",
    "",
    "                { first = years, second = remainingDays } =",
    "                    if rem == 0 then",
    "                        ISO8601.Extras.daysToYears ISO8601.Extras.Before 1969",
    "                            (totalDays + 1)",
    "",
    "                    else",
    "                        ISO8601.Extras.daysToYears ISO8601.Extras.Before 1969",
    "                            totalDays",
    "",
    "                    { first = months, second = daysInMonth } =",
    "                    ISO8601.Extras.daysToMonths years 1 remainingDays",
    "            in",
    "            defaultTime",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(
    !out.includes("totalDays ({"),
    "UNEXPECTED EQUALS class:\n" + out,
  );
  assert.ok(
    !/totalDays \{ first = months/.test(out),
    "unglued form still glued:\n" + out,
  );
  // months binding remains a sibling let decl
  assert.ok(
    /\{ first = months, second = daysInMonth \} =/.test(out),
    out,
  );
});

check("joinCtorPayloads still skips case-arm record patterns", () => {
  const src = "Loading\n    { first = _, second = Loading } ->\n        x\n";
  const out = joinCtorPayloads(src);
  assert.ok(out.includes("Loading\n"), out);
  assert.ok(!out.includes("Loading { first"), out);
});

check("joinCtorPayloads does not match camelCase suffix Days", () => {
  const src = [
    "            else",
    "                daysToYears totalDays",
    "",
    "        { first = months, second = daysInMonth } =",
    "            daysToMonths years remainingDays",
    "",
  ].join("\n");
  const out = joinCtorPayloads(src);
  assert.ok(
    !out.includes("totalDays { first"),
    "must not treat Days in totalDays as a ctor:\n" + out,
  );
  assert.ok(out.includes("{ first = months, second = daysInMonth } ="), out);
});

check("joinCtorPayloads still joins real Ctor newline payload", () => {
  const src = "Node\n{ first = a, second = b }\n";
  const out = joinCtorPayloads(src);
  assert.equal(out.trim(), "Node { first = a, second = b }");
});

check("full transform: let+if+sibling record bind stays sibling", () => {
  const src = [
    "fromTime ms =",
    "    let",
    "        rem =",
    "            ms",
    "",
    "        totalDays =",
    "            ms",
    "",
    "        { first = years, second = remainingDays } =",
    "            if rem == 0 then",
    "                daysToYears (totalDays + 1)",
    "",
    "            else",
    "                daysToYears totalDays",
    "",
    "        { first = months, second = daysInMonth } =",
    "            daysToMonths years remainingDays",
    "",
    "        seconds =",
    "            rem",
    "    in",
    "    years + months + seconds",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(
    !out.includes("totalDays { first"),
    "joinCtorPayloads camelCase bug:\n" + out,
  );
  assert.ok(
    !out.includes("totalDays ({"),
    "paren false join:\n" + out,
  );
  // months binding must remain a sibling of years (same indent class)
  const yearsLine = out
    .split("\n")
    .find((l) => l.includes("{ first = years, second = remainingDays }"));
  const monthsLine = out
    .split("\n")
    .find((l) => l.includes("{ first = months, second = daysInMonth }"));
  assert.ok(yearsLine && monthsLine, "missing binds:\n" + out);
  const yi = (yearsLine.match(/^[ \t]*/) || [""])[0].length;
  const mi = (monthsLine.match(/^[ \t]*/) || [""])[0].length;
  assert.equal(
    yi,
    mi,
    "months indent " + mi + " != years indent " + yi + ":\n" + out,
  );
});

check("collapse keeps nested simple records one line", () => {
  const src = "f { first =\n  a\n, second =\n  { first = b, second = c }\n} =\n  a\n";
  const out = collapse(src);
  assert.ok(
    out.includes("{ first = a, second = { first = b, second = c } }") ||
      out.includes("{ first = a, second = { first = b, second = c }}"),
    out,
  );
});

// --- D67: a definition header must occupy one physical line ------------------
// gren-format wraps an over-wide let-destructure header at the binding's own
// column; Gren reads that column as a new declaration. Three faces, one wrap.

check("D67 rejoins a header split before its = (UNFINISHED DEFINITION)", () => {
  // dillonkearns/elm-form, ianmackenzie/elm-units-interval
  const src = [
    "    let",
    "        (Interval { first = Quantity.Quantity a, second = Quantity.Quantity b })",
    "        =",
    "            getInterval first",
    "    in",
    "    aggregateOfHelp a b",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(
    out.includes(
      "        (Interval { first = Quantity.Quantity a, second = Quantity.Quantity b }) =",
    ),
    "header must be one line:\n" + out,
  );
  assert.ok(!/^\s*=\s*$/m.test(out), "orphan = line survived:\n" + out);
});

check("D67 rejoins a header split inside its parens (UNFINISHED PARENTHESES)", () => {
  // folkertdev/elm-sha2
  const src = [
    "    let",
    "        (DeltaState",
    "        (Tuple8 { first = a, second = b, third = c, fourth = d })) =",
    "            reduceWordsHelp 0 initialDeltaState",
    "    in",
    "    State a",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(
    out.includes(
      "        (DeltaState (Tuple8 { first = a, second = b, third = c, fourth = d })) =",
    ),
    "parenthesized header must be one line:\n" + out,
  );
});

check("D67 leaves a well-formed single-line header alone (idempotent)", () => {
  const src = [
    "    let",
    "        (Interval { first = a, second = b }) =",
    "            getInterval first",
    "    in",
    "    a + b",
    "",
  ].join("\n");
  assert.equal(transform(src), transform(transform(src)));
  assert.ok(transform(src).includes("(Interval { first = a, second = b }) ="));
});

check("D67 never absorbs a top-level annotation into the definition below", () => {
  const src = [
    "aggregateOf :",
    "    (a -> Interval number units)",
    "    -> a",
    "    -> Interval number units",
    "aggregateOf getInterval first =",
    "    first",
    "",
  ].join("\n");
  const out = joinSplitDefinitionHeaders(src);
  assert.equal(out, src, "annotation must stay untouched:\n" + out);
});

check("D67 never absorbs a let-local annotation into its definition", () => {
  const src = [
    "    let",
    "        localHelper :",
    "            (Int -> Int)",
    "            -> Int",
    "        localHelper f =",
    "            f 1",
    "    in",
    "    localHelper identity",
    "",
  ].join("\n");
  const out = joinSplitDefinitionHeaders(src);
  assert.equal(out, src, "let-local annotation must stay untouched:\n" + out);
});

check("D67 leaves multi-line record type alias bodies alone", () => {
  const src = [
    "type alias Options =",
    "    { parseValue : String",
    "    , possibleValues : Array String",
    "    }",
    "",
    "",
    "defaults =",
    "    empty",
    "",
  ].join("\n");
  const out = joinSplitDefinitionHeaders(src);
  assert.equal(out, src, "record alias body must stay untouched:\n" + out);
});

check("D67 leaves a multi-line parenthesized expression alone", () => {
  const src = [
    "    State",
    "        (ctor_Tuple8_elmToGren (h0 + a) (h1 + b)",
    "            (h2 + c) (h3 + d))",
    "",
  ].join("\n");
  const out = joinSplitDefinitionHeaders(src);
  assert.equal(out, src, "expression must stay untouched:\n" + out);
});

// --- D82: string-aware doc separation + no expression-let header join --------

check("D82 separateDocComments leaves multiComment string delimiter intact", () => {
  // the-sett/elm-syntax-dsl Elm.DSLParser
  const src =
    '        |= ((Parser.multiComment "{-| " "-}" Parser.Nestable)\n';
  const out = separateDocComments(src);
  assert.equal(out, src, "string literal must not be split:\n" + out);
  assert.ok(!out.includes('"\n\n{-|'), out);
});

check("D82 separateDocComments leaves Pretty.string doc opener intact", () => {
  // the-sett/elm-syntax-dsl Elm.Pretty
  const src =
    '    (((Pretty.string "{-| ") |> (Pretty.a doc)) |> (Pretty.a Pretty.line))\n';
  const out = separateDocComments(src);
  assert.equal(out, src, "Pretty.string body must stay one literal:\n" + out);
});

check("D82 separateDocComments still unglues a real glued doc comment", () => {
  const src = "type alias Foo = Int{-| Bar docs\n-}\n";
  const out = separateDocComments(src);
  assert.ok(
    out.includes("Int\n\n{-| Bar docs"),
    "glued doc must gain a blank line:\n" + out,
  );
});

check("D82 separateDocComments is idempotent on string and real docs", () => {
  const src = [
    'parser = Parser.multiComment "{-| " "-}" Parser.Nestable',
    "type alias Foo = Int{-| docs",
    "-}",
    "",
  ].join("\n");
  const once = separateDocComments(src);
  const twice = separateDocComments(once);
  assert.equal(twice, once, "second apply must be a fixed point:\n" + twice);
  assert.ok(once.includes('Parser.multiComment "{-| "'), once);
  assert.ok(once.includes("Int\n\n{-| docs"), once);
});

check("D82 joinSplitDefinitionHeaders leaves expression-level let peel alone", () => {
  // hrldcpr/elm-cons scanlList — Print/format layout before collapse
  const src = [
    "scanlList f x l =",
    "    (cons x) <|",
    "        let",
    "            pm_3400109_0 =",
    "                l",
    "        in",
    "        when Array.popFirst pm_3400109_0 is",
    "            Nothing ->",
    "                []",
    "",
  ].join("\n");
  const out = transform(src);
  assert.ok(
    !out.includes("(cons x) <| let pm_"),
    "must not glue let onto <| line:\n" + out,
  );
  assert.ok(/\(cons x\) <\|\n\s+let\n/.test(out), "let must stay nested:\n" + out);
  assert.ok(
    /pm_3400109_0 =\n\s+l/.test(out),
    "binding body must remain:\n" + out,
  );
});

check("D82 joinSplitDefinitionHeaders still joins same-indent multi-Cons header", () => {
  const src = [
    "    map3 f",
    "        (Cons { first = x, second = xs }) (Cons { first = y, second = ys })",
    "        (Cons { first = z, second = zs }) =",
    "            f x y z",
    "",
  ].join("\n");
  const out = joinSplitDefinitionHeaders(src);
  assert.ok(
    out.includes(
      "(Cons { first = x, second = xs }) (Cons { first = y, second = ys }) (Cons { first = z, second = zs }) =",
    ),
    "same-indent header pieces must still join:\n" + out,
  );
});

check("D86 joinSplitDefinitionHeaders closes a bracket left open by a deeper wrap", () => {
  // jonathanfishbein1/linear-algebra Matrix.nullSpace: gren-format wraps the
  // nested destructuring pattern onto three lines, the last one deeper than
  // the binding column. Stopping there left `(Field.Field …` unclosed.
  const src = [
    "    let",
    "        (Field.Field",
    "        (CommutativeDivisionRing.CommutativeDivisionRing",
    "            commutativeDivisionRing)) =",
    "            innerProductSpace.vectorSpace.field",
    "",
  ].join("\n");
  const out = joinSplitDefinitionHeaders(src);
  assert.ok(
    out.includes(
      "        (Field.Field (CommutativeDivisionRing.CommutativeDivisionRing commutativeDivisionRing)) =",
    ),
    "pattern must rejoin onto one balanced line:\n" + out,
  );
  assert.ok(
    out.includes("            innerProductSpace.vectorSpace.field"),
    "binding body must survive:\n" + out,
  );
});

check("D86 joinSplitDefinitionHeaders leaves a deeper body line alone", () => {
  // The relaxation is scoped to unbalanced headers: once the brackets close,
  // a deeper next line is the body and must not be swallowed.
  const src = ["    (Matrix rows) =", "        Array.length rows", ""].join("\n");
  assert.strictEqual(joinSplitDefinitionHeaders(src), src);
});

check("D86 joinTypeHeaders rejoins a type alias whose `=` was parked alone", () => {
  // linsyking/messenger-core Messenger.GeneralModel: every type variable fits,
  // only the `=` wraps, so TYPE_VAR_LINE matched nothing and the header stayed
  // broken into two top-level declarations.
  const src = [
    "type alias UnrolledAbstractGeneralModel envro env event tar msg ren bdata sommsg",
    "=",
    "    { baseData : bdata",
    "    }",
    "",
  ].join("\n");
  const out = joinTypeHeaders(src);
  assert.ok(
    out.startsWith(
      "type alias UnrolledAbstractGeneralModel envro env event tar msg ren bdata sommsg =\n",
    ),
    "`=` must rejoin the header line:\n" + out,
  );
  assert.ok(out.includes("    { baseData : bdata"), "body must survive:\n" + out);
});

// --- W6.5: transform is a fixed point (format-post-pass idempotence) ---------

check("W6.5 transform is idempotent on D82 specimens", () => {
  const specimens = [
    '        |= ((Parser.multiComment "{-| " "-}" Parser.Nestable)\n',
    '    (((Pretty.string "{-| ") |> (Pretty.a doc)) |> (Pretty.a Pretty.line))\n',
    [
      "scanlList f x l =",
      "    (cons x) <|",
      "        let",
      "            pm_3400109_0 =",
      "                l",
      "        in",
      "        when Array.popFirst pm_3400109_0 is",
      "            Nothing ->",
      "                []",
      "",
    ].join("\n"),
    [
      "    let",
      "        (Interval { first = Quantity.Quantity a, second = Quantity.Quantity b })",
      "        =",
      "            getInterval first",
      "    in",
      "    a",
      "",
    ].join("\n"),
    [
      "    let",
      "        (DeltaState",
      "        (Tuple8 { first = a, second = b, third = c, fourth = d })) =",
      "            reduce",
      "    in",
      "    State a",
      "",
    ].join("\n"),
    "type alias Foo = Int{-| docs\n-}\n\nf x =\n    { first =\n  a\n, second =\n  b\n}\n",
  ];
  for (const src of specimens) {
    const once = transform(src);
    const twice = transform(once);
    assert.equal(
      twice,
      once,
      "transform must be a fixed point:\n--- once ---\n" +
        once +
        "\n--- twice ---\n" +
        twice,
    );
  }
});

if (failed > 0) {
  console.error("\n" + failed + " collapse-record-patterns test(s) failed");
  process.exit(1);
}
console.log("collapse-record-patterns: all checks passed");
