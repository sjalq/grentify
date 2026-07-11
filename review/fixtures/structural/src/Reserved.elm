module Reserved exposing (is, when)


when : Int -> Int
when is =
    let
        when =
            is
    in
    { is = when }.is
