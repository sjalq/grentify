module Curried.Ast exposing (Value(..))

{-| The declaring module: `Tagged` takes two arguments, which is one more
than a Gren variant may carry.

@docs Value

-}


{-| A value that may carry a name alongside it. -}
type Value
    = Plain String
    | Tagged String Value
