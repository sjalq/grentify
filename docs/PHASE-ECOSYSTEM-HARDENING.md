# Phase: Ecosystem hardening (post AST host pipeline)

**Status:** in progress  
**Scope:** Make pure/browser package porting **measured, fast to iterate, and honest**.  
**Not this phase:** new language features, publishing ports, UI/app work, growing past the candidate catalogs for vanity counts.

This document is the **compact/resume brief** for this phase only. Read this after a context wipe before rereading logs or re-deriving process.

---

## Phase goal

1. Host AST pipeline ports **qualifying** Elm packages to compiler-validated Gren.
2. Success is **commit-stamped proof**, never catalog length or old cache logs.
3. Iteration loop stays **fast**: unit → canary → residual class → full suite only when needed.

Done for this phase when:

- `npm run ecosystem:status` reports **PASS pure** (200/200) and ideally **PASS browser** on a clean HEAD.
- `npm run ecosystem:canary` is green on every host change before full suite.
- No known transform **hangs** on catalog packages (timeouts are classified, not infinite).

### Latest stamp (dirty `5ef3c2f`, overnight session)

| Suite | Result | Wall |
| --- | --- | --- |
| unit | **94/94** | ~1s |
| format (incl. collapse tests) | **pass** | ~1s |
| canary (14 pkgs) | **14/14** | ~42s |
| pure | **200/200 PASS** | ~127s -j6 |
| browser | **242/252** (10 residual) | ~15 min -j6 @300s |

Browser residual (not yet proof-green): 5 timeout (huge icon/CSS modules), 2 naming, 2 type-mismatch, 1 exit-1 (eetf AST decode).

---

## Ground truth (non-negotiable)

| Thing | Role |
| --- | --- |
| `test/ecosystem/packages.json` | Pure **candidate** suite (200). Not success. |
| `test/ecosystem/packages-browser.json` | Browser **candidate** suite (252). Not success. |
| `test/ecosystem/packages-canary.json` | Fast regression set (~12). Not proof. |
| `.test-cache/ecosystem-proof/LAST_RUN.json` | **Only** suite proof. Stamped with git commit + dirty flag. |
| `.test-cache/ecosystem-proof/TRIAGE.json` | Residual/canary results. Not proof. |
| `.test-cache/**/summary.json`, `*.log`, `prove-log.json` | Scratch. Do not quote as “how many we can port.” |
| `scripts/temp/*` | Ad-hoc experiments (`_ADHOC.cjs` banner). Never suite proof. |

Query proof:

```sh
npm run ecosystem:status
```

- Missing / wrong commit / dirty mismatch → **NO PROOF** or **STALE PROOF**.
- Catalog `packages.length` is **attempt set size**, not verified count.

Full unfiltered suite runs write proof. Filtered runs (`--limit`, `--only`, canary, residual) write triage only.

---

## Iteration methodology (keep this loop)

### Default fix loop (after any host transform change)

```sh
npm run dev:loop
# = build + unit tests + canary (-j4)
```

If canary fails: fix the **dominant `failReason`**, not random packages.

### Class-based residual

```sh
npm run ecosystem:residual              # all failures in TRIAGE/LAST_RUN
npm run ecosystem:residual -- --reason shadowing
npm run ecosystem:residual -- -j 6 --timeout-ms 45000
```

Prints recovered / still failing. Re-run until the class is gone or known deferred.

### Full proof (slow; use sparingly)

```sh
npm run ecosystem:pure:j                # pure 200, -j6, writes proof
npm run ecosystem:browser:j             # browser candidates, -j6, writes proof
```

Suite flags (after `--`): `--limit N`, `--offset N`, `--only a@v,b@v`, `-j N`, `--timeout-ms N`, `--fail-fast`, `--keep-out`, `--no-proof`.

**Rule:** never debug on a full 200/252 serial run first. Canary green → residual class → full parallel proof.

### Expected wall times (order of magnitude)

| Loop | Wall |
| --- | --- |
| unit (`npm test`) | ~1s |
| canary -j4 | ~30–45s |
| residual (~10 fails) -j6 + timeout | ~1–3 min |
| pure 200 -j6–8 + timeouts | ~15–40 min (hangs used to blow this up) |

---

## Technical laws established this phase

Host AST path (when extract has AST):

`NameSub → RecordAlias → CtorLaw → MatchCompile → Reserved → Print`  
then catalog maps / Compat, format, `gren docs` verify.

### Critical host fixes already landed (do not re-break)

1. **`@docs` commas** (`Ast.Reserved.rewriteDocsTokens`): always reattach `,` when the source token had one. Dropping commas → mass `DOCS MISTAKE`.
2. **Mutual `let`** (`Ast.MatchCompile`): multi-binding lets stay one block unless a destructure needs list peel. Nested `let a = … in let b = …` broke forward refs (`ts = map t` before `t`).
3. **Shadowing in general case / record peels**: unique seeds per arm; refutable record fields before irrefutable so fail-continuations are not nested under `let first = …`.
4. **Fixed array patterns vs cons peels**: Gren accepts `[a, b, c]` (and nested `[[a,b]]`) in `when`. Multi-arm **fixed** list cases must **not** go through multi-arm peel fallthrough (exponential Print/transform hang: color, md5, iso-style cases). Only peel true **`::` cons**.  
   - `patternHasUnportedList` flags **cons**, not bare fixed `PatList`.  
   - `tryPlainListCase` returns Nothing when no cons (leave ExprCase for Print).
5. **`joinCtorPayloads`**: do not join `Ctor\n{` when the brace line is a case arm (`->`). Word-boundary required: camelCase suffixes like `totalDays` must not match trailing `Days` as a ctor (iso8601 UNEXPECTED EQUALS). Also skip when two+ newlines separate name and brace (sibling let bind, not payload).
6. **Format post-pass** (`tools/gren-format/collapse-record-patterns.cjs`): join broken nested record field values; careful glue/split so fn heads with record args and mid-expression glues stay valid. Critical laws:
   - Never treat keywords (`let`, `in`, `else`, …) as function names in `parenRecordFnArgs`.
   - Do not join deeper-indented value lines onto shallower record binds (mid-expression), except bare locals under `let`.
   - `separateGluedExprAndRecordBind` must not undo a correct `let`-local join.
   - Regression suite: `npm run test:format` includes `test/format/collapse-record-patterns.test.cjs`.

### Known open (resume here)

| Item | Symptom | Notes |
| --- | --- | --- |
| **Browser full re-proof** | LAST_RUN still old 242/252 | Residual recovered 10/10 volume+error class; run `ecosystem:browser:j` for stamp. |
| **Commit clean proof** | DIRTY tree stamp | Commit; re-run pure+browser for clean HEAD. |
| **Thin platform mappings** | `scripts/temp/gap-log.json` | Secondary. |

### Volume catalog policy (scale class)

**Not hangs.** Icon packs / CSS class dumps: huge modules or hundreds of tiny modules.

| Detection (any) | Threshold |
| --- | --- |
| max module size | ≥ 100 KB |
| module count | ≥ 200 |
| total source bytes | ≥ 400 KB |

**Host:** auto-skip `gren-format` + collapse when volume (`Port.Volume`).

**Suite:** adaptive timeout (floor 12 min, cap 25 min from size); exceedance → failReason **`scale`** not `timeout`. See `test/ecosystem/lib/volume.cjs`.

**Measured residual (volume + prior error classes):** **10/10 recovered** with adaptive budget + format skip (e.g. feather ~12–460s depending on cache, ionicons ~438s, ant-design ~554s, tachyons ~222–699s).

### Fixed this session (naming / type-mismatch / exit-1)

| Class | Package | Fix |
| --- | --- | --- |
| naming | protocol-buffers `Empty` | `RecordAlias`: empty-record aliases rewrite bare ctor to `{}` |
| naming | http-decorators `Expect` | `NameSub`: re-qualify bare names dropped from exposing (Compat multi-segment remaps) |
| type-mismatch | http-upgrade-shim `BadPayload` | `Print.ctorFieldLabels`: named platform fields only when module is Http/Compat (local uses first/second) |
| type-mismatch | phoenix-socket messages | `MatchCompile`: skip Maybe/list peel when `Just xs` binds whole list |
| exit-1 | eetf big ints | `AstEncode` int as string; `Ast.Decode` accepts number or string (was JSON null) |

### Landed this session (format + measurement + print)

- **iso8601 class fixed**: `joinCtorPayloads` camelCase boundary + no `\n\n` join; sibling bind recovery.
- **list-extra / unfinished-let class fixed**: keyword ban in `parenRecordFnArgs`; let-context join for local `f`; separateGlued does not undo.
- **Binop + block RHS** (`Print`): break after operator for `let`/`when`/`if` only (not all multiline — preserves `|= (p \|> andThen …)` parens). Fixes alt-core `\|\| (let` UNFINISHED LET without breaking edn-parser.
- **Canary expanded** to 14: includes `jweir/elm-iso8601`, `avh4/elm-color`.
- **Residual** supports `--only pkg@ver`.
- **Browser suite** default timeout 180s (`ecosystem:browser:j`).
- **Unit**: Print tests (+ multi-decl let+if, fixed-list, binop-let) → 94 checks; format collapse tests ~14.
- **Pure proof**: **200/200** on dirty `5ef3c2f` (~127s wall -j6).

---

## File map for this phase

| Path | Purpose |
| --- | --- |
| `src/Ast/MatchCompile.gren` | List/cons peels, general case, mutual let, shadowing seeds |
| `src/Ast/Reserved.gren` | `when`/`is` + `@docs` rewrites |
| `src/Ast/Print.gren` | AST → Gren source |
| `tools/gren-format/collapse-record-patterns.cjs` | Post-`gren-format` pattern/glue repairs |
| `test/ecosystem/lib/suite.cjs` | Parallel suite, timeout, failReasons, proof/triage write |
| `test/ecosystem/status.cjs` | Commit-stamped status only |
| `test/ecosystem/run-canary.cjs` | Fast regression |
| `test/ecosystem/run-residual.cjs` | Fail-only re-port |
| `test/ecosystem/packages*.json` | Candidates (`role: candidate-suite`) |
| `docs/PHASE-ECOSYSTEM-HARDENING.md` | **This brief** |

---

## Resume checklist (after compact)

1. Read **this file** (only phase brief required).
2. `git status` / `git log -5` — note dirty vs proof stamp.
3. `npm run ecosystem:status` — trust only LAST_RUN match.
4. `npm run dev:loop` — baseline canary.
5. Open items: **browser suite** (if not green), then commit for clean-HEAD proof.
6. Do **not** treat catalog sizes or old `.test-cache` logs as current capability.
7. Do **not** reintroduce multi-arm fixed-list full peels without a length-dispatch + failFn design that Print can handle.
8. Format post-pass regressions live in `test/format/collapse-record-patterns.test.cjs`; run `npm run test:format` after any edit to that file.

---

## Commands cheat sheet

```sh
npm run build
npm test
npm run ecosystem:status
npm run dev:loop
npm run ecosystem:canary
npm run ecosystem:residual -- -j 6 --timeout-ms 45000
npm run ecosystem:pure:j
npm run ecosystem:browser:j
npm run test:ecosystem          # serial pure (writes proof)
npm run test:ecosystem-browser  # serial browser (writes proof)
```

---

## Phase boundary

**In phase:** host correctness for pure/browser candidate ports; measurement; fast residual loops; hang/class fixes that unblock the suite.

**Out of phase:** expanding catalogs for marketing numbers; app-level `add` productization; node platform suite; kernel/effect ports; rewriting Gren itself.

When pure+browser proofs are green on a clean commit and canary stays green under normal host edits, **close this phase** and start a new brief (do not keep appending forever to this file).
