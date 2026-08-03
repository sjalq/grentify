module Elm.Facts exposing (Fact, fact)

{-| A module whose name already carries the Elm. prefix, like stil4m/elm-syntax's Elm.Parser.

@docs Fact, fact

-}


{-| -}
type alias Fact =
    { name : String
    , arity : Int
    }


{-| -}
fact : String -> Int -> Fact
fact name arity =
    { name = name
    , arity = arity
    }
