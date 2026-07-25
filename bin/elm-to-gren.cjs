#!/usr/bin/env node

const { acquireForArgs } = require("./add-lock.cjs");

const lock = acquireForArgs(process.argv.slice(2), process.cwd());

if (lock.error !== null) {
  if (process.argv.includes("--json")) {
    process.stderr.write(
      `${JSON.stringify({
        code: lock.error.startsWith("ADD_LOCKED:")
          ? "ADD_LOCKED"
          : "ADD_LOCK_FAILED",
        message: lock.error.replace(/^[A-Z_]+:\s*/, ""),
        hints: [],
      })}\n`,
    );
  } else {
    process.stderr.write(`${lock.error}\n`);
  }
  process.exitCode = 1;
} else {
  if (lock.release !== null) {
    process.once("exit", lock.release);
  }
  // D50: the compiled bundle starts the program on load — `gren make` emits a
  // trailing `this.Gren.Main.init({})`. Calling init() again here launches a
  // SECOND concurrent instance of the entire pipeline against the same output
  // dir and caches. Requiring is the whole invocation.
  require("../dist/elm-to-gren.js");
}
