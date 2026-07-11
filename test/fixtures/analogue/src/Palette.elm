module Palette exposing (accent, accentCss)

{-| Exercise an Elm dependency which maps to an existing Gren package.

@docs accent, accentCss

-}

import Color exposing (Color)


{-| The fixture's accent color.
-}
accent : Color
accent =
    Color.rgb255 26 115 232


{-| The accent encoded as CSS.
-}
accentCss : String
accentCss =
    Color.toCssString accent
