module Helper exposing (describe)

{-| An unprefixed sibling that imports the Elm.-prefixed module.

@docs describe

-}

import Elm.Facts


{-| -}
describe : String -> String
describe name =
    let
        found =
            Elm.Facts.fact name 1
    in
    found.name ++ "/" ++ String.fromInt found.arity
