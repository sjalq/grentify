# Prior art and ecosystem research

Research date: 2026-07-11

## Direct Elm-to-Gren tooling

GitHub repository and code searches for `elm-to-gren`, `elm to gren`,
`gren elm migration`, and repositories containing both `elm.json` and
`gren.json` found no existing general-purpose transpiler. The Gren project
also states explicitly that source compatibility with Elm is not a goal, so a
porting tool has to own the compatibility policy rather than assuming the two
languages will converge:

- [Gren FAQ: relationship to and differences from Elm](https://gren-lang.org/book/appendix/faq/)
- [Upcoming language changes](https://gren-lang.org/news/240819_upcoming_language_changes)

This project therefore appears to fill a real tooling gap.

## Manual Gren ports that serve as executable specifications

Several official Gren packages began as manual Elm ports. Their diffs are the
best available corpus for learning transformations and semantic choices.

- [`gren-lang/random` PR #1](https://github.com/gren-lang/random/pull/1)
  migrated `elm/random`. The PR explicitly replaces tuples with records and
  Lists with Arrays. Its diff also shows where mechanical field names are not
  enough: state pairs became `{ value, seed }`, bounds became `{ lo, hi }`, and
  weighted values became `{ weight, value }`.
- [`gren-lang/example-projects` PR #2](https://github.com/gren-lang/example-projects/pull/2)
  manually ported Elm TodoMVC and records a JSON decoder mismatch encountered
  during the port. It is useful evidence that compilation-oriented syntax
  replacement alone is insufficient.
- [`gren-lang/compiler` issue #68](https://github.com/gren-lang/compiler/issues/68)
  links the `elm/random` migration and records the compiler workflow used while
  porting.
- The official [`core`](https://github.com/gren-lang/core),
  [`browser`](https://github.com/gren-lang/browser),
  [`url`](https://github.com/gren-lang/url), and
  [`parser`](https://github.com/gren-lang/parser) repositories provide current
  target APIs for mapping Elm's official packages.

These ports are references and test corpora, not code dependencies. Their
licenses and attribution must be preserved if source is ever copied into a
generated adapter.

## Elm analysis and transformation infrastructure

- [`jfmengels/elm-review`](https://github.com/jfmengels/elm-review) supplies
  project/module visitors, source ranges, module lookup tables, project data
  extraction, and automatic-fix descriptions.
- [`stil4m/elm-syntax`](https://github.com/stil4m/elm-syntax) is the Elm AST
  used by elm-review.
- [`jfmengels/elm-review-code-style`](https://github.com/jfmengels/elm-review-code-style)
  demonstrates substantial source rewrites with review fixes.
- [`elm/project-metadata-utils`](https://github.com/elm/project-metadata-utils)
  documents and decodes `elm.json`/`docs.json` shapes.

An important boundary follows from this infrastructure: elm-review's normal
fix application expects the result to remain valid Elm. Gren-only syntax such
as `when ... is` cannot be passed through that fixer. The rule in this project
uses elm-review as the AST and project-analysis engine, exports typed source
edits with `withDataExtractor`, and lets the Gren host apply those edits.

## Package acquisition and dependency solving

- [`robinheghan/elm-git-install`](https://github.com/robinheghan/elm-git-install)
  installs private Elm packages from git. It is useful for git/cache layout,
  but is not a recursive public-registry porting solution.
- [`zwilias/elm-json`](https://github.com/zwilias/elm-json) implements Elm
  dependency installation/upgrades and is useful solver prior art.
- Gren's published
  [`Compiler.Dependencies`](https://packages.gren-lang.org/package/gren-lang/compiler-common/latest/module/Compiler.Dependencies)
  intersects requirements for already-loaded outlines. It does not select Elm
  package versions from the Elm registry, so elm-to-gren needs a candidate-
  selecting backtracking solver of its own.

## Gren package output

- [The `gren.json` reference](https://gren-lang.org/book/appendix/gren_json/)
  defines package manifests and platform compatibility.
- [`Compiler.Package`](https://packages.gren-lang.org/package/gren-lang/compiler-node/latest/module/Compiler.Package)
  is the canonical Gren implementation for reading and writing
  `gren_packages/*.pkg.gz` bundles.
- Gren 0.6.4 introduced committed `gren_packages` bundles for zero-install
  builds, as documented in the FAQ.

The emitter should use `Compiler.Package.saveToStream`, local dependency
constraints for the generated workspace, and `gren docs` as its final package
validation gate.

## Consequences for this project

1. Keep mappings versioned against a specific Gren compiler/core release.
2. Treat official manual port diffs as regression fixtures and semantic mapping
   proposals.
3. Separate AST analysis (Elm/elm-review) from edit application (Gren).
4. Make non-mechanical choices explicit through adapters, mapping overlays, and
   manual patches rather than hiding them in regexes.
5. Fail early for Elm kernel/effect/GLSL code unless an explicit creative
   mapping supplies a Gren implementation.
