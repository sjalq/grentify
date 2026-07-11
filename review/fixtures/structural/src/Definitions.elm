module Definitions exposing (Alias, Empty, Pairish(..), aliasValue, commentedCons, consConstructed, empty, lineCommentedCons, nested, pairishValue)


type Pairish a b
    = Pairish a b
    | Single a
    | Nested ( a, b ) ( b, a )


type alias Alias a b =
    { left : a
    , right : b
    }


type alias Empty =
    {}


nested : ( ( Int, Int ), List Int )
nested =
    ( ( 1, 2 ), 3 :: 4 :: [] )


commentedCons : List Int
commentedCons =
    1 {- keep :: in this comment -} :: {- keep this gap -} []


lineCommentedCons : List Int
lineCommentedCons =
    1
        -- keep :: in this line comment
        :: []


consConstructed : List (Pairish Int Int)
consConstructed =
    Pairish 1 2 :: Pairish 3 4 :: []


pairishValue : Pairish ( Int, Int ) ( Int, Int )
pairishValue =
    Pairish ( 1, 2 ) ( 3, 4 )


aliasValue : Alias ( Int, Int ) (List Int)
aliasValue =
    Alias ( 1, 2 ) (3 :: [])


empty : Empty
empty =
    Empty
