module Structural exposing (Alias, Pair(..), aliasValue, make, match, nested, partial)


type Pair a b
    = Pair a b
    | Single a
    | Nested ( a, b ) ( b, a )


type alias Alias a b =
    { left : a
    , right : b
    }


nested : ( ( Int, Int ), ( Int, Int ) )
nested =
    ( ( 1, 2 ), ( 3, 4 ) )


make : Pair Int Int
make =
    Pair 1 2


partial : Int -> Pair Int Int
partial =
    Pair 1


aliasValue : Alias Int Int
aliasValue =
    Alias 1 2


match : Pair Int Int -> Int
match value =
    case value of
        Pair first second ->
            first + second

        Single only ->
            only

        Nested ( first, second ) ( third, fourth ) ->
            first + second + third + fourth
