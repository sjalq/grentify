module Use exposing (aliasPartial, aliasValue, asFunction, commonArrayCase, consScrutinee, empty, make, match, nestedConsPattern, partial, qualified, qualifiedAlias)

import Definitions as D exposing (Alias, Empty, Pairish(..))


make : Pairish ( Int, Int ) ( Int, Int )
make =
    Pairish ( 1, 2 ) ( 3, 4 )


partial : ( Int, Int ) -> Pairish ( Int, Int ) ( Int, Int )
partial =
    Pairish ( 1, 2 )


asFunction : ( Int, Int ) -> ( Int, Int ) -> Pairish ( Int, Int ) ( Int, Int )
asFunction =
    Pairish


aliasValue : Alias ( Int, Int ) (List Int)
aliasValue =
    Alias ( 1, 2 ) (3 :: [])


aliasPartial : List Int -> Alias ( Int, Int ) (List Int)
aliasPartial =
    Alias ( 1, 2 )


qualifiedAlias : D.Alias Int Int
qualifiedAlias =
    D.Alias 1 2


empty : Empty
empty =
    Empty


qualified : D.Pairish ( Int, Int ) ( Int, Int )
qualified =
    D.Pairish ( 1, 2 ) ( 3, 4 )


match : Pairish ( Int, Int ) ( Int, Int ) -> Int
match value =
    case value of
        Pairish ( first, second ) ( third, fourth ) ->
            first + second + third + fourth

        Single only ->
            Tuple.first only


commonArrayCase : List ( Int, Int ) -> Maybe ( ( Int, Int ), List ( Int, Int ) )
commonArrayCase values =
    case values of
        [] ->
            Nothing

        ( first, second ) :: rest ->
            Just ( ( first, second ), rest )


consScrutinee : List Int -> Int
consScrutinee values =
    case 1 :: values of
        [] ->
            0

        first :: rest ->
            first + List.length rest


nestedConsPattern : List Int -> Int
nestedConsPattern values =
    case values of
        [] ->
            0

        first :: second :: rest ->
            first + second + List.length rest
