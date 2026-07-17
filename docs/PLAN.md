# PLAN: over the line

Goal-loop brief for finishing elm-to-gren. **Supersedes docs/PHASE-ECOSYSTEM-HARDENING.md**
(its ground-truth rules are absorbed here; keep that file as history only).

This document is executed by an agent in a loop. Every iteration: read §STATUS and §4,
do exactly one task, prove it at the stated tier, tick it, commit. The doc is the queue;
the proof artifacts are the truth. This plan was adversarially reviewed before adoption;
do not weaken states, gates, or properties to make progress (protocol rule 8).

---

## 1. The goal (definition of DONE)

> Port **any** published Elm package to compiler-validated and, wherever the package has
> portable tests, behavior-validated Gren, except kernel and GLSL packages.

The universe is the **committed registry snapshot** `test/ecosystem/registry-snapshot.json`
(created by W5.2 from package.elm-lang.org search.json, with fetch date and count
recorded; ~2,035 non-platform packages expected). Refreshing the snapshot is an explicit,
ledgered decision, never implicit.

Terminal states, per package in the snapshot:

| State | Meaning | Evidence required in ledger |
| --- | --- | --- |
| `PASS` | Ports; `gren` compile-verifies; package's own portable tests pass under Gren (W4.3) | commit-stamped run, `behavior: "tested"` |
| `PASS(compile-only)` | Ports and compile-verifies; package has no portable tests | commit-stamped run + recorded absence/nonportability of tests, `behavior: "compile-only"` |
| `EXEMPT(kernel)` | Contains `Elm.Kernel`/effect modules, or transitively requires an unmapped kernel package | offending module/dep chain |
| `EXEMPT(glsl)` | Contains GLSL blocks, directly or transitively | offending module/dep |
| `EXEMPT(broken-upstream)` | Original does not build with Elm 0.19.1 | recorded `elm make`/`elm docs` failure |

Both PASS states satisfy DONE. Accepted behavioral deviations (see W2.4, W7.1) must be
stamped per package in the ledger `deviations` field; a deviation never blocks PASS but
must never be invisible.

**No package is too big.** A package that fails only on time/memory budget is a working
failure, never terminal: raise the tier-4 budget (recorded in the run log) or fix the
scale bug. There is no size-based exemption.

DONE = every snapshot package is in a terminal state, on one clean commit that also
passes the M6 gate.

**Position at plan creation (2026-07-17, commit 0d0ce41 dirty):**

- Curated compile-proof: pure 201/202 (fail: elm-review), browser 246/252.
- Proof surface = 454 packages ≈ 22% of snapshot-to-be. ~1,071 packages were never
  candidates because of an illegitimate "no community deps" rule (D10); ~463 more were
  walked and skipped on failure with logs since deleted.
- Behavior verification: none anywhere. Compile-only.
- Confirmed silent-wrong-output bugs at HEAD: D1 (fix pending in working tree), D2, D3,
  D4. See §6.
- Measured warm timings: `npm test` 0.75s, `npm run build` 0.6s, canary 19.5s (-j4),
  full pure suite ~10 min (-j6), full browser ~14 min (-j6).

---

## 2. Gold guides (non-negotiable; gate every commit)

**G1 — The loop stays ultra fast.** Multi-minute verification is the exception, never
the rule. Tier 0 ≤10s, tier 1 ≤90s (both already met today; regressions in tier 0/1
wall time are bugs to fix before feature work continues). Slower tiers run only at gate
tasks or as background batches. A task is proven by the cheapest tier that can falsify it.

**G2 — Elegance, in the Elm/Gren sense.** One pipeline, one obvious path, no escape
hatches, no parallel half-implementations, no work product strewn around the repo. When
a fallback becomes unnecessary, delete it in the same milestone. Scratch work lives in
`scripts/temp/` with the `_ADHOC` banner and is deleted before every milestone gate,
**except** these named files, which are load-bearing references until the task that
consumes them lands: `prove-popular-ecosystem.cjs`, `port-next-browser.cjs`,
`retry-browser-fails.cjs` (consumed and deleted by W5.6), `gap-log.json` (consumed by
W7.2).

**G3 — Human-understandable.** Every transform module carries a header comment stating
its law (input shape → output shape → invariant preserved). No `src/` module exceeds
~800 lines; any module over the limit at a gate gets a split task (W6.1 covers all,
not just MatchCompile). Comments state constraints and laws, never narration. No dead
code. The module map (§8) stays current.

**G4 — Non-trivial property-based testing against real oracles.** The oracles:
P1 same-AST evaluator equivalence (W1); P2 Elm-semantics differential table (W2.3/W4.1);
P3 packages' own elm-test suites (W4.2–W4.4); P4 the Gren compiler (tiers 1–4);
P5 format idempotence (W6.5). Every semantic bug fixed gets a property that would have
caught it, not just a regression case.

---

## 3. Verification tiers

| Tier | What | Budget | When |
| --- | --- | --- | --- |
| 0 | `npm test` (Gren unit+property) **plus fast node unit tests** (`test/format/*.test.cjs`, future `test/ecosystem/lib/*.test.cjs`) | ≤10s total | every edit |
| 1 | `npm run ecosystem:canary` (14 pkgs) + `npm run test:rule` + `npm run test:format` | ≤90s | every commit touching transform/emit/verify/extractor |
| 2 | class residual or direct package ports (`--only` / W3.6 `--package`) | minutes | when working a specific failure/bug |
| 3 | full curated suites + `test:e2e` + `test:apps` | ~30 min | **GATE tasks only**, clean tree |
| 4 | universe walk, behavior batch | hours | tasks labeled `tier 4 batch`, background mechanic (§4.7) |

Tier-0 note: tier 0 includes sub-second node tests; "pure Gren" is not a requirement,
"sub-second and no network/CLI porting" is.

---

## 4. Loop protocol

1. Start clean: `git status` empty. (Sole exception: iteration 1, see W0.1.) Read
   §STATUS. Active milestone is stated there. Pick the **first unchecked task tagged
   with the active milestone, in document order**, skipping any task whose `Requires:`
   list has unchecked entries.
2. If the task is too big for one iteration, split it into subtasks in this doc; that
   split is the iteration.
3. Do the work. Prove at the task's stated `Prove:` tier. Doc-only tasks prove by
   "tier 0 + doc diff".
4. Tick the checkbox. Update §STATUS: replace the Active-milestone/Next-task block;
   append dated measurement lines when a task produces numbers. Append to §CHANGELOG:
   `- <date> Wx.y: <one line>` (no commit hash; the `Wx.y:` commit-message prefix is
   the cross-reference).
5. Commit: message starts `Wx.y: `. Never end an iteration with a dirty tree.
6. Blocked? Write `BLOCKED: <why, what is needed>` under the task, move on. Three
   consecutive blocked tasks → stop and report to the human.
7. Tier 3 runs only inside GATE tasks. Tier 4 runs only inside tasks labeled
   `tier 4 batch`, via the background mechanic: launch the resumable batch in the
   background, commit the launch state (script + args + start stamp), end the
   iteration; subsequent iterations of the same task harvest results from the
   committed log/ledger delta until the batch is drained.
8. Never delete or weaken a gold guide, a gate, a terminal-state rule, or a landed
   property to make progress. If a rule seems wrong, write the objection under the
   task and report to the human instead.
9. Each milestone ends with its GATE task (Mn.G). The GATE task runs the gate checks,
   stamps the ledger where applicable, flips §STATUS to the next milestone.

---

## 5. Ground truth artifacts

| Artifact | Role |
| --- | --- |
| `test/ecosystem/registry-snapshot.json` (NEW, committed, W5.2) | The universe. Ledger completeness and M5 are defined against this file only |
| `test/ecosystem/ledger.json` (NEW, committed, W5.2) | Per-package state: `{name, version, state, behavior?, reason?, evidence?, deviations?, commit, date}` |
| `.test-cache/ecosystem-proof/LAST_RUN.json` | Latest tier-3 raw result, machine-local |
| `test/ecosystem/walk-log.jsonl.gz` (single rotating file, W5.6) | Raw walk output, capped; every walk decision ALSO lands as structured evidence in the ledger |
| `test/ecosystem/packages*.json` | Candidate lists for tiers 1–3; never success counts |
| `npm run ecosystem:status` | Prints proof + ledger state (extended in W5.2) |

**Ledger reconciliation law (one-directional):** ledger entries are written only from a
clean-tree LAST_RUN (or walk/batch log) whose commit matches HEAD at write time.
`ecosystem:status` flags any entry whose stamped commit predates the last change to
`src/` as `STALE` (compare `git log -1 --format=%H -- src/`). Gates require zero STALE
entries in their scope. When ledger and a newer local run disagree, the run wins only
by being written through this law; nothing edits the ledger by hand.

---

## 6. Known defects register (2026-07-17 audit; independently verified)

Silent wrong output (compiles green, behaves wrong):

- **D1 hex literals**: `src/Ast/Print.gren` printed `PatHex`/`ExprHex` as
  `"0x" ++ decimal` (`0x61` → `"0x97"` = 151). Fix + property suite pending in working
  tree (W0.1).
- **D2 `append` argument flip**: `append` absent from `mappings/builtin.json`;
  `NameSub.mappedSymbol` (src/Ast/NameSub.gren:689-711) passes names through, but Gren
  `Array.append`/`String.append` are argument-flipped vs Elm (`append a b == b ++ a`).
- **D3 MatchCompile first-peer merge**: `tryCtorEmbeddedCase` merges only the first
  cons peer per ctor (`ctorConsListPeer` ~:2913; `isCoveredOpenListArm` ~:2703 drops
  the rest). `Ctor [] / Ctor [x] / Ctor (x::y::_)` runs the wrong body for length ≥ 2.
  Reproduced end-to-end.
- **D4 MatchCompile reachable `Debug.todo`**: `Ctor (x::xs)` backed only by a top-level
  `_` arm compiles to `Debug.todo` on `Ctor []` (`ctorEmptyFallback` ~:2981).
  Reproduced end-to-end.
- **D5 negative-index semantics**: Gren `Array.get/set/slice` accept negative indices
  (count from end); Elm returns `Nothing`/no-op. Needs property + decision (W2.4).

Wrong/incomplete verification:

- **D6 compile-only proof**: `src/Verify/Package.gren:22-62` is the whole meaning of
  "verified". Packages' `tests/` dirs skipped (test/ecosystem/lib/volume.cjs:93).
- **D7 verify short-circuit**: a compiling `Main` skips `gren docs`
  (src/Verify/Package.gren:52-61).
- **D8 volume double-standard**: volume packages skip gren-format + collapse but are
  compile-verified raw (src/Port/Volume.gren:44-58, Orchestrator.gren:674-696).
- **D9 hang-vs-scale masking**: timeouts with ≥8-min budgets auto-classified `scale`
  even for non-volume packages (volume.cjs:153-159).

Coverage and pipeline:

- **D10 candidacy rule**: `scripts/temp/prove-popular-ecosystem.cjs` `classify()` marks
  any package with ≥1 community dependency "unsupported" — 1,071 packages (52.6% of
  non-platform) excluded for a reason the goal does not permit.
- **D11 elm-review fails**: type-mismatch in its huge embedded-docs modules.
- **D12 cross-package ctor arity**: both treeview packages fail deterministically:
  "Constructor pattern `Node` has 4 arguments, but its declaration has 2".
- **D13 suite flake**: `mdgriffith/elm-ui@1.1.8` fails `exit-1` under `-j6`, ports
  clean solo.
- **D14 `add` defects**: double `Elm.` prefix for `Elm.`-native modules; writes before
  verifying (partial output on failure; Orchestrator.gren ~:1364-1422).
- **D15 dishonest markdown stub**: `elm-explorations/markdown` maps to a silent
  plain-text stub.
- **D16 no node platform**: zero node mappings; `elm/http` browser-only.
- **D17 quadratic peels**: cons peels turn O(1) uncons into O(n) `popFirst`; common
  recursion becomes O(n²).
- **D18 Reserved rename desync (suspected)**: per-module occupancy renames on
  qualified refs could desync across modules. Audit before fixing.
- **D19 remaining browser failures**: elm-protocol-buffers (exit-1),
  elm-native-modal-dialog (type-mismatch), elm-ionicons (timeout → scale policy, see
  "no package is too big").
- **D20 MatchCompile untested**: 3,872 lines, zero direct unit tests.
- **D21 destructive dist/ wipe**: BOTH `npm test` and `npm run build` `rmSync('dist')`
  before compiling (package.json), and every `ecosystem:*` script runs build first — a
  build in one terminal deletes `dist/elm-to-gren.js` under a running suite (happened
  during the audit).

---

## 7. Workstreams and tasks

Milestone tags `[Mn]` drive selection (§4.1). The constraint (Goldratt) is **trust in
output correctness at speed**: the evaluator harness (W1) and behavior oracle (W4) gate
everything else.

### W0 — Commit what is in flight

- [x] W0.1 [M1] Commit ALL pending working-tree changes in one commit: hex fix
      (`src/Ast/Print.gren`), `test/Ast/PrintTest.gren` property suite, site FOUC fix,
      package.json + package-lock.json, and this `docs/PLAN.md`. Iteration 1 is the
      sole exception to protocol step 1: the tree starts dirty with exactly these
      files. **Never stash or reset them.**
      Prove: tier 0. Message: `W0.1: hex literals print decimal; printer property suite; PLAN.md`.

### W1 — Same-AST evaluator: fast semantic properties (P1) — the constraint

Transforms rewrite `Ast.Types` values into `Ast.Types` values, so one evaluator can
execute a case expression before and after a transform and compare — pure Gren, tier 0,
no compiler in the loop.

- [ ] W1.1 [M1] `src/Ast/Eval.gren`: evaluate at minimum `ExprCase`, `ExprLet`,
      `ExprLambda`+application, literals (Int/Float/String/Char/Bool), ctor
      application, record literal/access/update, list/array literals, and the
      call-shapes MatchCompile emits (`Array.popFirst`, `Maybe` ctors, `Debug.todo`).
      The `Value` type must represent **crash** (`Debug.todo` reached) distinctly from
      any value so the D4 property is expressible. The evaluator is
      **declaration-aware**: it takes the `File`'s alias/custom-type tables and
      evaluates record-alias ctors and multi-arg ctors to their canonical post-CtorLaw
      value form on BOTH sides, so a correct transform is value-identity (this is what
      makes W1.3 sound). Include an inline smoke test per supported constructor.
      Header states this law. Prove: tier 0.
- [ ] W1.2 [M1] `test/Ast/EvalTest.gren`: seeded generators (reuse the PrintTest PRNG
      pattern) for ADT shapes, list/cons/ctor/record/literal patterns, and scrutinee
      values. Generators emit **post-CtorLaw-shaped ASTs** (single-payload ctors, no
      alias ctors) or run the real `CtorLaw ∘ RecordAlias` prefix on raw shapes, so
      inputs are production-reachable by construction. Property:
      `eval(case) == eval(matchCompile(case))`, hundreds of cases within tier-0 budget.
      **Known-failure mechanism (keeps tier 0 green at every commit):** register the
      D3/D4-reproducing fixtures in a named `knownMiscompiles` list; for registered
      fixtures the test asserts the property FAILS (proof-of-red recorded in the
      changelog line); for all others it asserts equivalence. W2.1/W2.2 flip their
      entries to direct assertions as their done-condition. Prove: tier 0.
- [ ] W1.3 [M2] Extend the property to `RecordAlias` and `CtorLaw`
      (`eval ∘ transform == eval` under the declaration-aware value normalization from
      W1.1). D20 closes when MatchCompile, CtorLaw, RecordAlias are all under the
      property. Prove: tier 0.
- [ ] M1.G [M1] **GATE M1**: Requires: W0.1, W3.1, W1.1, W1.2. Tier 0 green ≤10s and
      tier 1 green ≤90s, walls recorded in §STATUS; `knownMiscompiles` non-empty and
      failing as registered. Flip §STATUS to M2. Prove: tier 0 + tier 1.

### W2 — Fix confirmed silent-wrong-output bugs (property first, then fix)

- [ ] W2.1 [M2] D3: merge ALL cons peers in `tryCtorEmbeddedCase` with correct arm
      ordering. Done-condition: its `knownMiscompiles` entry flips to a direct green
      assertion. Prove: tier 0 + tier 1.
- [ ] W2.2 [M2] D4: `ctorEmptyFallback` consults the top-level `_`/irrefutable arm
      before emitting `Debug.todo`; reachable `Debug.todo` is never acceptable output.
      Done-condition: entry flips green. Prove: tier 0 + tier 1.
- [ ] W2.3 [M2] D2: map `append` (List/Array/String) to argument-order-preserving
      output (flipped call or `a ++ b` at the catalog layer, or Compat — pick what
      keeps emitted code readable). **Begins the P2 table**: create
      `test/MappingSemanticsTest.gren` with the append rows (W4.1 grows it).
      Prove: tier 0 + tier 1.
- [ ] W2.4 [M2] D5: write the divergence property for negative indices, then decide:
      guarded Compat shim vs documented deviation. A deviation is only acceptable with
      the ledger `deviations` stamp on every affected package once the walk runs (W5.7
      re-checks reachability across the full snapshot, not just curated). Requires:
      W3.6. Prove: tier 0 + tier 2 (direct ports of 3–5 index-arithmetic-heavy
      catalog packages — name them in the task when selected).
- [ ] W2.5 [M2] D18: audit Reserved cross-module renames with a multi-module fixture;
      fix if real, else record "audited sound, fixture: <path>" here.
      Prove: tier 0 (fixture) + tier 1.
- [ ] W5.2 [M2] Ledger + snapshot (numbered for history; lives in M2 by tag):
      commit `test/ecosystem/registry-snapshot.json` (fetched from
      package.elm-lang.org/search.json, date + count recorded in §STATUS) and
      `test/ecosystem/ledger.json` seeded from current curated results; extend
      `status.cjs` to summarize the ledger, implement the STALE flag (§5), and the
      gate reconciliation check: a suite failure is acceptable at a gate iff a
      matching ledger EXEMPT entry with evidence exists. Prove: tier 0 (status unit
      tests on fixture ledgers).
- [ ] W3.6 [M2] Fix vacuous tier-2 proofs: add `--package name@version` direct-port
      mode to `run-residual.cjs` (ports from catalog/snapshot, ignoring failure
      lists); `--only`/`--reason` matching nothing exits non-zero. Prove: tier 0
      (runner unit) + one tier-2 direct port.
- [ ] M2.G [M2] **GATE M2**: Requires: W1.3, W2.1–W2.5, W5.2, W3.6.
      `knownMiscompiles` empty; tier 3
      both curated suites re-run on clean tree, results written to the ledger through
      the §5 law. Expected: pure ≥201/202 (D11 open until M4 is acceptable **only** if
      ledgered as a working failure, not terminal). Flip §STATUS to M3.
      Prove: tier 3.

### W4 — Differential semantics (P2) and behavior oracle (P3)

- [ ] W4.1 [M3] Grow and complete the P2 table begun in W2.3: for every catalog
      mapping row with semantic-delta risk (get, set, slice, intersperse, sort*,
      String.*, Char case functions, integer division, remainderBy/modBy, …), a
      seeded-input property comparing the mapped Gren call against an Elm-semantics
      reference implementation. Completion = every delta-risk row in
      `mappings/builtin.json` carries a `"propertyRow"` tag naming its test; a tier-0
      check asserts the tags and tests correspond. Prove: tier 0.
- [ ] W4.2 [M3] P3 spike on `elm-community/list-extra`: the **primary deliverable is
      the elm-explorations/test → gren-lang/test API mapping table** (Fuzz/Expect
      surface deltas; test-framework kernel deps are MAPPED, never EXEMPTed, when used
      as test-deps). Define "portable test" = uses only the mapped surface; anything
      else is recorded as untested-portion evidence. Pass criterion: the ported
      list-extra suite RUNS under gren on node; failures are triaged into W2/W4.1
      tasks (a red suite with triaged causes is a valid spike outcome; record the
      recipe and triage here). Not a GATE; no human sign-off needed. Prove: tier 2.
- [ ] W4.3 [M3] Wire P3 into the port pipeline (`--with-tests`) and suite: behavior
      results recorded per-package in the ledger (`behavior: tested|compile-only`).
      Prove: tier 2 (one package end-to-end) + tier 0 (report/ledger units).
- [ ] W4.4 [M3] `tier 4 batch` Grow the behavior set to ≥25 curated packages (start
      with the canary 14). Results into ledger through the §5 law.
      Prove: harvest iterations show ≥25 ledger entries `behavior: "tested"`.
- [ ] M3.G [M3] **GATE M3**: Requires: W4.1–W4.4. ≥25 behavior-verified ledger
      entries; P2 table complete
      per W4.1's check; tier 1 green. Flip §STATUS to M4. Prove: tier 0 + tier 1.

### W3 + W5a — Suite integrity, then close the curated suites

- [ ] W3.1 [M1] D21: stop the destructive `dist/` wipe. (a) `npm test` compiles to
      `dist-test/`, never touching `dist/elm-to-gren.js`; (b) `npm run build` becomes
      atomic: compile to a temp path, rename over the target, no `rmSync`; (c) record
      the measured warm walls in §STATUS. (Speed is already fine — 0.75s warm test,
      0.6s warm build; this task is about destruction, not speed.) Prove: tier 0 +
      manual check: run `npm run build` while a `--package` port is in flight, port
      survives.
- [ ] W3.2 [M4] D13: deterministic suite runs — cap child concurrency by available
      memory; one recorded retry for `exit-1` (visible in proof JSON, never silent).
      Prove: tier 2 — a named 6-package concurrent set including elm-ui at `-j6`, 3×
      consecutive green.
- [ ] W3.3 [M4] D7: package verify always runs `gren docs` (drop the `make Main`
      success short-circuit or run both). Prove: tier 1.
- [ ] W3.4 [M4] D9: only volume-classified packages may classify `scale`; a non-volume
      timeout is `hang` and is a bug. Port the classifier decision table to
      `test/ecosystem/lib/volume.test.cjs` (tier-0 node test). Prove: tier 0.
- [ ] W3.5 [M4] D8: close the volume double-standard. Preferred: profile gren-format
      on the elm-review corpus and make it fast enough to never skip. Acceptable
      fallback: verify both raw and formatted artifacts for non-volume so classes
      converge, and surface the residual gap in `ecosystem:status`. Prove: tier 2 on
      the volume set.
- [ ] W5.1 [M4] D11 elm-review: fix the embedded-docs type-mismatch class.
      Prove: tier 2 (`--package jfmengels/elm-review@2.16.6`).
- [ ] W5.3 [M4] D12 treeview ctor-arity: root-cause the cross-package rewrite miss;
      fix. Prove: tier 2 on both treeviews + tier 1.
- [ ] W5.4 [M4] D19: elm-protocol-buffers and elm-native-modal-dialog — fix, or
      EXEMPT(broken-upstream) only with recorded upstream-build failure. elm-ionicons:
      apply the "no package is too big" rule — raise its budget or fix the scale
      cause; it may not be EXEMPTed. Prove: tier 2 per package.
- [ ] W5.8 [M4] D14 `add`: stage-then-commit like `port` (no partial writes); stop
      double-prefixing `Elm.`-native modules. Prove: tier 2 (`add` round-trip fixture
      into a scratch app, idempotence re-run) + tier 1.
- [ ] W5.5 [M4] **GATE M4**: Requires: W3.2–W3.5, W5.1, W5.3, W5.4, W5.8.
      Clean-tree tier 3 both suites: 202/202 and 252/252, or
      every failure matched by a ledger EXEMPT entry with evidence (the W5.2
      reconciliation check enforces this mechanically). Ledger stamped. Flip §STATUS
      to M5. Prove: tier 3.

### W5b — The universe

- [ ] W5.6 [M5] D10: replace the walker. One resumable script
      `scripts/walk-universe.cjs` (replacing the scripts/temp trio, which it deletes
      on landing): reads ONLY the committed snapshot; candidacy = "not kernel, not
      glsl, not broken-upstream", nothing else; every decision written as structured
      ledger evidence + the rotating `walk-log.jsonl.gz` (§5); logs a per-package
      count of SourceEdit-based edits (feeds W6.4). Prove: tier 0 (candidacy
      classifier unit tests on fixture manifests) + dry-run walk of the first 20
      snapshot packages.
- [ ] W7.2 [M5] D16: node platform mapping table (gren-lang/node: HttpClient,
      FileSystem, Terminal, …) consuming `scripts/temp/gap-log.json` (then delete it);
      `--platform node` canary set (≥5 packages) added to tier 1 or 2. Sequenced
      before the walk drains so the node failure class has an owner. Prove: tier 2 on
      the node canary set.
- [ ] W7.1 [M5] D15 markdown honesty: loud warning in report + ported README (and
      ledger `deviations` stamp on affected packages), or map to a real Gren markdown
      package if one exists. Silent stub is not allowed. Prove: tier 1 + tier 0
      (report assertion).
- [ ] W5.7 [M5] `tier 4 batch` Walk the full snapshot in popularity order; every
      package lands in the ledger as PASS/PASS(compile-only)/EXEMPT/working-failure.
      Then iterate: pick the **dominant failure class** (largest first), fix, re-run
      that class (tier 2/4), update ledger; repeat until zero working failures.
      Platform-mapping tasks from W7 may be pulled forward whenever they are the
      dominant class. Prove: harvest iterations show monotone ledger progress;
      completion = zero working failures against the snapshot.
- [ ] M5.G [M5] **GATE M5**: Requires: W5.6, W7.2, W7.1, W5.7.
      `ecosystem:status` shows every snapshot package terminal,
      zero STALE, zero working failures. Flip §STATUS to M6. Prove: tier 0 (status
      over committed ledger) — the evidence was produced by W5.7's batches.

### W6 + W7c — Elegance, comprehension, and the long tail

- [ ] W6.1 [M6] Split every `src/` module over ~800 lines into law-named sub-modules
      (MatchCompile 3,872 → e.g. `MatchCompile/Peel.gren`, `CtorEmbed.gren`,
      `Alpha.gren`; Print 1,251 → e.g. `Print/Decl.gren`, `Print/Expr.gren`; NameSub
      if it crossed the line). No behavior change: W1 properties + tier 1 green before
      and after. Prove: tier 0 + tier 1.
- [ ] W6.2 [M6] Module map: §8 completed, one line per `src/` module. Prove: tier 0 +
      doc diff.
- [ ] W6.3 [M6] Repo hygiene: `example-project*` consolidated under `examples/`;
      `scripts/temp/` emptied (its carve-out files were consumed by W5.6/W7.2); dead
      scripts deleted; caches/build outputs gitignored; README claims match
      `ecosystem:status` output exactly. Prove: tier 1 + doc diff.
- [ ] W6.4 [M6] Single path, two decidable steps: (a) delete the orphaned
      `Port/Transform.applyReviewAndLexical` entry point (no callers) — prove tier 0 +
      tier 1; (b) using W5.6's per-package SourceEdit-edit counts across the full
      walk: if zero everywhere, delete the SourceEdit application step
      (`Transform/Pipeline.gren` applySourceEdits ~:625) and its module; if nonzero,
      record the exact residual class here and keep it with a stated law.
      Prove: tier 0 + tier 1 (+ tier 2 on any packages in the residual class).
- [ ] W6.5 [M6] P5 + Print/format convergence: property — for each canary package,
      `gren-format` applied twice is a fixed point, and Print output formats cleanly;
      collapse-record-patterns becomes part of Print proper or is deleted (a post-hoc
      repair pass on our own output violates G2). Prove: tier 1 + tier 0 (idempotence
      test).
- [ ] W7.3 [M6] D17 quadratic peels: measure first (benchmark ported list-heavy
      recursion vs Elm on list-extra). If real-world impact confirmed, add peel-shape
      optimizations (index-walk instead of popFirst chains) under the W1 property.
      Correctness first; this is the only performance task and stays last.
      Prove: tier 0 + recorded benchmark numbers in §STATUS.
- [ ] M6.G [M6] **GATE M6**: Requires: W6.1–W6.5, W7.3. (All mechanically
      checkable, then human report): §8
      complete; no `src/` module over the line limit without a recorded justification;
      every transform module has a header law; P2 tag-check green; P5 test green;
      `scripts/temp/` empty; README numbers == `ecosystem:status` output; tier 0+1
      green; then write a final report to the human (DONE requires M5.G and M6.G on
      the same clean commit). Prove: tier 0 + tier 1 + doc diff.

---

## 8. Module map (G3; complete in W6.2)

| Module | Law / job |
| --- | --- |
| src/Ast/Types.gren | Resolved simplified AST shared by all passes |
| src/Ast/Decode.gren | elm-review extract JSON → Ast.Types |
| src/Ast/NameSub.gren | Qualified-name catalog substitution; falls back to original name |
| src/Ast/RecordAlias.gren | Record-alias ctor lowering |
| src/Ast/CtorLaw.gren | Gren ctor laws (single payload, multi-arg helpers, sole-ctor irrefutability) |
| src/Ast/MatchCompile.gren | List/cons pattern totalization → Array peels (split in W6.1) |
| src/Ast/Reserved.gren | Gren reserved-word renames, @docs token repair |
| src/Ast/Print.gren | Ast.Types → Gren source text (split in W6.1) |
| src/Ast/Eval.gren | (W1.1) Declaration-aware reference evaluator; crash ≠ value |
| src/Verify/Package.gren | Meaning of "verified": gren make/docs per package |
| src/Port/… src/Emit/… src/Acquire/… src/Resolve/… src/Transform/… | (complete in W6.2) |

---

## 9. Milestones

| # | Name | Tasks (by tag) | Gate task |
| --- | --- | --- | --- |
| M1 | Fast honest loop | W0.1, W3.1, W1.1, W1.2 | M1.G |
| M2 | Not silently wrong | W1.3, W2.1–W2.5, W5.2, W3.6 | M2.G (tier 3) |
| M3 | Behavior oracle live | W4.1–W4.4 | M3.G |
| M4 | Curated closed | W3.2–W3.5, W5.1, W5.3, W5.4, W5.8 | W5.5 (tier 3) |
| M5 | Universe walked | W5.6, W7.2, W7.1, W5.7 | M5.G |
| M6 | Elegant and true | W6.1–W6.5, W7.3 | M6.G |

DONE = M5.G and M6.G pass on the same clean commit.

---

## STATUS

- Active milestone: **M1**. Next task: **W1.1**.
- 2026-07-17: Plan created from full-project audit (§6), adversarially reviewed
  (3 lenses), revised. Measured walls: npm test warm 0.75s; build warm 0.6s; canary
  19.5s -j4; pure suite ~10 min -j6 (201/202); browser ~14 min -j6 (246/252).

## CHANGELOG

- 2026-07-17 (plan) PLAN.md created; supersedes PHASE-ECOSYSTEM-HARDENING.md.
- 2026-07-17 (plan) Revised after adversarial review: terminal states completed
  (PASS(compile-only), deviations, no-size-exemption), milestone tags + gate tasks,
  known-failure mechanism for red properties, committed registry snapshot, ledger
  reconciliation law, declaration-aware evaluator spec, stage-accurate generators,
  W3.1 recast (destruction not speed), scripts/temp carve-outs, vacuous-proof fixes.
- 2026-07-17 W0.1: hex fix + printer property suite + site FOUC fix + PLAN.md committed;
  tier 0 green (102 checks).
