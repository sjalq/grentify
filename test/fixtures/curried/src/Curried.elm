module Curried exposing (build, tag)

{-| `Tagged` is named here without being applied, so the port cannot rewrite
the call site into a record — it has to hand back something still curried.

@docs build, tag

-}

import Curried.Ast as Ast


{-| The constructor as a plain value, across a module boundary. -}
tag : String -> Ast.Value -> Ast.Value
tag =
    Ast.Tagged


{-| The same constructor reached through another function. -}
build : String -> Ast.Value
build name =
    (\make -> make name (Ast.Plain name)) Ast.Tagged
