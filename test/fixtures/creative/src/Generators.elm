module Generators exposing (coin, die, threeDice)

{-| Exercise mappings that need more than a package or symbol rename.

`Random.weighted` changes tuple-shaped arguments to records in Gren, while
`Random.list` and Elm lists become Gren arrays.

@docs coin, die, threeDice

-}

import Random exposing (Generator)


{-| Generate one six-sided die roll.
-}
die : Generator Int
die =
    Random.int 1 6


{-| Generate three die rolls as a collection.
-}
threeDice : Generator (List Int)
threeDice =
    Random.list 3 die


{-| Generate a fair coin face through Elm's tuple-based weighted API.
-}
coin : Generator String
coin =
    Random.weighted ( 1, "heads" ) [ ( 1, "tails" ) ]
