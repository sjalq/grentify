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
  collapse,
  joinCtorPayloads,
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

if (failed > 0) {
  console.error("\n" + failed + " collapse-record-patterns test(s) failed");
  process.exit(1);
}
console.log("collapse-record-patterns: all checks passed");
