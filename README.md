# elm-to-gren (Grenity)

Port an Elm package (and its dependency graph) into **compiler-validated Gren packages**.

```sh
npm install && npm run build
node bin/elm-to-gren.cjs elm-community/list-extra --out ./out --cache ./cache
```

## What it does

Elm and Gren are close but not source-compatible (lists vs arrays, ctors, core APIs, …).
This tool:

1. Downloads (or reads) an Elm package and its Elm dependencies  
2. Decides per package: **map** to an existing Gren package, or **transpile**  
3. Transpiles Elm sources into Gren  
4. Writes a Gren package (or vendors into an app)  
5. Formats (unless the package is huge) and **verifies with the real Gren compiler**

If Gren accepts the result, the port is treated as successful.

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
  → emit files (workspace or .elm-to-gren/ vendor)
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
elm-to-gren [port] <author/package[@version] | local-path> [options]
elm-to-gren add    <author/package[@version] | local-path> [options]
```

| Command | Meaning |
| --- | --- |
| `port` (default) | Fresh Gren workspace (`--out`, default `./gren-output`). No module prefix. |
| `add` | Vendor into an existing Gren **application** (`--out` default `.`). Modules get an `Elm.` prefix. Idempotent. |

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | Workspace (`port`) or app root (`add`) |
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

## What ports / what does not

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
