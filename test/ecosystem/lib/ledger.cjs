/**
 * Ledger law (ledger law — ground-truth artifact + reconciliation).
 *
 * The ledger is the durable record of every ecosystem package we have WALKED
 * (attempted to port) together with its terminal state. Packages not yet walked
 * simply have no entry — the ledger never invents coverage.
 *
 * This module is PURE: no filesystem or git access happens inside the exported
 * predicates. Git is injected as a resolver object so the unit tests need no
 * real repository. `makeGitResolver` is a thin convenience factory the scripts
 * use; the pure functions never call it.
 *
 * Laws enforced here:
 *  - State-key law: every entry.state MUST be one of the seven canonical states
 *    (see STATES / STATE_KEY). working-failure additionally REQUIRES reason +
 *    evidence.
 *  - STALE law (ledger law): an entry is STALE when its stamped commit
 *    strictly predates the last commit that touched src/. Formally,
 *      stale iff isAncestor(entry.commit, lastSrcChangeCommit)
 *               AND entry.commit != lastSrcChangeCommit
 *    A commit is its own ancestor, so the inequality excludes the up-to-date
 *    case (entry stamped on the very commit that last changed src/).
 *  - Reconciliation law: every suite FAILURE must map to a ledger entry in
 *    state "working-failure" carrying non-empty evidence. A green gate requires
 *    zero unreconciled failures.
 */
"use strict";

const { spawnSync } = require("node:child_process");

/** The seven canonical terminal states. Exact string encodings — do not alias. */
const STATES = Object.freeze([
  "PASS",
  "PASS-compile-only",
  "EXEMPT-kernel",
  "EXEMPT-glsl",
  "EXEMPT-broken-upstream",
  "EXEMPT-mapping-absent",
  "working-failure",
]);

/** Human-readable meaning of each state. Mirrored into ledger.json.stateKey. */
const STATE_KEY = Object.freeze({
  PASS: "Ported AND behaviorally verified: observed runtime behavior matches Elm.",
  "PASS-compile-only":
    "Ported; gren compiles and `gren docs` verifies. Runtime behavior not asserted.",
  "EXEMPT-kernel":
    "Out of scope: depends on Elm Kernel / effect-module native code.",
  "EXEMPT-glsl":
    "Out of scope: uses WebGL/GLSL shaders the target does not support.",
  "EXEMPT-broken-upstream":
    "Out of scope: the upstream Elm package is itself broken / unbuildable.",
  "EXEMPT-mapping-absent":
    "Out of scope: a mapped package's Gren analogue does not provide a module the source imports (MAPPING_MODULE_ABSENT).",
  "working-failure":
    "Reproduced, evidenced failure to port on the stamped commit (reason + evidence required).",
});

const PASS_STATES = Object.freeze(["PASS", "PASS-compile-only"]);
const EXEMPT_STATES = Object.freeze([
  "EXEMPT-kernel",
  "EXEMPT-glsl",
  "EXEMPT-broken-upstream",
  "EXEMPT-mapping-absent",
]);

function isValidState(state) {
  return STATES.includes(state);
}

/**
 * Validate one entry. Returns an array of error strings (empty = valid).
 */
function validateEntry(entry) {
  const errs = [];
  if (!entry || typeof entry !== "object") {
    return ["entry is not an object"];
  }
  const id = entry.name || "?";
  if (typeof entry.name !== "string" || !entry.name) {
    errs.push("entry missing name");
  }
  if (typeof entry.version !== "string" || !entry.version) {
    errs.push(`${id}: missing version`);
  }
  if (!isValidState(entry.state)) {
    errs.push(`${id}: invalid state ${JSON.stringify(entry.state)}`);
  }
  if (typeof entry.commit !== "string" || !entry.commit) {
    errs.push(`${id}: missing commit`);
  }
  if (typeof entry.date !== "string" || !entry.date) {
    errs.push(`${id}: missing date`);
  }
  if (entry.state === "working-failure") {
    if (typeof entry.reason !== "string" || !entry.reason) {
      errs.push(`${id}: working-failure requires a reason`);
    }
    if (typeof entry.evidence !== "string" || !entry.evidence) {
      errs.push(`${id}: working-failure requires evidence`);
    }
  }
  return errs;
}

/**
 * Validate an entire ledger object. Returns an array of error strings.
 */
function validateLedger(ledger) {
  if (!ledger || typeof ledger !== "object") {
    return ["ledger is not an object"];
  }
  if (!Array.isArray(ledger.entries)) {
    return ["ledger.entries is not an array"];
  }
  const errs = [];
  const seen = new Set();
  for (const entry of ledger.entries) {
    for (const m of validateEntry(entry)) errs.push(m);
    const key = `${entry && entry.name}@${entry && entry.version}`;
    if (seen.has(key)) errs.push(`duplicate entry ${key}`);
    seen.add(key);
  }
  return errs;
}

/**
 * Totals by state. Always reports all canonical states (zero-filled) so the
 * status output is stable regardless of which states are present.
 */
function summarizeTotals(ledger) {
  const byState = {};
  for (const s of STATES) byState[s] = 0;
  const entries =
    ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
  for (const e of entries) {
    if (byState[e.state] === undefined) byState[e.state] = 0;
    byState[e.state] += 1;
  }
  return { total: entries.length, byState };
}

/**
 * STALE law. `git` is a resolver: { resolve(hash) -> fullHash|null,
 * isAncestor(a, b) -> boolean }. Injected so tests need no real repo.
 */
function isStale(entry, lastSrcChangeCommit, git) {
  if (!entry || !entry.commit || !lastSrcChangeCommit) return false;
  const entryFull = git.resolve(entry.commit);
  const lastFull = git.resolve(lastSrcChangeCommit);
  // Unknown commit: cannot prove staleness, so treat as not-stale.
  if (!entryFull || !lastFull) return false;
  // Stamped on the very commit that last changed src/: up to date.
  if (entryFull === lastFull) return false;
  // Stale iff the entry commit is an ancestor of (i.e. predates) that change.
  return git.isAncestor(entryFull, lastFull);
}

function staleEntries(ledger, lastSrcChangeCommit, git) {
  const entries =
    ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
  return entries.filter((e) => isStale(e, lastSrcChangeCommit, git));
}

function countStale(ledger, lastSrcChangeCommit, git) {
  return staleEntries(ledger, lastSrcChangeCommit, git).length;
}

/**
 * Extract the "owner/pkg" name from a "owner/pkg@version" (or bare) label.
 * Elm names carry no leading @, so the version delimiter is the last @.
 */
function pkgName(label) {
  if (typeof label !== "string") return "";
  const at = label.lastIndexOf("@");
  return at > 0 ? label.slice(0, at) : label;
}

/**
 * Reconciliation law / gate predicate: every suite failure must map to a
 * ledger entry in state "working-failure" carrying non-empty evidence.
 *
 * @param {Array<string|{package:string}>} suiteFailures failure labels or
 *   {package,reason} records (package = "owner/pkg@version").
 * @param {{entries:Array}} ledger
 * @returns {{ok:boolean, unmatched:string[], withoutEvidence:string[], wrongState:string[]}}
 */
function reconcileFailures(suiteFailures, ledger) {
  const entries =
    ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const unmatched = [];
  const withoutEvidence = [];
  const wrongState = [];
  for (const f of suiteFailures || []) {
    const name = pkgName(typeof f === "string" ? f : f && f.package);
    if (!name) continue;
    const e = byName.get(name);
    if (!e) {
      unmatched.push(name);
      continue;
    }
    if (e.state !== "working-failure") wrongState.push(name);
    if (typeof e.evidence !== "string" || !e.evidence) {
      withoutEvidence.push(name);
    }
  }
  return {
    ok:
      unmatched.length === 0 &&
      withoutEvidence.length === 0 &&
      wrongState.length === 0,
    unmatched,
    withoutEvidence,
    wrongState,
  };
}

/**
 * Real git resolver over a repo root. Scripts inject this into the pure
 * predicates above; unit tests inject a fake instead.
 */
function makeGitResolver(root) {
  const cache = new Map();
  function run(args) {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : null;
  }
  return {
    resolve(hash) {
      if (!hash) return null;
      if (cache.has(hash)) return cache.get(hash);
      const full = run(["rev-parse", "--verify", "--quiet", `${hash}^{commit}`]);
      const value = full || null;
      cache.set(hash, value);
      return value;
    },
    isAncestor(a, b) {
      if (!a || !b) return false;
      const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], {
        cwd: root,
      });
      return r.status === 0;
    },
    lastSrcChangeCommit() {
      return run(["log", "-1", "--format=%H", "--", "src/"]);
    },
  };
}

module.exports = {
  STATES,
  STATE_KEY,
  PASS_STATES,
  EXEMPT_STATES,
  isValidState,
  validateEntry,
  validateLedger,
  summarizeTotals,
  isStale,
  staleEntries,
  countStale,
  pkgName,
  reconcileFailures,
  makeGitResolver,
};
