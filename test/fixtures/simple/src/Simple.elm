module Simple exposing (orElse, prepend, swap, unit)

{-| A small package used to validate syntax translation.

@docs orElse, prepend, swap, unit

-}

{-| Swap both fields of a pair. -}
swap : ( a, b ) -> ( b, a )
swap ( first, second ) =
    ( second, first )


{-| Extract a value or use a fallback. -}
orElse : a -> Maybe a -> a
orElse fallback maybeValue =
    case maybeValue of
        Just value ->
            value

        Nothing ->
            fallback


{-| Put a value at the beginning. -}
prepend : a -> List a -> List a
prepend first rest =
    first :: rest


{-| The unit value. -}
unit : ()
unit =
    ()
