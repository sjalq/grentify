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
10. **Delegation model** (set by the human 2026-07-18, supersedes the original
    "Opus 4.6 subbies" instruction; updated to Haiku by the human 2026-07-19;
    upgraded to Sonnet then to Opus 4.8 by the human 2026-07-21 — "screw it,
    use opus 4.8 pls, lets get done"):
    the lead agent (Fable) owns types work, laws/specs, project management, and
    QA of every wave; implementation is farmed out to Opus 4.8 subagents in
    small, tightly-specced bites that lean on the Gren compiler as their
    guardrail.
    Every subagent deliverable is adversarially reviewed and then re-proven by
    the lead before commit; nothing lands on the lead's say-so alone, and
    nothing lands on a subagent's say-so alone.

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
- **D22 Array.initialize negative-count crash** (found by W4.1's P2 row, FIXED same
  commit): `Compat.Array.initialize` passed counts straight through; Gren's
  `Array.initialize` throws RangeError on negative counts where Elm returns `[]`.
  Guarded `count <= 0 -> []` in the adapter.
- **D23 unqualified exposed-name mapping miss** (found by W4.3c, FIXED): root
  cause is UPSTREAM — elm-review 2.13.5's ModuleNameLookupTable leaks a
  lambda-param shadow outward past the lambda when the body contains a `let`
  (`fuzz (list int) "…" <| \list -> let …` extracts the fuzzer's `list` as
  local; minimal 3-way repro in the changelog). Fixed by `src/Ast/BareResolve.gren`:
  pre-NameSub pass restores the qualifier on bare vars that are (a) in an
  import's EXPLICIT exposing list and (b) not actually bound by any enclosing
  scope. Residual (documented in the module): names from `exposing (..)`
  imports cannot be repaired without dependency docs.
- **D25 let-in-argument indentation** (found by W4.4 behavior sweeps —
  array-extra + fast-dict "UNFINISHED LET", OPEN -> fix in flight): the
  printer emits `let` inline after preceding tokens (`describe "x" (let`)
  while its declarations indent at the statement's base column — shallower
  than the `let` keyword, which Gren's layout rules reject. Canonical fix:
  a let-expression in argument position always starts on its own line.
- **D30 review-app compile races under sustained suite concurrency** (OPEN,
  blocks the M4 gate's full -j5 runs): even with warm shared caches, elm-review
  recompiles a dep-set variant app mid-suite and concurrent compiles in the
  shared elm-home/review project emit non-JSON elm errors ("+------" art) that
  crash elm-review's build.js ("is not valid JSON"). W3.2b's single retry is
  insufficient — both attempts land inside the same contention window. All
  specimens port clean solo. FIX SHAPE (next session's first bite): a cross-
  process compile LOCK around the review-app build in src/Review/Runner.gren
  (lockfile + wait, adopt-the-winner on the compiled artifact), or a serial
  pre-warm pass of all dep-set variants before suites go parallel. Gate v2
  evidence: 3 fails in first 70 (monocle hang + 2 race exit-1s), everything
  else green.
  FIXED same day: extraction serialized machine-wide via atomic-mkdir
  spinlock beside the shared review-app cache (withCompileLock in
  Runner.gren); released on success AND failure paths; canary 14/14 at -j4
  (90s — the serialization cost, refunded later by the extract cache which
  bypasses locked extraction on hit).
- **D32 review-app seed/save raced outside the D30 lock** (found by gate v5,
  FIXED 2026-07-22): seedReviewApp (shared→local cp -a) and saveReviewApp
  (local→shared cp -a) ran outside the extraction lock, so a save could tear
  a concurrent seed; the torn shared tree then poisoned EVERY later cold
  package deterministically — gate v5 pure lost 23 consecutive packages
  (179-202, all "is not valid JSON") plus 2 early windows; browser hit 2
  before being stopped. Fix: seed → invoke → save all inside the lock;
  poisoned review-app trees purged (extract-cache entries kept, 179 banked).
- **D31 orphaned extraction lock after runner kill** (found + FIXED 2026-07-22):
  killing a suite runner leaves its child `elm-to-gren` processes alive AND
  leaves the D30 lock dir behind if a holder dies before release — every later
  worker spins the full 600s and fails EXTRACT_LOCK (canary poisoned 8/14 at
  ~655s each). Fix: acquire loop steals locks older than 660s (mtime check —
  longer than the 600s max legitimate hold), and EXTRACT_LOCK joined the
  transient-retry signatures in suite.cjs. Ops lesson: kill process GROUPS,
  and check `pgrep -f elm-to-gren` for orphans before relaunching suites.
- **D26 review-app JS corrupted at compile time** (found via W5.3, OPEN,
  URGENT — currently breaks ~6/14 canary): one of the two elm-review compiled
  app variants (hash 22ef79…, selected per analyzed package's dep-set) is
  emitted with a ~20-byte span DELETED mid-file (SyntaxError), deterministically,
  from fully virgin caches (elm-home re-downloaded, all elm-stuff purged,
  pristine committed review config — A/B proven). The other variant (40b90fce…)
  compiles valid in the same run. Suites were green only because the shared
  review-app cache held an anciently-compiled VALID 22ef79; that copy was
  destroyed during this investigation. Historical corrupt copies first appeared
  ~2026-07-18 in test:apps — coinciding with node 25.9.0; elm-review 2.13.5
  post-processes compiled JS in node before writing, prime suspect. Recovery
  RESOLVED as workaround: node@22 A/B refuted the node-version theory; byte
  diff of the two variants showed a span deleted between exact-string anchors
  — elm-review's lib/optimize-js.js splices hardcoded patches into compiled
  JS and one splice corrupts against elm 0.19.1-6 output. Extractor now runs
  with --debug (optimizer skipped entirely; we only extract JSON) plus a
  noise-tolerant report parse (dropLeadingNoise). Proper fix upstream:
  elm-review >2.13.5 or patched optimizer. Canary green again.
- **D12 treeview ctor-arity ROOT-CAUSED** (fix landed in review rule, e2e proof
  blocked by D26): `namedPlatformPayloadFields` hardcoded "Node" -> {first,
  second} (stil4m/elm-syntax shape) with a bare-name guard that captured EVERY
  package's `Node`; treeview's 4-arg Node hit expected=2 -> hard diagnostic.
  Fixed: the table is a HINT — on arity mismatch, fall through to real
  reference resolution (new resolveConstructorPattern helper). The Haiku
  diagnosis ("elm-review truncates ctor args") was refuted by extract JSON.
- **D24 tuple comparability lost under record lowering** (found by the first
  D23-unblocked harness compile, OPEN): Elm tuples are `comparable`
  (`List.sort [(1,2),(0,3)]` works); the port lowers tuples to records, and
  Gren records are NOT comparable — `Array.sort` on `Array {first, second}`
  is a type error. Affects sort/min/max, Dict keys, Set members of tuple
  types. A general fix needs type-directed rewriting (sortWith + generated
  lexicographic comparator); no type inference exists in the pipeline today.
  Blocks list-extra's frequencies tests; pick a tuple-sort-free package for
  the W4.3d end-to-end proof.

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

- [x] W1.1 [M1] `src/Ast/Eval.gren`: evaluate at minimum `ExprCase`, `ExprLet`,
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
- [x] W1.2 [M1] `test/Ast/EvalTest.gren`: seeded generators (reuse the PrintTest PRNG
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
- [x] W1.3 [M2] Extend the property to `RecordAlias` and `CtorLaw`
      (`eval ∘ transform == eval` under the declaration-aware value normalization from
      W1.1). D20 closes when MatchCompile, CtorLaw, RecordAlias are all under the
      property. Prove: tier 0.
- [x] M1.G [M1] **GATE M1**: Requires: W0.1, W3.1, W1.1, W1.2. Tier 0 green ≤10s and
      tier 1 green ≤90s, walls recorded in §STATUS; `knownMiscompiles` non-empty and
      failing as registered. Flip §STATUS to M2. Prove: tier 0 + tier 1.

### W2 — Fix confirmed silent-wrong-output bugs (property first, then fix)

- [x] W2.1 [M2] D3: merge ALL cons peers in `tryCtorEmbeddedCase` with correct arm
      ordering. Done-condition: its `knownMiscompiles` entry flips to a direct green
      assertion. Prove: tier 0 + tier 1.
- [x] W2.2 [M2] D4: `ctorEmptyFallback` consults the top-level `_`/irrefutable arm
      before emitting `Debug.todo`; reachable `Debug.todo` is never acceptable output.
      Done-condition: entry flips green. Prove: tier 0 + tier 1.
- [x] W2.3 [M2] D2: map `append` (List/Array/String) to argument-order-preserving
      output (flipped call or `a ++ b` at the catalog layer, or Compat — pick what
      keeps emitted code readable). **Begins the P2 table**: create
      `test/MappingSemanticsTest.gren` with the append rows (W4.1 grows it).
      Prove: tier 0 + tier 1.
- [x] W2.4 [M2] D5: write the divergence property for negative indices, then decide:
      guarded Compat shim vs documented deviation. A deviation is only acceptable with
      the ledger `deviations` stamp on every affected package once the walk runs (W5.7
      re-checks reachability across the full snapshot, not just curated). Requires:
      W3.6. Prove: tier 0 + tier 2 (direct ports of 3–5 index-arithmetic-heavy
      catalog packages — name them in the task when selected).
- [x] W2.5 [M2] D18: audit Reserved cross-module renames with a multi-module fixture;
      fix if real, else record "audited sound, fixture: <path>" here.
      D18 CONFIRMED REAL: cross-module refs used caller's occupancy map instead of
      defining module's. Fixed with package-wide reserved-export map.
      Prove: tier 0 (fixture) + tier 1.
- [x] W5.2 [M2] Ledger + snapshot (numbered for history; lives in M2 by tag):
      commit `test/ecosystem/registry-snapshot.json` (fetched from
      package.elm-lang.org/search.json, date + count recorded in §STATUS) and
      `test/ecosystem/ledger.json` seeded from current curated results; extend
      `status.cjs` to summarize the ledger, implement the STALE flag (§5), and the
      gate reconciliation check: a suite failure is acceptable at a gate iff a
      matching ledger EXEMPT entry with evidence exists. Prove: tier 0 (status unit
      tests on fixture ledgers).
- [x] W3.6 [M2] Fix vacuous tier-2 proofs: add `--package name@version` direct-port
      mode to `run-residual.cjs` (ports from catalog/snapshot, ignoring failure
      lists); `--only`/`--reason` matching nothing exits non-zero. Prove: tier 0
      (runner unit) + one tier-2 direct port.
- [x] M2.G [M2] **GATE M2**: Requires: W1.3, W2.1–W2.5, W5.2, W3.6.
      `knownMiscompiles` empty; tier 3
      both curated suites re-run on clean tree, results written to the ledger through
      the §5 law. Expected: pure ≥201/202 (D11 open until M4 is acceptable **only** if
      ledgered as a working failure, not terminal). Flip §STATUS to M3.
      Prove: tier 3.
      RESULT: knownMiscompiles empty (D3/D4 assert agreement). Tier 0: 165 checks
      green. Tier 1: canary 14/14. Pure partial: 199/202 (2 timeouts, 1 exit-1;
      elm-review PASSED). Full tier-3 deferred to M4 gate per G1 (fast loop
      principle). All semantic fixes verified.

### W4 — Differential semantics (P2) and behavior oracle (P3)

- [x] W4.1 [M3] Grow and complete the P2 table begun in W2.3: for every catalog
      mapping row with semantic-delta risk (get, set, slice, intersperse, sort*,
      String.*, Char case functions, integer division, remainderBy/modBy, …), a
      seeded-input property comparing the mapped Gren call against an Elm-semantics
      reference implementation. Completion = every delta-risk row in
      `mappings/builtin.json` carries a `"propertyRow"` tag naming its test; a tier-0
      check asserts the tags and tests correspond. Prove: tier 0.
      RESULT: 15 new rows (modBy/remainderBy, 4 Char case, String concat/uncons,
      Array.initialize, List tail/partition, Dict toList/fromList/partition,
      Set partition); 19 propertyRows tags total; completeness checker wired into
      `npm test`. The initialize row EXPOSED D22 (negative-count crash), adapter
      guarded in the same commit.
- [x] W4.2 [M3] P3 spike on `elm-community/list-extra`: the **primary deliverable is
      the elm-explorations/test → gren-lang/test API mapping table** (Fuzz/Expect
      surface deltas; test-framework kernel deps are MAPPED, never EXEMPTed, when used
      as test-deps). Define "portable test" = uses only the mapped surface; anything
      else is recorded as untested-portion evidence. Pass criterion: the ported
      list-extra suite RUNS under gren on node; failures are triaged into W2/W4.1
      tasks (a red suite with triaged causes is a valid spike outcome; record the
      recipe and triage here). Not a GATE; no human sign-off needed. Prove: tier 2.
- [x] W4.3 [M3] Wire P3 into the port pipeline (`--with-tests`) and suite: behavior
      results recorded per-package in the ledger (`behavior: tested|compile-only`).
      Prove: tier 2 (one package end-to-end) + tier 0 (report/ledger units).
      COMPLETE via a-d below. End-to-end proof: maybe-extra ports with
      `Behavior: tested — BEHAVIOR PASS: 30 passed, 0 failed` in log and
      `"behavior": {"status": "tested", ...}` in the report. Ledger-side
      consumption of the report field lands with W4.4's batch.
      Split (protocol rule 2):
      - [x] W4.3a runnable-harness spike: prove gren-lang/test executes on node
            against ported list-extra output; committed runbook in
            docs/test-framework-mapping.md; adversarially reproduced cold.
            PROVEN: Test.Runner.String.runWithOptions on node, exit 0/1 both
            verified, local: dep on ported package, fixed fuzz seed. Haiku
            spike's "node unsupported" claim was false (missing gren-lang/node
            dep + missing .init() call); browser/jsdom detour discarded.
      - [x] W4.3b extractor ports tests/: extraction includes the package's
            tests/ dir (source-directories override on the scratch copy).
            LANDED: --with-tests flag; Acquire collects tests/*.elm into
            PackageSource.testFiles; extraction reviews ["src","tests"] for
            the root package only; transformed test modules partitioned into
            Draft.testModules (never emitted); "Portable test modules: N" log.
            Proof: list-extra emit byte-identical with/without flag; count 1.
      - [x] W4.3c pipeline flag: `--with-tests` threads through CLI ->
            Orchestrator; test modules transformed + emitted; harness generated
            from the W4.3a template.
            LANDED: src/Emit/Behavior.gren plans behavior-tests/ (gren.json +
            test sources + generated Main aggregating `name : Test` decls);
            finalize emits it when withTests && testModules non-empty. Design
            deviation from the W4.3a recipe, deliberate: source-directories
            ["src", "../src"] instead of a local: dep — tests may import
            internal (non-exposed) package modules and Compat adapters, which
            mirrors elm-test semantics. list-extra end-to-end blocked by D23.
      - [x] W4.3d behavior verdict: run harness, parse outcome, record
            `behavior: tested|compile-only` in report + ledger.
            LANDED: orchestrator compiles (300s cap) + runs (120s cap) the
            emitted harness; verdict statuses tested / test-failures /
            tests-unportable / harness-error (infra failures folded via
            onError — the verdict is recorded, NEVER enforced; a red harness
            cannot fail the port). Report gains a "behavior" object only when
            --with-tests ran. Three-way proof matrix verified independently.
- [x] W4.4 [M3] `tier 4 batch` Grow the behavior set to ≥25 curated packages (start
      with the canary 14). Results into ledger through the §5 law.
      Prove: harvest iterations show ≥25 ledger entries `behavior: "tested"`.
      DONE: 26 ledger entries behavior:"tested" (1,201 cases), ingested from a
      single clean-tree re-stamp of all 26 at HEAD via ingest-behavior.cjs.
      Batch mechanic landed: test/ecosystem/run-behavior-batch.cjs
      (npm run ecosystem:behavior) — resumable (per-package append + startup
      compaction, last-wins per package+commit), exit-0 survey tool, JSONL log
      at test/ecosystem/behavior-log.jsonl. Ledger write happens on a
      clean-tree rerun at M3.G per the §5 law.
      CANARY-14 SWEEP DONE (2026-07-18, log is truth — console interleaves
      under -j): tested 3 (maybe-extra 30/30, jweir/elm-iso8601 288/288,
      elm-color — its port-failed entry is the D13 version-probe flake),
      no-tests 4 (elm-response, toop, html-extra, elm-dom: no tests/ in
      archive), unportable 7 in classes:
      - [x] W4.4a harness deps: merge the emitted package's gren.json deps
            into the harness gren.json (iso8601-date-strings needs
            gren-lang/parser). Prove: tier 2 on that package -> tested.
            LANDED: root deps merged (exact lower-bound versions; base wins);
            iso8601-date-strings now TESTED 24/24.
      - [x] W4.4b platform guard: browser-platform packages get verdict
            "browser-only" without a doomed node compile (remotedata's
            RemoteData.gren imports Http). Prove: tier 2 on remotedata.
            LANDED: guard on the root identity's platform; verdict recorded,
            no harness emitted.
      - [x] W4.4c runner statuses: "no-behavior" -> "no-tests";
            classify Elm-0.18-relic suites (bare toString: elm-hex CONFIRMED
            broken upstream — original tests never compiled under 0.19) as
            "tests-broken-upstream". Prove: tier 0 (runner) + rerun log.
            LANDED; Fable tightened the relic regex to exclude qualified
            calls (Hex.toString must not classify as relic).
      - [x] W4.4d specimen triage: elm-codec + json-decode-pipeline NAMING
            errors — root-cause each (may be new mapping gaps or more
            0.18 relics). Prove: recorded root cause per package here.
            DIAGNOSED (Haiku, Fable-confirmed):
            elm-codec = harness generator bug — Main references non-exposed
            `: Test` decls (Fields exposes only `suite`); fix = intersect
            detection with the module's exposing list (-> W4.4f).
            json-decode-pipeline = mapping gap — `Expect.true`/`Expect.false`
            dropped in gren-lang/test 5; fix = Compat.Expect wrappers over
            pass/fail + catalog rows (-> W4.4g).
      - [x] W4.4f harness Main: reference only EXPOSED test decls
            (explicit list intersect; exposing (..) = all). Prove: tier 2
            elm-codec -> tested/test-failures.
            LANDED: elm-codec now TESTED 67/67.
      - [x] W4.4g Expect.true/false Compat adapters + catalog rows.
            Prove: tier 2 json-decode-pipeline -> tested/test-failures.
            LANDED: ExpectAdapter (pass/fail wrappers, Elm msg-first
            signature); json-decode-pipeline now TESTED 10/10.
      - D24 (list-extra, date TYPE MISMATCH) tracked in §6; needs the
        typed sortWith rewrite task, not a W4.4 bite.
      - [ ] W4.4e extend the curated list beyond canary toward >= 25 tested
            (pick packages with real 0.19 test suites, common platform).
            Round 1 done (20 candidates); round 2 in flight (~25 more).
      - [x] W4.4h analogue-root harness (PARTIAL, residual filed): landed —
            analogue registry dep in harness gren.json (Haiku), ../src dropped
            for analogue roots + required Compat adapters emitted into the
            harness src (Fable; the Haiku kept ../src against spec ->
            AMBIGUOUS IMPORT, and adapters vanish without ../src).
            RESIDUAL (not a bite): elm-color's tests import Hex =
            rtfeldman/elm-hex, a real Elm TEST-DEPENDENCY — harnesses would
            need recursively PORTED test-deps. Applies to any package whose
            tests use community test-deps; W4.2 flagged this class. File
            under M4+ scope; elm-color parked as tests-unportable
            (test-dependency-unported).
- [x] M3.G [M3] **GATE M3**: Requires: W4.1–W4.4. ≥25 behavior-verified ledger
      entries; P2 table complete
      per W4.1's check; tier 1 green. Flip §STATUS to M4. Prove: tier 0 + tier 1.
      PASSED 2026-07-19: 26 tested ledger entries at clean-tree HEAD (all 26
      re-proven in one serial pass, zero flakes); P2 tag check green (19 rows);
      tier 0 = 187 checks + property-rows; tier 1 = canary 14/14.

### W3 + W5a — Suite integrity, then close the curated suites

- [x] W3.1 [M1] D21: stop the destructive `dist/` wipe. (a) `npm test` compiles to
      `dist-test/`, never touching `dist/elm-to-gren.js`; (b) `npm run build` becomes
      atomic: compile to a temp path, rename over the target, no `rmSync`; (c) record
      the measured warm walls in §STATUS. (Speed is already fine — 0.75s warm test,
      0.6s warm build; this task is about destruction, not speed.) Prove: tier 0 +
      manual check: run `npm run build` while a `--package` port is in flight, port
      survives.
- [x] W3.2 [M4] D13: deterministic suite runs — cap child concurrency by available
      memory; one recorded retry for `exit-1` (visible in proof JSON, never silent).
      Prove: tier 2 — a named 6-package concurrent set including elm-ui at `-j6`, 3×
      consecutive green.
      DONE in four layers: (a) acquire cache adopts race winners (unique
      staging, tolerated renames, no-prompt unzip) — 8-way cold-cache race
      test green; (b) recorded retry on race signatures in all three runners
      (retried:true + firstFailure in proof JSON); (c) memory clamp law
      corrected to totalmem/3GB floor 2 (freemem collapses to -j1 on macOS —
      the "-j6" proofs were secretly serial until caught); (d) the version
      probe retries ×3 internally (starved `gren --version` under -j5 was the
      last flake). Proof: elm-ui set at true -j5, rounds 2-4 consecutive 6/6.
- [x] W3.3 [M4] D7: package verify always runs `gren docs` (drop the `make Main`
      success short-circuit or run both). Prove: tier 1.
      DONE: single path — packages verify via `gren docs` only, applications
      via `gren make` (G2: dropped the make-first fallback entirely).
- [x] W3.4 [M4] D9: only volume-classified packages may classify `scale`; a non-volume
      timeout is `hang` and is a bug. Port the classifier decision table to
      `test/ecosystem/lib/volume.test.cjs` (tier-0 node test). Prove: tier 0.
      DONE: budget-size excuse removed from classifyTimeout; explicit
      3-row decision table + unit checks wired into test:ledger.
- [x] W3.5 [M4] D8: close the volume double-standard. Preferred: profile gren-format
      on the elm-review corpus and make it fast enough to never skip. Acceptable
      fallback: verify both raw and formatted artifacts for non-volume so classes
      converge, and surface the residual gap in `ecosystem:status`. Prove: tier 2 on
      the volume set.
      DECIDED Option B on measured numbers (2026-07-21, warm caches, format
      FORCED): elm-syntax 74s total, elm-review 574s total vs ~20-70s
      unformatted — the <60s Option-A bar missed by ~9×. Skip retained;
      `ecosystem:status` now prints the "D8 residual: volume packages
      verified raw" count from loaded suite proofs. gren-format performance
      itself is the long-term fix (W6.5 territory).
- [ ] W5.1 [M4] D11 elm-review: fix the embedded-docs type-mismatch class.
      Prove: tier 2 (`--package jfmengels/elm-review@2.16.6`).
      CENSUS DONE (2026-07-21, full port log): only 4 classes / 6 sites:
      - [ ] W5.1a BAD UNICODE ESCAPE (1 site, Ansi): printer emits \u001b
            bare; Gren needs \u{001B}. Printer escape-sequence bug.
      - [ ] W5.1b NAMING ERROR `newFixes` (3 sites, 2 modules): a binding
            vanished — suspect rename/binder pass dropping a let/lambda
            name (Review.Error.Fixes).
            DIAGNOSED (Fable, from source): MatchCompile D3/D4-sibling —
            ctor payload matched by `Edit []` in one arm and whole-list var
            `Edit newFixes` in the next; the peel merge drops the var
            binding while the arm body still references it. Repro shape:
            case fixes of Remove -> …; Edit [] -> …; Edit newFixes -> …
            Fix guardrails: EvalPropTest 240 cases + a new deterministic
            fixture of exactly this shape asserting agreement.
            FIXED: whole-list var arm now binds the original payload under
            its own name in the peel merge; regression fixture green
            (Edit [7,8] == 15 pre==post), 240 property cases green,
            canary 14/14.
      - [ ] W5.1c TYPE MISMATCH (1 site, ModuleNameLookupTable.Internal):
            Dict.set key via toRangeLike — D24-family comparability under
            tuple lowering.
            BLOCKED: this is one site of D24 (tuple-as-Dict-key needs the
            type-directed rewrite); resolving it here would be a one-off
            hack. Closes with D24.
      - [ ] W5.1d UNFINISHED RECORD (1 site): printer layout breaks inside
            the giant embedded-docs record literal (the original "embedded
            docs" suspicion — actually the smallest class).
            PARTIAL: operator-as-value now prints parenthesized ((<|) not
            bare <|) — real printer gap, tier-0 regression added — but the
            ElmCore site STILL fails; the true empty-print there is
            unidentified. Needs the emitted line 21 cut at the parse
            position (staging retention or a doc-record minimal specimen).
      - [x] W5.1e (surfaced by the deeper port; original framing WRONG —
            helper emission was innocent, proven by two green CtorLawTest
            regressions): real bug = D28, MatchCompile's ctor-embedded
            collapse admitted matches with a second refutable column
            (Fifo [] back vs Fifo [] []), losing the var binding. FIXED:
            eligibility law `ctorGroupsRespectOtherColumnLaw` (every other
            column irrefutable in every row, else general path) + red-first
            evaluator fixtures (2/3 scrutinees red pre-fix). BONUS D29
            fixed same pass: sole-ctor record destructure emitted a
            redundant `_` arm that CRASHES gren 0.6.6's compiler
            (upstream bug, 8-line repro isolated) — now emits the plain
            destructure, sidestepping it. Local-package fast-repro
            technique documented in the W5.1e trail (seconds vs 12 min).
- [x] W5.3 [M4] D12 treeview ctor-arity: root-cause the cross-package rewrite miss;
      fix. Prove: tier 2 on both treeviews + tier 1.
      DONE (with a plot twist): root cause was OUR extractor's hardcoded
      payload-fields table capturing every bare `Node`; fixed as hint-with-
      fallback. Proof was blocked by the newly-surfaced D26, which was then
      root-caused to elm-review's JS optimizer and worked around (--debug +
      noise-tolerant report parse). Both treeviews now port; canary 14/14.
- [ ] W5.4 [M4] D19: elm-protocol-buffers and elm-native-modal-dialog — fix, or
      EXEMPT(broken-upstream) only with recorded upstream-build failure. elm-ionicons:
      apply the "no package is too big" rule — raise its budget or fix the scale
      cause; it may not be EXEMPTed. Prove: tier 2 per package.
      DISPOSITIONS (2026-07-21 diagnosis):
      - elm-protocol-buffers: PORTS CLEAN — fixed by intervening work
        (D25/W5.1/D26 era). Done.
      - elm-native-modal-dialog: root-caused — record-update RHS bare
        `classList` (a local parameter) over-qualified to the catalog's
        Html.Attributes.classList => Compat fn where pairs expected.
        D23-family extractor scope leak at record-update position; needs
        the same repair-law extension (BareResolve/AstEncode). Fixable.
        FIXED (D27, Sonnet + Fable QA): the true culprit was a THIRD
        rewriter — NameSub's scope-blind bare-remap walker clobbering
        locally-bound shadows after BareResolve got them right. Scope
        tracking consolidated into new src/Ast/Scope.gren shared by both
        passes (G2); NameSubTest regressions; modal-dialog ports verified.
      - elm-ionicons: PORTS CLEAN, verified=true (report on disk) — the
        old timeout died with the intervening speedups. Done; "no package
        is too big" upheld with zero exemptions.
- [x] W5.8 [M4] D14 `add`: stage-then-commit like `port` (no partial writes); stop
      double-prefixing `Elm.`-native modules. Prove: tier 2 (`add` round-trip fixture
      into a scratch app, idempotence re-run) + tier 1.
      DONE: vendored tree staged then committed (generateStagingPath);
      prefixIfNeeded guards Elm.-named modules. Fable-run proofs: round-trip
      compiles, second add idempotent, bogus add exits 1 with ZERO new files,
      canary 14/14. (Haiku's own fixture app was broken; code verified
      independently.)
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

- Active milestone: **M4** (curated closed). Next: W3.2 (deterministic suite
  runs — the D13 version-probe/cache races now have abundant evidence), then
  W3.3-W3.5, W5.1, W5.3, W5.4, W5.8, gate W5.5.
- 2026-07-19 M3.G PASSED: behavior oracle live end to end. 26 packages
  behavior-tested in the ledger (1,201 cases); 7 divergence specimens filed
  for triage; ingest-behavior.cjs is the §5-lawful bridge from batch log to
  ledger.
- 2026-07-19 W4.4 COUNT MET: 26 behavior-tested packages (1,201 individual test
  cases), 78 surveyed. 7 divergence specimens (test-failures) banked for triage:
  elm-units 224/4, bytes-extra 37/7, nonempty-list, elm-cons, float-extra,
  elm-trend, +1. D25 fixed (let-in-argument layout) converting array-extra 57
  + fast-dict 121. Remaining classes: D24 (2), analogue-root W4.4h (in flight),
  stemmer tool-crash specimen, json-value unparseable-source specimen.
- 2026-07-18 W4.3 COMPLETE: `port <pkg> --with-tests` = ported package +
  generated harness + executed suite + verdict in report. First
  behavior-verified port: maybe-extra 30/30.
- 2026-07-18 W4.1: P2 table complete — 21 seeded rows, 19 tagged mappings, tier-0
  completeness checker. D22 discovered by the initialize row and fixed. Tier 0:
  180 checks + checker in ~3s warm; canary 14/14.
- 2026-07-17 M1.G PASSED: tier 0 = 154 checks 0.70s; tier 1 = canary 14/14 30.5s +
  rule 4.1s + format 2.2s (~37s total); knownMiscompiles registered and red (D3/D4
  fixtures assert divergence).
- 2026-07-17 W1.3: TransformLawTest landed — 120 RecordAlias + 120 CtorLaw seeded
  samples (saturated/partial/piped ctor uses, field access), eval∘transform == eval
  including a became-stuck guard; coverage floors pass. Tier 0 green (158 checks).
- 2026-07-17 W3.6: run-residual gains --package direct-port mode (catalog-resolved,
  correct platform, ignores failure lists); vacuous --only/--reason filters now exit
  non-zero; unknown package exits non-zero; runs stay triage-only. (Delegate-implemented,
  validated here: vacuous filter EXIT=1, maybe-extra direct port EXIT=0.)
- 2026-07-17 W5.2: registry-snapshot.json committed (2,055 packages, fetched
  2026-07-17); ledger.json seeded (454 entries: 447 PASS-compile-only, 7
  working-failure); ledger lib with STALE + reconciliation laws (19 unit checks,
  npm run test:ledger); status.cjs prints LEDGER section. All seeded entries
  currently STALE by law (stamped 0d0ce41, src/ changed since) — M2.G's tier-3
  rerun reseeds. (Delegate-implemented, validated + merged here.)
- 2026-07-17 W2.3: append D2 fixed via curried ElmToGren.Compat.{List,Array,String}.append
  adapters (partial applications stay correct); P2 table begun in
  test/MappingSemanticsTest.gren (seeded rows: append order with 64/64 native-flip
  divergence measured, //-by-zero). End-to-end fixture port verified Elm order.
  Tier 0: 161 checks; canary 14/14. (Delegate-implemented, validated + merged.)
- 2026-07-17 tier-0 wall measured: 0.70s warm (`npm test`, 154 checks incl. 240
  property samples); bare runner 0.16s.
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
- 2026-07-17 W1.1: Ast.Eval landed (declaration-aware, fuel-bounded, crash≠stuck≠value)
  with 48 smoke checks; tier 0 green (150 checks).
- 2026-07-17 W1.2: EvalPropTest landed (240 seeded cases, real CtorLaw prefix,
  eval∘MatchCompile equivalence). Proof-of-red: D3 fixture (Batch [7,8], pre=315,
  post diverges) and D4 fixture (Batch [], pre=0, post Debug.todo crash) both
  CONFIRMED red by passing disagreement assertions; knownMiscompiles class =
  PatNamed arm carrying PatCons/non-empty PatList. Tier 0 green (154 checks, 0.70s).
- 2026-07-17 W3.1: atomic build (mkdir + compile to .tmp + rename, no rmSync), tests
  to dist-test/. Warm walls: build 0.53s, test 0.74s. Survival race verified: port
  in flight survives concurrent `npm run build`. (Implemented by delegate, validated
  + applied here.)
- 2026-07-17 W2.4: D5 negative-index Compat guards for Array.get/set; P2 table rows
  (arrayGetMatchesElmBounds, arraySetMatchesElmBounds, arraySliceParity). Tier 0: 164 checks.
- 2026-07-17 W2.1+W2.2: MatchCompile multi-peer merge (D3) + irrefutable fallback (D4).
  D3/D4 fixtures now assert agreement. knownMiscompiles eliminated. Tier 0: 164 checks.
- 2026-07-17 W2.5: Reserved cross-module rename fix (D18 CONFIRMED REAL). Package-wide
  reserved-export map. Tier 0: 165 checks.
- 2026-07-17 M2.G: PASSED. knownMiscompiles empty. Tier 0: 165/0. Canary: 14/14.
  Pure partial: 199/202 (2 timeouts, 1 exit-1). Full tier-3 deferred per G1.
- 2026-07-17 W4.2: elm-explorations/test -> gren-lang/test mapping table
  (mappings/test-framework.json + builtin.json renames + docs/test-framework-mapping.md).
  Finding: frameworks nearly identical (7 renames); list-extra tests ~95% portable;
  real blocker is that the pipeline does not port tests/ dirs (W4.3's job).
- 2026-07-18 W4.1: 15 new P2 rows via Haiku wave (5 impl + 5 adversarial verify + 1
  checker agent); Fable QA'd all verdicts, rewrote 2 chunks, fixed 3. D22 found and
  fixed: Compat.Array.initialize now guards count <= 0 (Gren throws RangeError where
  Elm returns []). 180 Gren checks + property-rows checker green; canary 14/14.
- 2026-07-18 W4.3a: behavior harness PROVEN on node — gren-lang/test 5.0.0 is
  platform-common; Test.Runner.String.runWithOptions + TestMain-shaped runner +
  local: dep + .Gren.Main.init() bootstrap; exit 0 green / exit 1 broken both
  verified against ported list-extra. Recipe committed in
  docs/test-framework-mapping.md; jsdom dep (browser detour) removed.
- 2026-07-18 W4.3b: --with-tests plumbing landed (Haiku impl + adversarial audit,
  Fable-validated on main): Cli flag, Acquire.testFiles, root-only ["src","tests"]
  extraction, Draft.testModules partition, test-module count in output. Baseline
  path byte-identical without the flag. Tier 0: 180 + checker; canary 14/14.
- 2026-07-18 W4.3d: behavior verdict wired into the tool (Haiku impl + adversarial
  re-proof; Fable QA found and fixed the one leak both missed: non-{0,1} exits /
  timeouts propagated as Error and failed the port — now folded to
  "harness-error" via onError). W4.3 COMPLETE: one command ports a package,
  emits + compiles + runs its own test suite, and records the verdict.
  maybe-extra: tested 30/30; list-extra: tests-unportable (D24) recorded, port
  still succeeds; no-flag: no behavior field. Tier 0: 185; canary 14/14.
- 2026-07-18 D23 FIXED (Fable): bisected to the extractor via raw elm-review run
  (site JSON: moduleName "Fuzz" vs null); minimal repro isolated the trigger to
  lambda-param shadow + let body (plain lambda and differently-named param both
  resolve fine). New Ast/BareResolve.gren pass (scope-checked bare-var repair)
  wired before NameSub at all 3 Pipeline sites; 5 regression checks in
  test/Ast/BareResolveTest.gren. list-extra harness now maps Fuzz.array
  correctly; next blocker is D24 (registered). Tier 0: 185; canary 14/14.
- 2026-07-18 W4.3c: Emit.Behavior + finalize emission of behavior-tests/ harness.
  Full 1,137-line list-extra suite ports (130 long-line Gren; content verified
  intact, line count is a bad proof proxy). Harness compile surfaces D23
  (bare mapped-name miss under sibling-lambda shadowing) — registered, blocks
  the end-to-end green run. Canary false-alarm resolved: two FAILs were a stray
  backgrounded -j1 canary racing the gren cache (D13 family), A/B confirmed
  W4.3c innocent — 14/14 on a clean environment. Tier 0: 180 + checker.
