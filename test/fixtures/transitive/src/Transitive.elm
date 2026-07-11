module Transitive exposing (fallback)

{-| Exercise an ordinary Elm dependency which the tool must also transpile.

@docs fallback

-}

import Maybe.Extra


{-| Extract a present value or return the supplied fallback.
-}
fallback : value -> Maybe value -> value
fallback default maybeValue =
    Maybe.Extra.unwrap default identity maybeValue
