module KernelBoundary exposing (unsafe)

import Elm.Kernel.Basics


unsafe : a -> a
unsafe value =
    Elm.Kernel.Basics.identity value
