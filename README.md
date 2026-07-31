# elm-to-gren (Grenity)

Vendor an Elm package (and its dependency graph) into your Gren application as **compiler-validated Gren code**.

```sh
npm install && npm run build
# from your Gren app root
node bin/elm-to-gren.cjs add elm-community/list-extra --cache ./cache
```

## What it does

Elm and Gren are close but not source-compatible (lists vs arrays, ctors, core APIs, …).
This tool:

1. Downloads (or reads) an Elm package and its Elm dependencies  
2. Decides per package: **map** to an existing Gren package, or **transpile**  
3. Transpiles Elm sources into Gren  
4. Vendors the result into your app  
5. Formats (unless the package is huge) and **verifies with the real Gren compiler**

If Gren accepts the result, the conversion is treated as successful.

## How it works (pipeline)

```
input (author/pkg@version or local path)
  → acquire sources
  → prune unused root deps
  → resolve dependency graph
  → acquire remaining packages
  → for each package (dependencies first):
        map to Gren  |  or  extract AST → transform → adapters
  → plan gren.json names/versions
  → emit files (vendored under .elm-to-gren/)
  → format (skip volume packages)
  → verify (`gren docs` / `gren make`)
```

**Transform** (when not using a cache hit) is host-owned:

`NameSub → RecordAlias → CtorLaw → MatchCompile → Reserved → Print`  
then catalog renames (e.g. `List.filter` → `Array.keepIf`) and `ElmToGren.Compat.*` shims.

**Catalog** packages (see `mappings/builtin.json`) are not re-transpiled; they become
normal Gren dependencies.

## Commands

```
elm-to-gren add <author/package[@version] | local-path> [options]
```

`add` vendors into an existing Gren **application** (`--out` default `.`).
Modules get an `Elm.` prefix. Idempotent.

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | App root |
| `--cache <dir>` | Download / analysis cache (default `~/.cache/elm-to-gren`) |
| `--platform <p>` | `auto` (default), `common`, `browser`, or `node` |
| `--mapping <file>` | Extra mapping file (repeatable) |
| `--offline` | Registry/cache only |
| `--json` | Machine-readable report |

### Add (vendor) layout

```sh
# from your Gren app root
node bin/elm-to-gren.cjs add elm-community/list-extra --cache ./cache
# → ./.elm-to-gren/packages/<author>_<name>__<version>/
# → gren.json: "local:.elm-to-gren/packages/..."
```

## What converts / what does not

**Good fit:** pure or browser libraries over `elm/core` and common packages
(`json`, `time`, `random`, `bytes`, `regex`, `url`, `parser`, …).

**Refused at acquire:**

- `effect module`
- `Elm.Kernel` / native kernel imports  
- GLSL blocks (`[glsl|…|]`)

**Ports syntax** (`port module` / `port`) is kept for app interop; the tool does not
emit the JS side of ports.

## Layout

| Path | Role |
| --- | --- |
| `src/` | Gren CLI: acquire, resolve, transform, emit, format, verify |
| `review/` | elm-review rule: AST + refs for the transform |
| `mappings/` | Elm→Gren package/API catalog |
| `tools/gren-format/` | Vendored formatter |
| `test/` | Unit, format, e2e, ecosystem suites |

## Development

```sh
npm run build
npm run check
npm test
npm run test:all    # unit + rule + format + e2e + ecosystem
```

Ecosystem catalogs under `test/ecosystem/` are **candidates**, not success counts.
Full suite proof lives in `.test-cache/ecosystem-proof/` after an unfiltered run.

## License

MIT
