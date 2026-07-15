# elm-review style playground

Browser Gren demo: Review-style static analysis on the **ported** `stil4m/elm-syntax` AST.

## Rules (non-trivial)

| Rule | What it does |
| --- | --- |
| `NoExposingAll` | Flags `exposing (..)` |
| `NoDebug` | Walks expressions for `Debug.*` |
| `NoDuplicateImports` | Detects repeated import modules |
| `NoUnusedImports` | Flags imports never used as qualifiers |

## Packages

- `stil4m/elm-syntax` (+ structured-writer, elm-hex) — ported via elm-to-gren
- `mdgriffith/elm-ui` — ported UI chrome
- `jfmengels/elm-review` — tracked in the ecosystem suite; not vendored until it verifies under Gren

## Build

```sh
gren make Main --output=index.html
```

Or from repo root: `node scripts/build-site.cjs`
