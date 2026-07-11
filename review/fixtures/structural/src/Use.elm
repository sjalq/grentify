module Use exposing (aliasPartial, aliasValue, asFunction, commonArrayCase, consScrutinee, empty, embeddedCtorExactUncons, embeddedCtorUncons, embeddedEmptyAfterAll, exactDoubleCons, make, match, maybeMultiConsWild, nestedConsPattern, partial, qualified, qualifiedAlias, resultUncons, tripleConsPattern, tupleMultiConsWild, unsafeEmbeddedExactThenOpen, unsafeEmbeddedVarCatchAll, unsafeExactThenOpenRest, unsafeExactThenVarCatchAll, unsafeMaybeMultiConsVar, unsafeMultiConsOtherThenAll, unsafeMultiConsVarCatchAll, unsafeTupleMultiConsVar)

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

        _ ->
            0


tripleConsPattern : List Int -> Int
tripleConsPattern values =
    case values of
        first :: second :: third :: rest ->
            first + second + third + List.length rest

        _ ->
            0


exactDoubleCons : List Int -> Int
exactDoubleCons values =
    case values of
        first :: second :: [] ->
            first + second

        _ ->
            0


{-| Exact multi-cons then open rest: nested empty-rest guards cannot fall
through to the open-rest arm, so the rewrite must refuse (keep :: diagnostics).
-}
unsafeExactThenOpenRest : List Int -> Int
unsafeExactThenOpenRest values =
    case values of
        first :: second :: [] ->
            first + second

        first :: second :: rest ->
            first + second + List.length rest

        _ ->
            0


{-| Exact multi-cons then named catch-all: empty-guard failure would become
`Debug.todo` and drop `other`, so refuse.
-}
unsafeExactThenVarCatchAll : List Int -> Int
unsafeExactThenVarCatchAll values =
    case values of
        first :: second :: [] ->
            first + second

        other ->
            List.length other


{-| Multi-cons open rest with named catch-all: nested Nothing arms cannot
rebind `other`, so refuse rather than emit `Debug.todo`.
-}
unsafeMultiConsVarCatchAll : List Int -> Int
unsafeMultiConsVarCatchAll values =
    case values of
        first :: second :: rest ->
            first + second + List.length rest

        other ->
            List.length other


{-| Multi-cons with named catch-all before `_`: short-list fallthrough must
hit `other`, not paste the later `_` body.
-}
unsafeMultiConsOtherThenAll : List Int -> Int
unsafeMultiConsOtherThenAll values =
    case values of
        first :: second :: rest ->
            first + second + List.length rest

        other ->
            List.length other

        _ ->
            -1


type Box a
    = Box a


embeddedCtorUncons : Box (List Int) -> Int
embeddedCtorUncons boxed =
    case boxed of
        Box [] ->
            0

        Box (first :: rest) ->
            first + List.length rest


embeddedCtorExactUncons : Box (List Int) -> Int
embeddedCtorExactUncons boxed =
    case boxed of
        Box [] ->
            0

        Box (first :: []) ->
            first

        _ ->
            -1


{-| Exact embedded uncons then open rest on the same ctor: nested empty guard
would skip the open-rest arm, so the rewrite must refuse.
-}
unsafeEmbeddedExactThenOpen : Box (List Int) -> Int
unsafeEmbeddedExactThenOpen boxed =
    case boxed of
        Box (first :: []) ->
            first

        Box (first :: rest) ->
            first + List.length rest

        _ ->
            -1


{-| Embedded exact uncons with only a named catch-all: length-mismatch /
empty-list fallbacks cannot rebind `other`, so refuse.
-}
unsafeEmbeddedVarCatchAll : Box (List Int) -> Int
unsafeEmbeddedVarCatchAll boxed =
    case boxed of
        Box (first :: []) ->
            first

        other ->
            -1


{-| Embedded uncons with `_` before a later `Box []`: empty lists match `_`
first, so the Nothing fallback must paste `-1`, not the dead `Box []` body.
-}
embeddedEmptyAfterAll : Box (List Int) -> Int
embeddedEmptyAfterAll boxed =
    case boxed of
        Box (first :: rest) ->
            first + List.length rest

        _ ->
            -1

        Box [] ->
            0


resultUncons : Result String (List Int) -> Int
resultUncons value =
    case value of
        Err _ ->
            -1

        Ok [] ->
            0

        Ok (first :: rest) ->
            first + List.length rest


{-| Tuple multi-cons with fully-wild sibling: short peels must paste `(_, _)`.
-}
tupleMultiConsWild : List Int -> Int -> Int
tupleMultiConsWild values flag =
    case ( values, flag ) of
        ( first :: second :: rest, n ) ->
            first + second + List.length rest + n

        ( _, _ ) ->
            -1


{-| Tuple multi-cons with named component catch-all: cannot rebind `other`.
-}
unsafeTupleMultiConsVar : List Int -> Int -> Int
unsafeTupleMultiConsVar values flag =
    case ( values, flag ) of
        ( first :: second :: rest, n ) ->
            first + second + List.length rest + n

        ( other, _ ) ->
            List.length other


{-| Maybe multi-cons with `Just _` fallthrough for short lists.
-}
maybeMultiConsWild : Maybe (List Int) -> Int
maybeMultiConsWild value =
    case value of
        Just ( first :: second :: rest ) ->
            first + second + List.length rest

        Just _ ->
            -1

        Nothing ->
            0


{-| Maybe multi-cons with `Just other`: short peels cannot rebind `other`.
-}
unsafeMaybeMultiConsVar : Maybe (List Int) -> Int
unsafeMaybeMultiConsVar value =
    case value of
        Just ( first :: second :: rest ) ->
            first + second + List.length rest

        Just other ->
            List.length other

        Nothing ->
            0
