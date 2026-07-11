module ElmToGren.Rule exposing (rule)

{-| Extract syntax-directed Elm-to-Gren edits.

The rule deliberately extracts edits instead of asking `elm-review --fix` to
apply them. A fix which introduces Gren syntax is not valid Elm, so the
elm-review fixer would reject exactly the changes this project needs. The
Node host validates and applies the extracted ranges after review has finished.

-}

import Dict exposing (Dict)
import Elm.Syntax.Declaration exposing (Declaration(..))
import Elm.Syntax.Exposing exposing (Exposing(..), TopLevelExpose(..))
import Elm.Syntax.Expression exposing (Expression(..), LetDeclaration(..))
import Elm.Syntax.File exposing (File)
import Elm.Syntax.Import exposing (Import)
import Elm.Syntax.Module exposing (Module(..))
import Elm.Syntax.Node as Node exposing (Node(..))
import Elm.Syntax.Pattern exposing (Pattern(..))
import Elm.Syntax.Range exposing (Location, Range)
import Elm.Syntax.Type exposing (ValueConstructor)
import Elm.Syntax.TypeAnnotation exposing (TypeAnnotation(..))
import ElmToGren.Encode as Encode
import ElmToGren.Types as Types exposing (ConstructorInfo, Diagnostic, EditKind, ModuleExtraction, Platform, RecordAliasInfo, SourceEdit)
import Review.ModuleNameLookupTable as ModuleNameLookupTable exposing (ModuleNameLookupTable)
import Review.Rule as Rule exposing (Rule)


rule : Rule
rule =
    Rule.newProjectRuleSchema "ElmToGren" initialProjectContext
        |> Rule.withModuleVisitor moduleVisitor
        |> Rule.withModuleContextUsingContextCreator
            { fromProjectToModule = fromProjectToModule
            , fromModuleToProject = fromModuleToProject
            , foldProjectContexts = foldProjectContexts
            }
        |> Rule.withContextFromImportedModules
        |> Rule.withDataExtractor (.modules >> Encode.extraction)
        |> Rule.fromProjectRuleSchema


type alias ProjectContext =
    { modules : Dict String ModuleExtraction
    , definitions : Dict String Definitions
    }


initialProjectContext : ProjectContext
initialProjectContext =
    { modules = Dict.empty
    , definitions = Dict.empty
    }


type alias ModuleContext =
    { path : String
    , moduleName : String
    , extract : Range -> String
    , edits : List SourceEdit
    , diagnostics : List Diagnostic
    , importedModules : List String
    , requiredAdapters : List String
    , constructors : List ConstructorInfo
    , recordAliases : List RecordAliasInfo
    , references : List Types.ResolvedReference
    , importFacts : List Types.ImportFact
    , ownDefinitions : Definitions
    , availableDefinitions : Dict String Definitions
    , imports : List ImportInfo
    , lookupTable : ModuleNameLookupTable
    , detectedPlatform : Platform
    }


type alias ImportInfo =
    { moduleName : String
    , alias : Maybe String
    , exposingList : Maybe Exposing
    }


implicitImportedModules : List String
implicitImportedModules =
    -- Elm injects these imports even when they do not appear in the source.
    -- List and Tuple are the two implicit modules whose representations need
    -- structural work when targeting Gren, so downstream mapping must see them.
    [ "List", "Tuple" ]


implicitRequiredAdapters : List String
implicitRequiredAdapters =
    [ "List", "Tuple" ]


moduleVisitor : Rule.ModuleRuleSchema schemaState ModuleContext -> Rule.ModuleRuleSchema { schemaState | hasAtLeastOneVisitor : () } ModuleContext
moduleVisitor schema =
    schema
        |> Rule.withImportVisitor importVisitor
        |> Rule.withDeclarationVisitor declarationVisitor
        |> Rule.withExpressionEnterVisitor expressionVisitor


fromProjectToModule : Rule.ContextCreator ProjectContext ModuleContext
fromProjectToModule =
    Rule.initContextCreator
        (\path moduleName extract ast lookupTable projectContext ->
            let
                qualifiedModuleName : String
                qualifiedModuleName =
                    String.join "." moduleName

                definitions : Definitions
                definitions =
                    definitionsFromAst qualifiedModuleName ast

                availableDefinitions : Dict String Definitions
                availableDefinitions =
                    Dict.insert qualifiedModuleName definitions projectContext.definitions
            in
            { path = path
            , moduleName = qualifiedModuleName
            , extract = extract
            , edits = []
            , diagnostics = List.reverse (diagnosticsForModuleDefinition ast.moduleDefinition)
            , importedModules = []
            , requiredAdapters = []
            , constructors = List.map constructorInfo definitions.constructors
            , recordAliases = definitions.recordAliases
            , references = []
            , importFacts = []
            , ownDefinitions = definitions
            , availableDefinitions = availableDefinitions
            , imports = List.map (Node.value >> importInfo) ast.imports
            , lookupTable = lookupTable
            , detectedPlatform = Types.Common
            }
        )
        |> Rule.withFilePath
        |> Rule.withModuleName
        |> Rule.withSourceCodeExtractor
        |> Rule.withFullAst
        |> Rule.withModuleNameLookupTable


fromModuleToProject : Rule.ContextCreator ModuleContext ProjectContext
fromModuleToProject =
    Rule.initContextCreator
        (\context ->
            { modules =
                Dict.singleton context.path
                    { path = context.path
                    , moduleName = context.moduleName
                    , edits = selectNonOverlapping context.edits
                    , diagnostics = List.reverse context.diagnostics
                    , importedModules = unique (implicitImportedModules ++ List.reverse context.importedModules)
                    , requiredAdapters = unique (implicitRequiredAdapters ++ List.reverse context.requiredAdapters)
                    , constructors = context.constructors
                    , recordAliases = context.recordAliases
                    , references = List.reverse context.references
                    , importFacts = List.reverse context.importFacts
                    , detectedPlatform = context.detectedPlatform
                    }
            , definitions = Dict.singleton context.moduleName context.ownDefinitions
            }
        )


foldProjectContexts : ProjectContext -> ProjectContext -> ProjectContext
foldProjectContexts newContext previousContext =
    { modules = Dict.union newContext.modules previousContext.modules
    , definitions = Dict.union newContext.definitions previousContext.definitions
    }


type alias Definitions =
    { constructors : List ConstructorDefinition
    , recordAliases : List RecordAliasInfo
    }


type alias ConstructorDefinition =
    { moduleName : String
    , typeName : String
    , name : String
    , arity : Int
    }


definitionsFromAst : String -> File -> Definitions
definitionsFromAst moduleName ast =
    List.foldl
        (\declarationNode definitions ->
            case Node.value declarationNode of
                CustomTypeDeclaration customType ->
                    { definitions
                        | constructors =
                            customType.constructors
                                |> List.map
                                    (\constructorNode ->
                                        let
                                            constructor =
                                                Node.value constructorNode
                                        in
                                        { moduleName = moduleName
                                        , typeName = Node.value customType.name
                                        , name = Node.value constructor.name
                                        , arity = List.length constructor.arguments
                                        }
                                    )
                                |> (++) definitions.constructors
                    }

                AliasDeclaration aliasDeclaration ->
                    case Node.value aliasDeclaration.typeAnnotation of
                        Record fields ->
                            { definitions
                                | recordAliases =
                                    { moduleName = moduleName
                                    , name = Node.value aliasDeclaration.name
                                    , fields = List.map (Node.value >> Tuple.first >> Node.value) fields
                                    }
                                        :: definitions.recordAliases
                            }

                        _ ->
                            definitions

                _ ->
                    definitions
        )
        { constructors = [], recordAliases = [] }
        ast.declarations


constructorInfo : ConstructorDefinition -> ConstructorInfo
constructorInfo definition =
    { moduleName = definition.moduleName
    , name = definition.name
    , arity = definition.arity
    }


importInfo : Import -> ImportInfo
importInfo import_ =
    { moduleName = import_.moduleName |> Node.value |> String.join "."
    , alias = import_.moduleAlias |> Maybe.map (Node.value >> String.join ".")
    , exposingList = Maybe.map Node.value import_.exposingList
    }


diagnosticsForModuleDefinition : Node Module -> List Diagnostic
diagnosticsForModuleDefinition (Node range moduleDefinition) =
    let
        moduleKindDiagnostics : List Diagnostic
        moduleKindDiagnostics =
            case moduleDefinition of
                PortModule _ ->
                    [ { code = "UNMAPPED_MODULE"
                      , severity = Types.Error
                      , message = "Elm port modules require an explicit Gren platform boundary."
                      , range = Just range
                      , help = Just "Replace ports with a Gren Node or browser API and provide a mapping for that boundary."
                      }
                    ]

                EffectModule _ ->
                    [ { code = "UNSUPPORTED_KERNEL"
                      , severity = Types.Error
                      , message = "Elm effect modules depend on privileged runtime and kernel APIs that packages cannot reproduce in Gren."
                      , range = Just range
                      , help = Just "Map this module to a Gren runtime package or replace the effect manager with ordinary Gren code."
                      }
                    ]

                NormalModule _ ->
                    []
    in
    moduleKindDiagnostics ++ reservedDiagnosticsForModule moduleDefinition


reservedDiagnosticsForModule : Module -> List Diagnostic
reservedDiagnosticsForModule moduleDefinition =
    let
        exposingList : Node Exposing
        exposingList =
            case moduleDefinition of
                NormalModule moduleData ->
                    moduleData.exposingList

                PortModule moduleData ->
                    moduleData.exposingList

                EffectModule moduleData ->
                    moduleData.exposingList

        effectManagerNames : List (Node String)
        effectManagerNames =
            case moduleDefinition of
                EffectModule moduleData ->
                    List.filterMap identity [ moduleData.command, moduleData.subscription ]

                _ ->
                    []
    in
    reservedDiagnosticsForExposing (Node.value exposingList)
        ++ List.filterMap reservedDiagnosticForNode effectManagerNames


reservedDiagnosticsForExposing : Exposing -> List Diagnostic
reservedDiagnosticsForExposing exposingList =
    case exposingList of
        All _ ->
            []

        Explicit exposed ->
            List.filterMap
                (\((Node range exposedValue) as exposedNode) ->
                    case exposedValue of
                        FunctionExpose name ->
                            if isReservedGrenIdentifier name then
                                Just (reservedIdentifierDiagnostic range name)

                            else
                                Nothing

                        _ ->
                            let
                                _ =
                                    exposedNode
                            in
                            Nothing
                )
                exposed


importVisitor : Node Import -> ModuleContext -> ( List (Rule.Error {}), ModuleContext )
importVisitor (Node range import_) context =
    let
        imported : String
        imported =
            import_.moduleName
                |> Node.value
                |> String.join "."

        platform : Platform
        platform =
            detectPlatform imported context.detectedPlatform

        adapters : List String
        adapters =
            if imported == "List" || imported == "Array" then
                imported :: context.requiredAdapters

            else
                context.requiredAdapters

        importFact : Types.ImportFact
        importFact =
            { range = range
            , moduleName = imported
            , alias = import_.moduleAlias |> Maybe.map (Node.value >> String.join ".")
            , exposingAll =
                case Maybe.map Node.value import_.exposingList of
                    Just (All _) ->
                        True

                    _ ->
                        False
            , exposed =
                case Maybe.map Node.value import_.exposingList of
                    Just (Explicit exposed) ->
                        List.map
                            (\exposedNode ->
                                { name = exposedItemName (Node.value exposedNode)
                                , text = context.extract (Node.range exposedNode)
                                }
                            )
                            exposed

                    _ ->
                        []
            }

        withImport : ModuleContext
        withImport =
            { context
                | importedModules = imported :: context.importedModules
                , requiredAdapters = adapters
                , detectedPlatform = platform
                , importFacts = importFact :: context.importFacts
            }

        withReservedDiagnostics : ModuleContext
        withReservedDiagnostics =
            import_.exposingList
                |> Maybe.map (Node.value >> reservedDiagnosticsForExposing)
                |> Maybe.withDefault []
                |> List.foldl addDiagnostic withImport
    in
    if isKernelModule imported then
        ( []
        , addDiagnostic
            { code = "UNSUPPORTED_KERNEL"
            , severity = Types.Error
            , message = "Elm kernel module imports cannot be transpiled to Gren package source."
            , range = Just range
            , help = Just "Map the owning Elm package to an analogous Gren package or replace the kernel call with a public Gren API."
            }
            withReservedDiagnostics
        )

    else
        ( [], withReservedDiagnostics )


detectPlatform : String -> Platform -> Platform
detectPlatform imported current =
    if current == Types.Browser then
        Types.Browser

    else if imported == "Browser" || String.startsWith "Browser." imported || imported == "Html" || String.startsWith "Html." imported || imported == "Svg" || String.startsWith "Svg." imported then
        Types.Browser

    else
        current


isKernelModule : String -> Bool
isKernelModule moduleName =
    moduleName
        == "Elm.Kernel"
        || String.startsWith "Elm.Kernel." moduleName
        || moduleName
        == "Native"
        || String.startsWith "Native." moduleName


isReservedGrenIdentifier : String -> Bool
isReservedGrenIdentifier name =
    -- `case` and `of` are Elm-only keywords. Gren replaces them with `when`
    -- and `is`, which are otherwise legal Elm identifiers.
    name == "when" || name == "is"


reservedIdentifierDiagnostic : Range -> String -> Diagnostic
reservedIdentifierDiagnostic range name =
    { code = "UNMAPPED_SYMBOL"
    , severity = Types.Error
    , message = "Elm identifier `" ++ name ++ "` is a reserved word in Gren."
    , range = Just range
    , help = Just "Rename this identifier consistently or provide an explicit symbol mapping."
    }


reservedDiagnosticForNode : Node String -> Maybe Diagnostic
reservedDiagnosticForNode (Node range name) =
    if isReservedGrenIdentifier name then
        Just (reservedIdentifierDiagnostic range name)

    else
        Nothing


addReservedIdentifier : Range -> String -> ModuleContext -> ModuleContext
addReservedIdentifier range name context =
    if isReservedGrenIdentifier name then
        addDiagnostic (reservedIdentifierDiagnostic range name) context

    else
        context


addReservedIdentifierNode : Node String -> ModuleContext -> ModuleContext
addReservedIdentifierNode (Node range name) context =
    addReservedIdentifier range name context


collectRecordSetterName : Node Elm.Syntax.Expression.RecordSetter -> ModuleContext -> ModuleContext
collectRecordSetterName (Node _ ( fieldName, _ )) context =
    addReservedIdentifierNode fieldName context


collectRecordTypeField : Node ( Node String, Node TypeAnnotation ) -> ModuleContext -> ModuleContext
collectRecordTypeField (Node _ ( fieldName, fieldType )) context =
    context
        |> addReservedIdentifierNode fieldName
        |> collectTypeAnnotation fieldType


declarationVisitor : Node Declaration -> Rule.Direction -> ModuleContext -> ( List (Rule.Error {}), ModuleContext )
declarationVisitor (Node range declaration) direction context =
    case direction of
        Rule.OnExit ->
            ( [], context )

        Rule.OnEnter ->
            case declaration of
                FunctionDeclaration function ->
                    let
                        implementation =
                            Node.value function.declaration

                        withFunctionName : ModuleContext
                        withFunctionName =
                            addReservedIdentifierNode implementation.name context

                        withSignature : ModuleContext
                        withSignature =
                            case function.signature of
                                Just signatureNode ->
                                    collectTypeAnnotation (Node.value signatureNode).typeAnnotation withFunctionName

                                Nothing ->
                                    withFunctionName
                    in
                    ( [], List.foldl collectPattern withSignature implementation.arguments )

                AliasDeclaration aliasDeclaration ->
                    ( []
                    , aliasDeclaration.generics
                        |> List.foldl addReservedIdentifierNode context
                        |> collectTypeAnnotation aliasDeclaration.typeAnnotation
                    )

                CustomTypeDeclaration customType ->
                    let
                        withGenerics : ModuleContext
                        withGenerics =
                            List.foldl addReservedIdentifierNode context customType.generics

                        withTypes : ModuleContext
                        withTypes =
                            customType.constructors
                                |> List.concatMap (Node.value >> .arguments)
                                |> List.foldl collectTypeAnnotation withGenerics

                        withConstructorShapes : ModuleContext
                        withConstructorShapes =
                            List.foldl collectConstructorDefinition withTypes customType.constructors
                    in
                    ( [], withConstructorShapes )

                PortDeclaration signature ->
                    ( []
                    , context
                        |> addReservedIdentifierNode signature.name
                        |> collectTypeAnnotation signature.typeAnnotation
                        |> addDiagnostic
                            { code = "UNMAPPED_SYMBOL"
                            , severity = Types.Error
                            , message = "Elm ports need a Gren-specific implementation."
                            , range = Just range
                            , help = Just "Replace this port with an explicit Gren Node or browser API boundary."
                            }
                    )

                Destructuring pattern _ ->
                    ( [], collectPattern pattern context )

                InfixDeclaration _ ->
                    ( [], context )


expressionVisitor : Node Expression -> ModuleContext -> ( List (Rule.Error {}), ModuleContext )
expressionVisitor ((Node range expression) as expressionNode) context =
    case expression of
        UnitExpr ->
            ( [], addEdit Types.Unit range "{}" context )

        TupledExpression members ->
            ( [], addTupleEdits Types.TupleExpression "=" range members context )

        Application _ ->
            -- Constructor and record-alias references are replaced at the
            -- reference itself. This preserves partial application and lets
            -- edits inside arguments compose normally.
            ( [], context )

        CaseExpression caseBlock ->
            ( [], collectCaseExpression range caseBlock context )

        OperatorApplication "::" _ left right ->
            ( [], addConsExpressionEdits left right context )

        PrefixOperator "::" ->
            -- `(::)` as a function value; same argument order as pushFirst.
            ( [], addEdit Types.ListConsExpression range "Array.pushFirst" context )

        LambdaExpression lambda ->
            ( [], List.foldl collectPattern context lambda.args )

        LetExpression letBlock ->
            ( [], List.foldl collectLetDeclaration context letBlock.declarations )

        GLSLExpression _ ->
            ( []
            , addDiagnostic
                { code = "UNSUPPORTED_GLSL"
                , severity = Types.Error
                , message = "Elm GLSL shader expressions have no Gren equivalent."
                , range = Just range
                , help = Just "Move the shader behind a Gren-compatible native boundary or replace it with a supported renderer."
                }
                context
            )

        RecordExpr setters ->
            ( [], List.foldl collectRecordSetterName context setters )

        RecordAccess _ fieldName ->
            ( [], addReservedIdentifierNode fieldName context )

        RecordAccessFunction fieldName ->
            ( [], addReservedIdentifier range fieldName context )

        RecordUpdateExpression recordName setters ->
            ( []
            , setters
                |> List.foldl collectRecordSetterName (addReservedIdentifierNode recordName context)
            )

        FunctionOrValue moduleParts name ->
            if isReservedGrenIdentifier name then
                ( [], addReservedIdentifier range name context )

            else if isKernelModule (String.join "." moduleParts) then
                ( []
                , addDiagnostic
                    { code = "UNSUPPORTED_KERNEL"
                    , severity = Types.Error
                    , message = "Elm kernel calls cannot be emitted as portable Gren package code."
                    , range = Just range
                    , help = Just "Map this call to a public Gren API or map the owning package to an analogous Gren package."
                    }
                    context
                )

            else
                let
                    withReference : ModuleContext
                    withReference =
                        addResolvedReference expressionNode name False context
                in
                case resolveReference expressionNode moduleParts name withReference of
                    Resolved (ConstructorReference constructor) ->
                        if constructor.arity > 1 then
                            ( [], addEdit Types.CustomConstructor range (constructorFunction context.extract range constructor.arity) withReference )

                        else
                            ( [], withReference )

                    Resolved (RecordAliasReference aliasInfo) ->
                        if List.isEmpty aliasInfo.fields then
                            ( [], addEdit Types.RecordAliasConstructor range "{}" withReference )

                        else
                            ( [], addEdit Types.RecordAliasConstructor range (recordAliasFunction aliasInfo.fields) withReference )

                    AmbiguousReference modules ->
                        ( [], addAmbiguousReferenceDiagnostic range name modules withReference )

                    UnresolvedReference ->
                        ( [], withReference )

        _ ->
            -- Child expressions are visited by elm-review.  Keeping this rule
            -- focused on syntax with different Gren representations prevents
            -- broad source rewrites from touching strings or comments.
            let
                _ =
                    expressionNode
            in
            ( [], context )


collectCaseExpression : Range -> Elm.Syntax.Expression.CaseBlock -> ModuleContext -> ModuleContext
collectCaseExpression range caseBlock context =
    let
        caseKeywordRange : Range
        caseKeywordRange =
            { start = range.start
            , end = { row = range.start.row, column = range.start.column + 4 }
            }

        withKeyword : ModuleContext
        withKeyword =
            addEdit Types.CaseKeyword caseKeywordRange "when" context

        patterns : List (Node Pattern)
        patterns =
            List.map Tuple.first caseBlock.cases
    in
    if List.any isUnconsPattern patterns && List.all canRewriteArrayCasePattern patterns then
        caseBlock.cases
            |> List.foldl collectArrayCase
                (addCallAroundExpression Types.ListConsExpression "Array.popFirst" caseBlock.expression withKeyword)

    else if isTupleListCase caseBlock then
        collectTupleListCase caseBlock withKeyword

    else if isMaybeUnconsCase patterns then
        caseBlock.cases
            |> List.foldl collectMaybeUnconsCase
                (addCallAroundExpression Types.ListConsExpression "Maybe.map Array.popFirst" caseBlock.expression withKeyword)

    else
        List.foldl collectPattern withKeyword patterns


isUnconsPattern : Node Pattern -> Bool
isUnconsPattern patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        UnConsPattern _ _ ->
            True

        AsPattern inner _ ->
            case asUnconsParts inner of
                Just _ ->
                    True

                Nothing ->
                    False

        _ ->
            False


unwrapParenthesized : Node Pattern -> Node Pattern
unwrapParenthesized ((Node _ pattern) as patternNode) =
    case pattern of
        ParenthesizedPattern inner ->
            unwrapParenthesized inner

        _ ->
            patternNode


{-| An uncons wrapped by an `as` binding is rewritable when the head is a
plain variable (so the original list can be rebuilt with `Array.pushFirst`)
and the tail is a variable or wildcard.
-}
asUnconsParts : Node Pattern -> Maybe { left : Node Pattern, right : Node Pattern, headName : String }
asUnconsParts inner =
    case Node.value (unwrapParenthesized inner) of
        UnConsPattern left right ->
            case ( Node.value left, Node.value right ) of
                ( VarPattern headName, VarPattern _ ) ->
                    Just { left = left, right = right, headName = headName }

                ( VarPattern headName, AllPattern ) ->
                    Just { left = left, right = right, headName = headName }

                _ ->
                    Nothing

        _ ->
            Nothing


canRewriteArrayCasePattern : Node Pattern -> Bool
canRewriteArrayCasePattern (Node _ pattern) =
    case pattern of
        ListPattern members ->
            not (List.any patternContainsUncons members)

        ParenthesizedPattern inner ->
            canRewriteArrayCasePattern inner

        AllPattern ->
            True

        UnConsPattern left right ->
            not (patternContainsUncons left) && isRestArrayPattern right

        AsPattern inner _ ->
            asUnconsParts inner /= Nothing

        _ ->
            False


isRestArrayPattern : Node Pattern -> Bool
isRestArrayPattern (Node _ pattern) =
    case pattern of
        AllPattern ->
            True

        VarPattern _ ->
            True

        ListPattern [] ->
            True

        AsPattern inner _ ->
            isRestArrayPattern inner

        ParenthesizedPattern inner ->
            isRestArrayPattern inner

        _ ->
            False


patternContainsUncons : Node Pattern -> Bool
patternContainsUncons (Node _ pattern) =
    case pattern of
        UnConsPattern _ _ ->
            True

        TuplePattern members ->
            List.any patternContainsUncons members

        ListPattern members ->
            List.any patternContainsUncons members

        NamedPattern _ members ->
            List.any patternContainsUncons members

        AsPattern inner _ ->
            patternContainsUncons inner

        ParenthesizedPattern inner ->
            patternContainsUncons inner

        _ ->
            False


collectArrayCase : ( Node Pattern, Node Expression ) -> ModuleContext -> ModuleContext
collectArrayCase ( patternNode, body ) context =
    case Node.value patternNode of
        AsPattern inner asName ->
            collectAsUnconsPattern patternNode inner asName body context

        _ ->
            collectArrayCasePattern patternNode context


collectArrayCasePattern : Node Pattern -> ModuleContext -> ModuleContext
collectArrayCasePattern ((Node range pattern) as patternNode) context =
    case pattern of
        ListPattern [] ->
            addEdit Types.ListConsPattern range "Nothing" context

        ListPattern (first :: remaining) ->
            collectFixedListPattern range first remaining context

        AllPattern ->
            -- `_` matches the popFirst Maybe unchanged.
            context

        ParenthesizedPattern inner ->
            collectArrayCasePattern inner context

        UnConsPattern left right ->
            context
                |> addInsertion Types.ListConsPattern (Node.range left).start "Just { first = "
                |> addConsSeparatorEdit Types.ListConsPattern left right ", rest = "
                |> addInsertion Types.ListConsPattern (Node.range right).end " }"
                |> collectPattern left
                |> collectPattern right

        _ ->
            collectPattern patternNode context


{-| Rewrite a fixed-length list pattern in an `Array.popFirst` context:
`[ x ]` becomes `Just { first = x, rest = [] }` and `[ x, y ]` becomes
`Just { first = x, rest = [ y ] }`.
-}
collectFixedListPattern : Range -> Node Pattern -> List (Node Pattern) -> ModuleContext -> ModuleContext
collectFixedListPattern range first remaining context =
    let
        openRange : Range
        openRange =
            { start = range.start
            , end = { row = range.start.row, column = range.start.column + 1 }
            }

        closeRange : Range
        closeRange =
            { start = { row = range.end.row, column = range.end.column - 1 }
            , end = range.end
            }

        withDelimiters : ModuleContext
        withDelimiters =
            case remaining of
                [] ->
                    context
                        |> addEdit Types.ListConsPattern openRange "Just { first = "
                        |> addEdit Types.ListConsPattern closeRange ", rest = [] }"

                second :: _ ->
                    context
                        |> addEdit Types.ListConsPattern openRange "Just { first = "
                        |> addEdit Types.ListConsPattern (separatorTokenRange first second context [ ',' ]) ", rest = ["
                        |> addEdit Types.ListConsPattern closeRange "] }"
    in
    List.foldl collectPattern withDelimiters (first :: remaining)


{-| Rewrite `(q :: _) as qs` in an `Array.popFirst` context. The pattern
becomes `(Just { first = q, rest = rest_elmToGren })` and the branch body is
prefixed with `let qs = Array.pushFirst q rest_elmToGren in`, which rebuilds
the value the `as` binding used to capture.
-}
collectAsUnconsPattern : Node Pattern -> Node Pattern -> Node String -> Node Expression -> ModuleContext -> ModuleContext
collectAsUnconsPattern patternNode inner asName body context =
    case asUnconsParts inner of
        Nothing ->
            collectPattern patternNode context

        Just parts ->
            let
                restName : String
                restName =
                    case Node.value parts.right of
                        VarPattern name ->
                            name

                        _ ->
                            -- Derived from the as-name so nested as-uncons
                            -- rewrites never shadow each other.
                            Node.value asName ++ "_rest_elmToGren"

                withRestName : ModuleContext -> ModuleContext
                withRestName =
                    case Node.value parts.right of
                        AllPattern ->
                            addEdit Types.ListConsPattern (Node.range parts.right) restName

                        _ ->
                            identity

                letPrefix : String
                letPrefix =
                    -- The body moves to its own line at its original column,
                    -- so bodies that start with `let`/`case` keep valid
                    -- layout.
                    "let "
                        ++ Node.value asName
                        ++ " = Array.pushFirst "
                        ++ parts.headName
                        ++ " "
                        ++ restName
                        ++ " in\n"
                        ++ String.repeat ((Node.range body).start.column - 1) " "
            in
            context
                |> addReservedIdentifierNode asName
                |> collectPattern parts.left
                |> collectPattern parts.right
                |> addInsertion Types.ListConsPattern (Node.range parts.left).start "Just { first = "
                |> addConsSeparatorEdit Types.ListConsPattern parts.left parts.right ", rest = "
                |> withRestName
                |> addInsertion Types.ListConsPattern (Node.range parts.right).end " }"
                |> addEdit Types.ListConsPattern
                    { start = (Node.range inner).end, end = (Node.range asName).end }
                    ""
                |> addInsertion Types.ListConsExpression (Node.range body).start letPrefix


{-| A case over a literal tuple of lists where every branch matches the
components with `[]`, `_`, or a rewritable uncons. Each tuple component is
wrapped in `Array.popFirst` and each component pattern is rewritten in place,
which preserves top-to-bottom match order exactly.
-}
isTupleListCase : Elm.Syntax.Expression.CaseBlock -> Bool
isTupleListCase caseBlock =
    case Node.value caseBlock.expression of
        TupledExpression members ->
            let
                arity : Int
                arity =
                    List.length members

                patterns : List (Node Pattern)
                patterns =
                    List.map Tuple.first caseBlock.cases

                componentOk : Node Pattern -> Bool
                componentOk (Node _ component) =
                    case component of
                        ListPattern comps ->
                            not (List.any patternContainsUncons comps)

                        AllPattern ->
                            True

                        UnConsPattern left right ->
                            not (patternContainsUncons left) && isRestArrayPattern right

                        _ ->
                            False

                patternOk : Node Pattern -> Bool
                patternOk (Node _ pattern) =
                    case pattern of
                        AllPattern ->
                            True

                        TuplePattern comps ->
                            List.length comps == arity && List.all componentOk comps

                        _ ->
                            False

                hasComponentUncons : Node Pattern -> Bool
                hasComponentUncons (Node _ pattern) =
                    case pattern of
                        TuplePattern comps ->
                            List.any patternContainsUncons comps

                        _ ->
                            False
            in
            List.any hasComponentUncons patterns && List.all patternOk patterns

        _ ->
            False


collectTupleListCase : Elm.Syntax.Expression.CaseBlock -> ModuleContext -> ModuleContext
collectTupleListCase caseBlock context =
    let
        patterns : List (Node Pattern)
        patterns =
            List.map Tuple.first caseBlock.cases

        -- A column whose pattern is `_` in every branch may not be a list at
        -- all, so only wrap columns that some branch matches as a list.
        columnHasListEvidence : Int -> Bool
        columnHasListEvidence index =
            List.any
                (\(Node _ pattern) ->
                    case pattern of
                        TuplePattern comps ->
                            case comps |> List.drop index |> List.head of
                                Just (Node _ component) ->
                                    case component of
                                        ListPattern _ ->
                                            True

                                        UnConsPattern _ _ ->
                                            True

                                        _ ->
                                            False

                                Nothing ->
                                    False

                        _ ->
                            False
                )
                patterns

        withScrutinee : ModuleContext
        withScrutinee =
            case Node.value caseBlock.expression of
                TupledExpression members ->
                    members
                        |> List.indexedMap (\index member -> ( index, member ))
                        |> List.foldl
                            (\( index, member ) found ->
                                if columnHasListEvidence index then
                                    addCallAroundExpression Types.ListConsExpression "Array.popFirst" member found

                                else
                                    found
                            )
                            context

                _ ->
                    context
    in
    caseBlock.cases
        |> List.foldl
            (\( patternNode, _ ) found ->
                case Node.value patternNode of
                    TuplePattern comps ->
                        let
                            withTuple : ModuleContext
                            withTuple =
                                addTupleEdits Types.TuplePattern "=" (Node.range patternNode) comps found
                        in
                        List.foldl collectArrayCasePattern withTuple comps

                    _ ->
                        found
            )
            withScrutinee


{-| A case over a `Maybe (List a)` whose branches are `Nothing`, `Just []`,
`Just (x :: xs)` (plus optionally `_`). The scrutinee is wrapped in
`Maybe.map Array.popFirst` and the inner list patterns are rewritten in place.
-}
isMaybeUnconsCase : List (Node Pattern) -> Bool
isMaybeUnconsCase patterns =
    let
        innerOk : Node Pattern -> Bool
        innerOk inner =
            case Node.value (unwrapParenthesized inner) of
                ListPattern comps ->
                    not (List.any patternContainsUncons comps)

                AllPattern ->
                    True

                UnConsPattern left right ->
                    not (patternContainsUncons left) && isRestArrayPattern right

                _ ->
                    False

        isMaybeName : { moduleName : List String, name : String } -> String -> Bool
        isMaybeName qualifiedName expected =
            qualifiedName.name
                == expected
                && (qualifiedName.moduleName == [] || qualifiedName.moduleName == [ "Maybe" ])

        patternOk : Node Pattern -> Bool
        patternOk (Node _ pattern) =
            case pattern of
                AllPattern ->
                    True

                NamedPattern qualifiedName [] ->
                    isMaybeName qualifiedName "Nothing"

                NamedPattern qualifiedName [ inner ] ->
                    isMaybeName qualifiedName "Just" && innerOk inner

                _ ->
                    False

        hasInnerUncons : Node Pattern -> Bool
        hasInnerUncons (Node _ pattern) =
            case pattern of
                NamedPattern _ [ inner ] ->
                    case Node.value (unwrapParenthesized inner) of
                        UnConsPattern _ _ ->
                            True

                        _ ->
                            False

                _ ->
                    False
    in
    List.any hasInnerUncons patterns && List.all patternOk patterns


collectMaybeUnconsCase : ( Node Pattern, Node Expression ) -> ModuleContext -> ModuleContext
collectMaybeUnconsCase ( patternNode, _ ) context =
    case Node.value patternNode of
        NamedPattern _ [ inner ] ->
            case Node.value inner of
                ListPattern (_ :: _) ->
                    -- The rewrite turns `[ x ]` into a constructor
                    -- application, which needs parentheses under `Just`.
                    context
                        |> addInsertion Types.ListConsPattern (Node.range inner).start "("
                        |> addInsertion Types.ListConsPattern (Node.range inner).end ")"
                        |> collectArrayCasePattern inner

                _ ->
                    collectArrayCasePattern inner context

        _ ->
            context


addCallAroundExpression : EditKind -> String -> Node Expression -> ModuleContext -> ModuleContext
addCallAroundExpression kind functionName expressionNode context =
    context
        |> addInsertion kind (Node.range expressionNode).start (functionName ++ " (")
        |> addInsertion kind (Node.range expressionNode).end ")"


addConsExpressionEdits : Node Expression -> Node Expression -> ModuleContext -> ModuleContext
addConsExpressionEdits left right context =
    context
        |> addInsertion Types.ListConsExpression (Node.range left).start "Array.pushFirst ("
        |> addConsSeparatorEdit Types.ListConsExpression left right ") ("
        |> addInsertion Types.ListConsExpression (Node.range right).end ")"


addConsSeparatorEdit : EditKind -> Node left -> Node right -> String -> ModuleContext -> ModuleContext
addConsSeparatorEdit kind left right replacement context =
    addEdit kind (consOperatorRange left right context) replacement context


consOperatorRange : Node left -> Node right -> ModuleContext -> Range
consOperatorRange left right context =
    separatorTokenRange left right context [ ':', ':' ]


{-| The range of a separator token (`::` or `,`) in the gap between two
sibling nodes, skipping comments.
-}
separatorTokenRange : Node left -> Node right -> ModuleContext -> List Char -> Range
separatorTokenRange left right context needle =
    let
        gapRange : Range
        gapRange =
            { start = (Node.range left).end
            , end = (Node.range right).start
            }

        gap : String
        gap =
            context.extract gapRange
    in
    case scanForToken needle 0 (String.toList gap) of
        Just offset ->
            let
                start : Location
                start =
                    advanceLocation gapRange.start (String.left offset gap)
            in
            { start = start
            , end = { row = start.row, column = start.column + List.length needle }
            }

        Nothing ->
            -- The AST guarantees the separator in this gap. Keeping the full
            -- gap as a fallback still emits valid Gren if a future parser
            -- represents trivia differently.
            gapRange


scanForToken : List Char -> Int -> List Char -> Maybe Int
scanForToken needle offset characters =
    case characters of
        '-' :: '-' :: remaining ->
            scanTokenLineComment needle (offset + 2) remaining

        '{' :: '-' :: remaining ->
            scanTokenBlockComment needle 1 (offset + 2) remaining

        _ :: remaining ->
            if startsWithChars needle characters then
                Just offset

            else
                scanForToken needle (offset + 1) remaining

        [] ->
            Nothing


startsWithChars : List Char -> List Char -> Bool
startsWithChars needle characters =
    case ( needle, characters ) of
        ( [], _ ) ->
            True

        ( expected :: needleRest, actual :: charactersRest ) ->
            expected == actual && startsWithChars needleRest charactersRest

        ( _ :: _, [] ) ->
            False


scanTokenLineComment : List Char -> Int -> List Char -> Maybe Int
scanTokenLineComment needle offset characters =
    case characters of
        '\u{000D}' :: '\n' :: remaining ->
            scanForToken needle (offset + 2) remaining

        '\u{000D}' :: remaining ->
            scanForToken needle (offset + 1) remaining

        '\n' :: remaining ->
            scanForToken needle (offset + 1) remaining

        _ :: remaining ->
            scanTokenLineComment needle (offset + 1) remaining

        [] ->
            Nothing


scanTokenBlockComment : List Char -> Int -> Int -> List Char -> Maybe Int
scanTokenBlockComment needle depth offset characters =
    case characters of
        '{' :: '-' :: remaining ->
            scanTokenBlockComment needle (depth + 1) (offset + 2) remaining

        '-' :: '}' :: remaining ->
            if depth == 1 then
                scanForToken needle (offset + 2) remaining

            else
                scanTokenBlockComment needle (depth - 1) (offset + 2) remaining

        _ :: remaining ->
            scanTokenBlockComment needle depth (offset + 1) remaining

        [] ->
            Nothing


advanceLocation : Location -> String -> Location
advanceLocation initial text =
    advanceLocationHelp initial (String.toList text)


advanceLocationHelp : Location -> List Char -> Location
advanceLocationHelp location characters =
    case characters of
        '\u{000D}' :: '\n' :: remaining ->
            advanceLocationHelp { row = location.row + 1, column = 1 } remaining

        '\u{000D}' :: remaining ->
            advanceLocationHelp { row = location.row + 1, column = 1 } remaining

        '\n' :: remaining ->
            advanceLocationHelp { row = location.row + 1, column = 1 } remaining

        _ :: remaining ->
            advanceLocationHelp { location | column = location.column + 1 } remaining

        [] ->
            location


type ReferenceResolution
    = Resolved ReferenceDefinition
    | AmbiguousReference (List String)
    | UnresolvedReference


type ReferenceDefinition
    = ConstructorReference ConstructorDefinition
    | RecordAliasReference RecordAliasInfo


resolveReference : Node value -> List String -> String -> ModuleContext -> ReferenceResolution
resolveReference referenceNode moduleParts name context =
    let
        candidates : List ReferenceDefinition
        candidates =
            case ModuleNameLookupTable.fullModuleNameFor context.lookupTable referenceNode of
                Just definingModule ->
                    context.availableDefinitions
                        |> Dict.get (String.join "." definingModule)
                        |> Maybe.map (referencesNamed name)
                        |> Maybe.withDefault []

                Nothing ->
                    -- Invalid/incomplete projects can lack lookup information.
                    -- Keep an import-aware fallback so extraction still emits a
                    -- useful unresolved/ambiguous diagnostic instead of guessing.
                    referenceCandidatesFromImports moduleParts name context

        uniqueCandidates : List ReferenceDefinition
        uniqueCandidates =
            uniqueReferences candidates
    in
    case uniqueCandidates of
        [ definition ] ->
            Resolved definition

        [] ->
            UnresolvedReference

        _ ->
            AmbiguousReference (List.map referenceModuleName uniqueCandidates |> unique)


referenceCandidatesFromImports : List String -> String -> ModuleContext -> List ReferenceDefinition
referenceCandidatesFromImports moduleParts name context =
    let
        localCandidates : List ReferenceDefinition
        localCandidates =
            referencesNamed name context.ownDefinitions
    in
    if List.isEmpty moduleParts then
        if List.isEmpty localCandidates then
            context.imports
                |> List.concatMap
                    (\import_ ->
                        context.availableDefinitions
                            |> Dict.get import_.moduleName
                            |> Maybe.map (referencesNamed name >> List.filter (referenceIsExposed import_))
                            |> Maybe.withDefault []
                    )

        else
            localCandidates

    else
        definitionsForQualifier (String.join "." moduleParts) context
            |> List.concatMap (referencesNamed name)


definitionsForQualifier : String -> ModuleContext -> List Definitions
definitionsForQualifier qualifier context =
    let
        moduleNames : List String
        moduleNames =
            if qualifier == context.moduleName then
                [ context.moduleName ]

            else
                context.imports
                    |> List.filter
                        (\import_ -> import_.moduleName == qualifier || import_.alias == Just qualifier)
                    |> List.map .moduleName
                    |> unique
    in
    List.filterMap (\moduleName -> Dict.get moduleName context.availableDefinitions) moduleNames


referencesNamed : String -> Definitions -> List ReferenceDefinition
referencesNamed name definitions =
    List.map ConstructorReference (List.filter (\definition -> definition.name == name) definitions.constructors)
        ++ List.map RecordAliasReference (List.filter (\definition -> definition.name == name) definitions.recordAliases)


referenceIsExposed : ImportInfo -> ReferenceDefinition -> Bool
referenceIsExposed import_ definition =
    case import_.exposingList of
        Nothing ->
            False

        Just (All _) ->
            True

        Just (Explicit exposed) ->
            List.any (Node.value >> exposesReference definition) exposed


exposesReference : ReferenceDefinition -> TopLevelExpose -> Bool
exposesReference definition exposed =
    case ( definition, exposed ) of
        ( ConstructorReference constructor, TypeExpose exposedType ) ->
            exposedType.name == constructor.typeName && exposedType.open /= Nothing

        ( RecordAliasReference aliasInfo, TypeOrAliasExpose name ) ->
            name == aliasInfo.name

        ( RecordAliasReference aliasInfo, TypeExpose exposedType ) ->
            exposedType.name == aliasInfo.name

        _ ->
            False


uniqueReferences : List ReferenceDefinition -> List ReferenceDefinition
uniqueReferences references =
    List.foldl
        (\reference found ->
            if List.any (sameReference reference) found then
                found

            else
                reference :: found
        )
        []
        references
        |> List.reverse


sameReference : ReferenceDefinition -> ReferenceDefinition -> Bool
sameReference left right =
    referenceModuleName left
        == referenceModuleName right
        && referenceName left
        == referenceName right


referenceModuleName : ReferenceDefinition -> String
referenceModuleName reference =
    case reference of
        ConstructorReference definition ->
            definition.moduleName

        RecordAliasReference definition ->
            definition.moduleName


referenceName : ReferenceDefinition -> String
referenceName reference =
    case reference of
        ConstructorReference definition ->
            definition.name

        RecordAliasReference definition ->
            definition.name


{-| Record every reference the lookup table can resolve to a canonical module.
The host decides which references the mapping catalog rewrites; locals resolve
to the module under review, which the catalog never contains.
-}
addResolvedReference : Node a -> String -> Bool -> ModuleContext -> ModuleContext
addResolvedReference node name isType context =
    case ModuleNameLookupTable.fullModuleNameFor context.lookupTable node of
        Just definingModule ->
            let
                nodeRange : Range
                nodeRange =
                    Node.range node
            in
            { context
                | references =
                    { range = nodeRange
                    , moduleName = String.join "." definingModule
                    , name = name
                    , text = context.extract nodeRange
                    , isType = isType
                    }
                        :: context.references
            }

        Nothing ->
            context


exposedItemName : TopLevelExpose -> String
exposedItemName exposed =
    case exposed of
        InfixExpose operator ->
            "(" ++ operator ++ ")"

        FunctionExpose name ->
            name

        TypeOrAliasExpose name ->
            name

        TypeExpose exposedType ->
            exposedType.name


addAmbiguousReferenceDiagnostic : Range -> String -> List String -> ModuleContext -> ModuleContext
addAmbiguousReferenceDiagnostic range name modules context =
    addDiagnostic
        { code = "UNMAPPED_SYMBOL"
        , severity = Types.Error
        , message = "The constructor reference `" ++ name ++ "` is ambiguous across imported modules."
        , range = Just range
        , help = Just ("Qualify the constructor with one of: " ++ String.join ", " modules)
        }
        context


constructorFunction : (Range -> String) -> Range -> Int -> String
constructorFunction extract range arity =
    let
        arguments : List String
        arguments =
            List.range 1 arity |> List.map (\index -> "arg" ++ String.fromInt index ++ "_elmToGren")

        fields : String
        fields =
            arguments
                |> List.indexedMap (\index argument -> fieldLabel index ++ " = " ++ argument)
                |> String.join ", "
    in
    "(\\" ++ String.join " " arguments ++ " -> " ++ extract range ++ " { " ++ fields ++ " })"


recordAliasFunction : List String -> String
recordAliasFunction fields =
    let
        arguments : List String
        arguments =
            List.indexedMap (\index _ -> "arg" ++ String.fromInt (index + 1) ++ "_elmToGren") fields

        entries : String
        entries =
            List.map2 (\field argument -> field ++ " = " ++ argument) fields arguments
                |> String.join ", "
    in
    "(\\" ++ String.join " " arguments ++ " -> { " ++ entries ++ " })"


collectConstructorDefinition : Node ValueConstructor -> ModuleContext -> ModuleContext
collectConstructorDefinition (Node _ constructor) context =
    if List.length constructor.arguments > 1 then
        addPayloadEdits Types.CustomType ":" constructor.arguments context

    else
        context


collectLetDeclaration : Node LetDeclaration -> ModuleContext -> ModuleContext
collectLetDeclaration (Node _ declaration) context =
    case declaration of
        LetFunction function ->
            let
                implementation =
                    Node.value function.declaration

                withFunctionName : ModuleContext
                withFunctionName =
                    addReservedIdentifierNode implementation.name context

                withSignature : ModuleContext
                withSignature =
                    case function.signature of
                        Just signatureNode ->
                            collectTypeAnnotation (Node.value signatureNode).typeAnnotation withFunctionName

                        Nothing ->
                            withFunctionName
            in
            List.foldl collectPattern withSignature implementation.arguments

        LetDestructuring pattern _ ->
            collectPattern pattern context


collectPattern : Node Pattern -> ModuleContext -> ModuleContext
collectPattern ((Node range pattern) as patternNode) context =
    case pattern of
        UnitPattern ->
            addEdit Types.Unit range "{}" context

        TuplePattern members ->
            let
                withTuple : ModuleContext
                withTuple =
                    addTupleEdits Types.TuplePattern "=" range members context
            in
            List.foldl collectPattern withTuple members

        RecordPattern fieldNames ->
            List.foldl addReservedIdentifierNode context fieldNames

        UnConsPattern left right ->
            let
                withChildren : ModuleContext
                withChildren =
                    collectPattern right (collectPattern left context)
            in
            addDiagnostic
                { code = "UNMAPPED_SYMBOL"
                , severity = Types.Error
                , message = "A List (::) pattern needs control-flow restructuring for Gren arrays."
                , range = Just range
                , help = Just "Match on Array.popFirst and destructure its { first, rest } record."
                }
                withChildren

        ListPattern members ->
            List.foldl collectPattern context members

        VarPattern name ->
            addReservedIdentifier range name context

        NamedPattern qualifiedName members ->
            let
                withChildren : ModuleContext
                withChildren =
                    List.foldl collectPattern context members
            in
            case resolveReference patternNode qualifiedName.moduleName qualifiedName.name context of
                Resolved (ConstructorReference constructor) ->
                    if constructor.arity > 1 && constructor.arity == List.length members then
                        addPayloadEdits Types.CustomConstructor "=" members withChildren

                    else if constructor.arity /= List.length members then
                        addConstructorArityDiagnostic range qualifiedName.name constructor.arity (List.length members) withChildren

                    else
                        withChildren

                Resolved (RecordAliasReference _) ->
                    addDiagnostic
                        { code = "UNMAPPED_SYMBOL"
                        , severity = Types.Error
                        , message = "Record alias constructors cannot be used as patterns in Gren."
                        , range = Just range
                        , help = Just "Destructure the record by its fields instead."
                        }
                        withChildren

                AmbiguousReference modules ->
                    addAmbiguousReferenceDiagnostic range qualifiedName.name modules withChildren

                UnresolvedReference ->
                    if List.length members > 1 then
                        addDiagnostic
                            { code = "UNMAPPED_SYMBOL"
                            , severity = Types.Error
                            , message = "The multi-argument constructor pattern `" ++ qualifiedName.name ++ "` could not be resolved safely."
                            , range = Just range
                            , help = Just "Provide a mapping for the dependency constructor or include its Elm source in the package graph."
                            }
                            withChildren

                    else
                        withChildren

        AsPattern inner aliasName ->
            context
                |> addReservedIdentifierNode aliasName
                |> collectPattern inner

        ParenthesizedPattern inner ->
            collectPattern inner context

        _ ->
            let
                _ =
                    patternNode
            in
            context


collectTypeAnnotation : Node TypeAnnotation -> ModuleContext -> ModuleContext
collectTypeAnnotation (Node range annotation) context =
    case annotation of
        Unit ->
            addEdit Types.Unit range "{}" context

        Tupled members ->
            let
                withTuple : ModuleContext
                withTuple =
                    addTupleEdits Types.TupleType ":" range members context
            in
            List.foldl collectTypeAnnotation withTuple members

        Typed typeNode arguments ->
            let
                withReference : ModuleContext
                withReference =
                    addResolvedReference typeNode (Tuple.second (Node.value typeNode)) True context
            in
            List.foldl collectTypeAnnotation withReference arguments

        Record fields ->
            List.foldl collectRecordTypeField context fields

        GenericRecord extensionName fieldsNode ->
            fieldsNode
                |> Node.value
                |> List.foldl collectRecordTypeField (addReservedIdentifierNode extensionName context)

        FunctionTypeAnnotation left right ->
            collectTypeAnnotation right (collectTypeAnnotation left context)

        GenericType name ->
            addReservedIdentifier range name context


addTupleEdits : EditKind -> String -> Range -> List (Node value) -> ModuleContext -> ModuleContext
addTupleEdits kind separator range members context =
    case members of
        [] ->
            context

        _ :: remaining ->
            let
                withDelimiters : ModuleContext
                withDelimiters =
                    context
                        |> addEdit kind
                            { start = range.start
                            , end = { row = range.start.row, column = range.start.column + 1 }
                            }
                            ("{ " ++ fieldLabel 0 ++ " " ++ separator ++ " ")
                        |> addEdit kind
                            { start = { row = range.end.row, column = range.end.column - 1 }
                            , end = range.end
                            }
                            " }"
            in
            remaining
                |> List.indexedMap (\index member -> ( index + 1, member ))
                |> List.foldl
                    (\( index, member ) found ->
                        addInsertion kind
                            (Node.range member).start
                            (fieldLabel index ++ " " ++ separator ++ " ")
                            found
                    )
                    withDelimiters


addPayloadEdits : EditKind -> String -> List (Node value) -> ModuleContext -> ModuleContext
addPayloadEdits kind separator members context =
    case members of
        [] ->
            context

        first :: remaining ->
            let
                withFields : ModuleContext
                withFields =
                    remaining
                        |> List.indexedMap (\index member -> ( index + 1, member ))
                        |> List.foldl
                            (\( index, member ) found ->
                                addInsertion kind
                                    (Node.range member).start
                                    (", " ++ fieldLabel index ++ " " ++ separator ++ " ")
                                    found
                            )
                            (addInsertion kind
                                (Node.range first).start
                                ("{ " ++ fieldLabel 0 ++ " " ++ separator ++ " ")
                                context
                            )
            in
            case List.reverse members |> List.head of
                Just last ->
                    addInsertion kind (Node.range last).end " }" withFields

                Nothing ->
                    withFields


addConstructorArityDiagnostic : Range -> String -> Int -> Int -> ModuleContext -> ModuleContext
addConstructorArityDiagnostic range name expected actual context =
    addDiagnostic
        { code = "UNMAPPED_SYMBOL"
        , severity = Types.Error
        , message =
            "Constructor pattern `"
                ++ name
                ++ "` has "
                ++ String.fromInt actual
                ++ " arguments, but its declaration has "
                ++ String.fromInt expected
                ++ "."
        , range = Just range
        , help = Just "Check the dependency source and constructor mapping before transpiling this pattern."
        }
        context


fieldLabel : Int -> String
fieldLabel index =
    case index of
        0 ->
            "first"

        1 ->
            "second"

        2 ->
            "third"

        3 ->
            "fourth"

        4 ->
            "fifth"

        5 ->
            "sixth"

        6 ->
            "seventh"

        7 ->
            "eighth"

        8 ->
            "ninth"

        9 ->
            "tenth"

        _ ->
            "value" ++ String.fromInt (index + 1)


addEdit : EditKind -> Range -> String -> ModuleContext -> ModuleContext
addEdit kind range replacement context =
    { context
        | edits =
            { range = range
            , replacement = replacement
            , kind = kind
            , rule = "ElmToGren"
            }
                :: context.edits
    }


addInsertion : EditKind -> Location -> String -> ModuleContext -> ModuleContext
addInsertion kind location replacement =
    addEdit kind { start = location, end = location } replacement


addDiagnostic : Diagnostic -> ModuleContext -> ModuleContext
addDiagnostic diagnostic context =
    { context | diagnostics = diagnostic :: context.diagnostics }


selectNonOverlapping : List SourceEdit -> List SourceEdit
selectNonOverlapping edits =
    edits
        |> List.sortWith compareOuterFirst
        |> List.foldl keepIfDisjoint []
        |> List.reverse


compareOuterFirst : SourceEdit -> SourceEdit -> Order
compareOuterFirst left right =
    case compareLocation left.range.start right.range.start of
        EQ ->
            -- Non-empty edits come first so insertions at their boundary are
            -- retained. Co-located insertions are merged below.
            compareLocation right.range.end left.range.end

        order ->
            order


keepIfDisjoint : SourceEdit -> List SourceEdit -> List SourceEdit
keepIfDisjoint candidate accepted =
    if isInsertion candidate then
        case mergeWithCoLocatedInsertion candidate accepted of
            Just merged ->
                merged

            Nothing ->
                if List.any (editsOverlap candidate) accepted then
                    accepted

                else
                    candidate :: accepted

    else if List.any (editsOverlap candidate) accepted then
        accepted

    else
        candidate :: accepted


isInsertion : SourceEdit -> Bool
isInsertion edit =
    edit.range.start == edit.range.end


mergeWithCoLocatedInsertion : SourceEdit -> List SourceEdit -> Maybe (List SourceEdit)
mergeWithCoLocatedInsertion candidate accepted =
    case accepted of
        [] ->
            Nothing

        current :: remaining ->
            if isInsertion current && current.range.start == candidate.range.start then
                Just (mergeInsertions candidate current :: remaining)

            else
                mergeWithCoLocatedInsertion candidate remaining
                    |> Maybe.map (\mergedRemaining -> current :: mergedRemaining)


mergeInsertions : SourceEdit -> SourceEdit -> SourceEdit
mergeInsertions left right =
    let
        ordered : ( SourceEdit, SourceEdit )
        ordered =
            case compare (insertionPriority left) (insertionPriority right) of
                LT ->
                    ( left, right )

                GT ->
                    ( right, left )

                EQ ->
                    if left.replacement <= right.replacement then
                        ( left, right )

                    else
                        ( right, left )

        first : SourceEdit
        first =
            Tuple.first ordered

        second : SourceEdit
        second =
            Tuple.second ordered
    in
    { first | replacement = first.replacement ++ second.replacement }


insertionPriority : SourceEdit -> Int
insertionPriority edit =
    if String.startsWith "Just { first = " edit.replacement then
        -- After a structural record label (`second = `), before wrappers.
        5

    else if String.startsWith "Array.popFirst (" edit.replacement then
        10

    else if String.startsWith "Array.pushFirst (" edit.replacement then
        20

    else if String.startsWith ")" edit.replacement then
        30

    else if String.startsWith " }" edit.replacement then
        -- A child call closes before the structural record which contains it.
        40

    else
        -- Record labels and constructor wrappers belong outside any child
        -- expression wrapper at the same source location.
        0


editsOverlap : SourceEdit -> SourceEdit -> Bool
editsOverlap left right =
    locationBefore left.range.start right.range.end
        && locationBefore right.range.start left.range.end


locationBefore : Location -> Location -> Bool
locationBefore left right =
    compareLocation left right == LT


compareLocation : Location -> Location -> Order
compareLocation left right =
    case compare left.row right.row of
        EQ ->
            compare left.column right.column

        order ->
            order


unique : List comparable -> List comparable
unique values =
    List.foldl
        (\value found ->
            if List.member value found then
                found

            else
                value :: found
        )
        []
        values
        |> List.reverse
