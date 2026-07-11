module ReviewConfig exposing (config)

import ElmToGren.Rule
import Review.Rule exposing (Rule)


config : List Rule
config =
    [ ElmToGren.Rule.rule ]
