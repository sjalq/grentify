module ElmToGren.Encode exposing (extraction)

import Dict exposing (Dict)
import Elm.Syntax.Range exposing (Range)
import ElmToGren.Types as Types exposing (Diagnostic, ModuleExtraction, SourceEdit)
import Json.Encode as Encode


extraction : Dict String ModuleExtraction -> Encode.Value
extraction modules =
    let
        sortedModules : List ModuleExtraction
        sortedModules =
            modules
                |> Dict.values
                |> List.sortBy .path

        diagnostics : List Diagnostic
        diagnostics =
            List.concatMap .diagnostics sortedModules
    in
    Encode.object
        [ ( "schemaVersion", Encode.int 1 )
        , ( "modules", Encode.list moduleExtraction sortedModules )
        , ( "diagnostics", Encode.list diagnostic diagnostics )
        ]


moduleExtraction : ModuleExtraction -> Encode.Value
moduleExtraction value =
    Encode.object
        [ ( "path", Encode.string value.path )
        , ( "moduleName", Encode.string value.moduleName )
        , ( "edits", Encode.list sourceEdit value.edits )
        , ( "diagnostics", Encode.list diagnostic value.diagnostics )
        , ( "importedModules", Encode.list Encode.string value.importedModules )
        , ( "requiredAdapters", Encode.list Encode.string value.requiredAdapters )
        , ( "constructors", Encode.list constructorInfo value.constructors )
        , ( "recordAliases", Encode.list recordAliasInfo value.recordAliases )
        , ( "references", Encode.list resolvedReference value.references )
        , ( "importFacts", Encode.list importFact value.importFacts )
        , ( "detectedPlatform", Encode.string (Types.platformToString value.detectedPlatform) )
        ]


resolvedReference : Types.ResolvedReference -> Encode.Value
resolvedReference value =
    Encode.object
        [ ( "range", range value.range )
        , ( "moduleName", Encode.string value.moduleName )
        , ( "name", Encode.string value.name )
        , ( "text", Encode.string value.text )
        , ( "isType", Encode.bool value.isType )
        ]


importFact : Types.ImportFact -> Encode.Value
importFact value =
    Encode.object
        [ ( "range", range value.range )
        , ( "moduleName", Encode.string value.moduleName )
        , ( "alias", Maybe.map Encode.string value.alias |> Maybe.withDefault Encode.null )
        , ( "exposingAll", Encode.bool value.exposingAll )
        , ( "exposed", Encode.list exposedItem value.exposed )
        ]


exposedItem : Types.ExposedItem -> Encode.Value
exposedItem value =
    Encode.object
        [ ( "name", Encode.string value.name )
        , ( "text", Encode.string value.text )
        ]


constructorInfo : Types.ConstructorInfo -> Encode.Value
constructorInfo value =
    Encode.object
        [ ( "moduleName", Encode.string value.moduleName )
        , ( "name", Encode.string value.name )
        , ( "arity", Encode.int value.arity )
        ]


recordAliasInfo : Types.RecordAliasInfo -> Encode.Value
recordAliasInfo value =
    Encode.object
        [ ( "moduleName", Encode.string value.moduleName )
        , ( "name", Encode.string value.name )
        , ( "fields", Encode.list Encode.string value.fields )
        ]


sourceEdit : SourceEdit -> Encode.Value
sourceEdit value =
    Encode.object
        [ ( "range", range value.range )
        , ( "replacement", Encode.string value.replacement )
        , ( "kind", Encode.string (Types.editKindToString value.kind) )
        , ( "rule", Encode.string value.rule )
        ]


diagnostic : Diagnostic -> Encode.Value
diagnostic value =
    Encode.object
        [ ( "code", Encode.string value.code )
        , ( "severity", Encode.string (Types.severityToString value.severity) )
        , ( "message", Encode.string value.message )
        , ( "range", Maybe.map range value.range |> Maybe.withDefault Encode.null )
        , ( "help", Maybe.map Encode.string value.help |> Maybe.withDefault Encode.null )
        ]


range : Range -> Encode.Value
range value =
    Encode.object
        [ ( "start", position value.start )
        , ( "end", position value.end )
        ]


position : { row : Int, column : Int } -> Encode.Value
position value =
    Encode.object
        [ ( "row", Encode.int value.row )
        , ( "column", Encode.int value.column )
        ]
