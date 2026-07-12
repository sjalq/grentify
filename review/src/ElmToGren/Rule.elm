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
import ElmToGren.AstEncode as AstEncode
import ElmToGren.Encode as Encode
import ElmToGren.Types as Types exposing (ConstructorInfo, Diagnostic, EditKind, ModuleExtraction, Platform, RecordAliasInfo, SourceEdit)
import Json.Encode as JsonEncode
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
    , -- Phase 1: resolved simplified AST snapshot for the host print path.
      ast : JsonEncode.Value
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
            , edits = reservedEditsForModule (Node.value ast.moduleDefinition)
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
            , -- Phase 1: resolved AST snapshot for the host pipeline.
              ast = AstEncode.encodeFile lookupTable ast
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
                    , ast = context.ast
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
    case moduleDefinition of
        PortModule _ ->
            -- Port modules are valid application targets: keep declarations and
            -- let the Gren app emitter preserve them as Elm-side interop only.
            []

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


{-| Gren reclaims `when`/`is` as keywords (`case`/`of` in Elm). Elm code that
uses those as ordinary identifiers is rewritten to `when_`/`is_` at every
binding and use site the rule visits, rather than refused.
-}
reservedEditsForModule : Module -> List SourceEdit
reservedEditsForModule moduleDefinition =
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
    reservedEditsForExposing (Node.value exposingList)
        ++ List.filterMap reservedEditForNode effectManagerNames


reservedEditsForExposing : Exposing -> List SourceEdit
reservedEditsForExposing exposingList =
    case exposingList of
        All _ ->
            []

        Explicit exposed ->
            List.filterMap
                (\(Node range exposedValue) ->
                    case exposedValue of
                        FunctionExpose name ->
                            reservedEditForName range name

                        TypeOrAliasExpose name ->
                            reservedEditForName range name

                        TypeExpose exposedType ->
                            -- Range covers `Name` or `Name (..)`; only rewrite the name.
                            case exposedType.open of
                                Nothing ->
                                    reservedEditForName range exposedType.name

                                Just openRange ->
                                    reservedEditForName
                                        { start = range.start
                                        , end = openRange.start
                                        }
                                        exposedType.name

                        InfixExpose _ ->
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

        withReservedEdits : ModuleContext
        withReservedEdits =
            import_.exposingList
                |> Maybe.map (Node.value >> reservedEditsForExposing)
                |> Maybe.withDefault []
                |> List.foldl (\edit ctx -> { ctx | edits = edit :: ctx.edits }) withImport
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
            withReservedEdits
        )

    else
        ( [], withReservedEdits )


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


{-| Append `_` so the identifier remains legal under Gren keywords. -}
reservedRewrite : String -> String
reservedRewrite name =
    name ++ "_"


reservedEditForName : Range -> String -> Maybe SourceEdit
reservedEditForName range name =
    if isReservedGrenIdentifier name then
        Just
            { range = range
            , replacement = reservedRewrite name
            , kind = Types.SymbolReference
            , rule = "ElmToGren"
            }

    else
        Nothing


reservedEditForNode : Node String -> Maybe SourceEdit
reservedEditForNode (Node range name) =
    reservedEditForName range name


addReservedIdentifier : Range -> String -> ModuleContext -> ModuleContext
addReservedIdentifier range name context =
    case reservedEditForName range name of
        Just edit ->
            { context | edits = edit :: context.edits }

        Nothing ->
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
                                    let
                                        signature =
                                            Node.value signatureNode
                                    in
                                    withFunctionName
                                        |> addReservedIdentifierNode signature.name
                                        |> collectTypeAnnotation signature.typeAnnotation

                                Nothing ->
                                    withFunctionName
                    in
                    ( [], List.foldl collectPattern withSignature implementation.arguments )

                AliasDeclaration aliasDeclaration ->
                    ( []
                    , context
                        |> addReservedIdentifierNode aliasDeclaration.name
                        |> (\ctx -> List.foldl addReservedIdentifierNode ctx aliasDeclaration.generics)
                        |> collectTypeAnnotation aliasDeclaration.typeAnnotation
                    )

                CustomTypeDeclaration customType ->
                    let
                        withName : ModuleContext
                        withName =
                            addReservedIdentifierNode customType.name context

                        withGenerics : ModuleContext
                        withGenerics =
                            List.foldl addReservedIdentifierNode withName customType.generics

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
                    -- Keep port declarations intact for application interop.
                    ( []
                    , context
                        |> addReservedIdentifierNode signature.name
                        |> collectTypeAnnotation signature.typeAnnotation
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
            -- elm-syntax stores access-functions as `.field` (leading dot).
            let
                bareField : String
                bareField =
                    if String.startsWith "." fieldName then
                        String.dropLeft 1 fieldName

                    else
                        fieldName
            in
            if isReservedGrenIdentifier bareField then
                ( []
                , addEdit Types.SymbolReference
                    range
                    ("." ++ reservedRewrite bareField)
                    context
                )

            else
                ( [], context )

        RecordUpdateExpression recordName setters ->
            -- The base of a record update (`{ defaultOptions | ... }`) is a
            -- bare value reference and must be rewritten when its module is
            -- mapped (e.g. Markdown.defaultOptions → Compat).
            ( []
            , setters
                |> List.foldl collectRecordSetterName
                    (addResolvedReference recordName (Node.value recordName) False
                        (addReservedIdentifierNode recordName context)
                    )
            )

        FunctionOrValue moduleParts name ->
            if isReservedGrenIdentifier name then
                -- Range covers the whole written form (`when` or `Mod.when`).
                -- Rewrite only the identifier, preserving any qualifier.
                let
                    rewritten : String
                    rewritten =
                        if List.isEmpty moduleParts then
                            reservedRewrite name

                        else
                            String.join "." moduleParts ++ "." ++ reservedRewrite name
                in
                ( [], addEdit Types.SymbolReference range rewritten context )

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
                case namedPlatformPayloadFields moduleParts name of
                    Just fieldNames ->
                        ( []
                        , addEdit Types.CustomConstructor
                            range
                            (namedConstructorFunction context.extract range fieldNames)
                            withReference
                        )

                    Nothing ->
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
                                -- Bare Json.Decode.Error constructors after exposing (..)
                                case ( name, True ) of
                                    ( "Field", True ) ->
                                        ( []
                                        , addEdit Types.CustomConstructor
                                            range
                                            (namedConstructorFunction context.extract range [ "name", "error" ])
                                            withReference
                                        )

                                    ( "Index", True ) ->
                                        ( []
                                        , addEdit Types.CustomConstructor
                                            range
                                            (namedConstructorFunction context.extract range [ "index", "error" ])
                                            withReference
                                        )

                                    ( "Failure", True ) ->
                                        ( []
                                        , addEdit Types.CustomConstructor
                                            range
                                            (namedConstructorFunction context.extract range [ "message", "value" ])
                                            withReference
                                        )

                                    _ ->
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

        shortMatchFallback : String
        shortMatchFallback =
            nothingMatchFallback "elm-to-gren: multi-cons did not match" caseBlock.cases withKeyword
    in
    -- Total list-shape compiler: length dispatch covers exact multi-depth
    -- lattices and open multi with named rests in one generic mechanism.
    if isPureListShapeCase patterns then
        collectPureListShapeCase range caseBlock context

    else if
        List.any isUnconsPattern patterns
            && List.all canRewriteArrayCasePattern patterns
            && multiConsFallthroughOk patterns
            && multiConsExactEmptyFallthroughOk patterns
            && multiConsNestFallbackOk patterns caseBlock.cases
    then
        caseBlock.cases
            |> List.foldl (collectArrayCase caseBlock.cases shortMatchFallback)
                (addCallAroundExpression Types.ListConsExpression "Array.popFirst" caseBlock.expression withKeyword)

    else if
        isTupleListCase caseBlock
            && multiConsFallthroughOk (tupleListShapePatterns caseBlock)
            && multiConsExactEmptyFallthroughOk (tupleListShapePatterns caseBlock)
            && multiConsNestFallbackOk (tupleListShapePatterns caseBlock) caseBlock.cases
            && tupleMultiConsBodyWrapOk caseBlock
    then
        collectTupleListCase shortMatchFallback caseBlock withKeyword

    else if
        isMaybeUnconsCase patterns
            && multiConsFallthroughOk (wrappedListShapePatterns patterns)
            && multiConsExactEmptyFallthroughOk (wrappedListShapePatterns patterns)
            && multiConsNestFallbackOk (wrappedListShapePatterns patterns) caseBlock.cases
    then
        caseBlock.cases
            |> List.foldl (collectMaybeUnconsCase caseBlock.cases shortMatchFallback)
                (addCallAroundExpression Types.ListConsExpression "Maybe.map Array.popFirst" caseBlock.expression withKeyword)

    else if
        isResultUnconsCase patterns
            && multiConsFallthroughOk (wrappedListShapePatterns patterns)
            && multiConsExactEmptyFallthroughOk (wrappedListShapePatterns patterns)
            && multiConsNestFallbackOk (wrappedListShapePatterns patterns) caseBlock.cases
    then
        caseBlock.cases
            |> List.foldl (collectResultUnconsCase caseBlock.cases shortMatchFallback)
                (addCallAroundExpression Types.ListConsExpression "Result.map Array.popFirst" caseBlock.expression withKeyword)

    else if isCtorEmbeddedUnconsCase patterns && embeddedUnconsFallbackOk caseBlock.cases then
        caseBlock.cases
            |> List.foldl (collectCtorEmbeddedUnconsCase caseBlock.cases)
                withKeyword

    else
        List.foldl collectPattern withKeyword patterns


{-| Every arm is a pure list shape with simple heads: `[]`, fixed lists,
`h1 :: h2 :: … :: rest` (vars/`_` heads), or catch-all. No ctor/tuple nesting.
-}
isPureListShapeCase : List (Node Pattern) -> Bool
isPureListShapeCase patterns =
    List.any isListShapeMatch patterns
        && List.all isPureListShapePattern patterns


isListShapeMatch : Node Pattern -> Bool
isListShapeMatch patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        ListPattern _ ->
            True

        UnConsPattern _ _ ->
            True

        AsPattern inner _ ->
            case asUnconsParts inner of
                Just _ ->
                    True

                Nothing ->
                    parseConsChain (unwrapParenthesized inner) /= Nothing

        _ ->
            False


isPureListShapePattern : Node Pattern -> Bool
isPureListShapePattern patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        AllPattern ->
            True

        VarPattern _ ->
            True

        ListPattern members ->
            not (List.any patternContainsUncons members)
                && List.all isSimpleListHead members

        UnConsPattern _ _ ->
            case parseConsChain (unwrapParenthesized patternNode) of
                Just chain ->
                    List.all isSimpleListHead chain.heads
                        && isSimpleRest chain.rest

                Nothing ->
                    False

        AsPattern inner asName ->
            case asUnconsParts inner of
                Just parts ->
                    isSimpleListHead parts.left
                        && isSimpleRest parts.right

                Nothing ->
                    case parseConsChain (unwrapParenthesized inner) of
                        Just chain ->
                            List.all isSimpleListHead chain.heads
                                && isSimpleRest chain.rest

                        Nothing ->
                            case Node.value (unwrapParenthesized inner) of
                                AllPattern ->
                                    True

                                VarPattern _ ->
                                    True

                                _ ->
                                    False

        ParenthesizedPattern inner ->
            isPureListShapePattern inner

        _ ->
            False


isSimpleListHead : Node Pattern -> Bool
isSimpleListHead patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern _ ->
            True

        AllPattern ->
            True

        _ ->
            False


isSimpleRest : Node Pattern -> Bool
isSimpleRest patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern _ ->
            True

        AllPattern ->
            True

        ListPattern [] ->
            True

        AsPattern inner _ ->
            isSimpleRest (unwrapParenthesized inner)

        ParenthesizedPattern inner ->
            isSimpleRest inner

        _ ->
            False


type alias PureListArm =
    { minLength : Int
    , isOpen : Bool
    , isCatchAll : Bool
    , heads : List String
    , restName : Maybe String
    , asName : Maybe String
    , body : Node Expression
    }


{-| Compile a pure list case via `Array.length` dispatch. Each arm becomes an
exact length (or final open `_`), with heads bound by nested `popFirst` and
named rests bound to the remaining array. One mechanism covers exact lattices
and open multi-cons with named tails.
-}
collectPureListShapeCase : Range -> Elm.Syntax.Expression.CaseBlock -> ModuleContext -> ModuleContext
collectPureListShapeCase range caseBlock context =
    case List.filterMap (parsePureListArm context) caseBlock.cases of
        [] ->
            List.foldl collectPattern context (List.map Tuple.first caseBlock.cases)

        arms ->
            let
                scrutinee =
                    parenthesizeExpr context caseBlock.expression

                rendered =
                    renderPureListCase context scrutinee arms range.start.column

                -- Reserved renames on heads/bodies only. Do NOT collectPattern on
                -- uncons arms (that emits refuse diagnostics we are compiling away).
                withScans =
                    List.foldl
                        (\( patternNode, body ) ctx ->
                            collectPureListArmNames patternNode ctx
                                |> (\c -> collectExpressionShallow body c)
                        )
                        context
                        caseBlock.cases
            in
            addEdit Types.ListConsExpression range rendered withScans


{-| Reserved-identifier pass for pure list arms without refusing `::`.
-}
collectPureListArmNames : Node Pattern -> ModuleContext -> ModuleContext
collectPureListArmNames patternNode context =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern name ->
            addReservedIdentifier (Node.range patternNode) name context

        AllPattern ->
            context

        ListPattern members ->
            List.foldl collectPureListArmNames context members

        UnConsPattern left right ->
            collectPureListArmNames right (collectPureListArmNames left context)

        AsPattern inner asName ->
            collectPureListArmNames inner context
                |> addReservedIdentifierNode asName

        ParenthesizedPattern inner ->
            collectPureListArmNames inner context

        NamedPattern _ args ->
            List.foldl collectPureListArmNames context args

        TuplePattern members ->
            List.foldl collectPureListArmNames context members

        RecordPattern fields ->
            List.foldl addReservedIdentifierNode context fields

        _ ->
            context


parsePureListArm : ModuleContext -> ( Node Pattern, Node Expression ) -> Maybe PureListArm
parsePureListArm context ( patternNode, body ) =
    case Node.value (unwrapParenthesized patternNode) of
        AllPattern ->
            Just
                { minLength = 0
                , isOpen = True
                , isCatchAll = True
                , heads = []
                , restName = Nothing
                , asName = Nothing
                , body = body
                }

        VarPattern name ->
            Just
                { minLength = 0
                , isOpen = True
                , isCatchAll = True
                , heads = []
                , restName = Nothing
                , asName = Just name
                , body = body
                }

        ListPattern members ->
            if List.any patternContainsUncons members then
                Nothing

            else
                Just
                    { minLength = List.length members
                    , isOpen = False
                    , isCatchAll = False
                    , heads = List.map (simpleHeadName context) members
                    , restName = Nothing
                    , asName = Nothing
                    , body = body
                    }

        UnConsPattern _ _ ->
            parseConsChain (unwrapParenthesized patternNode)
                |> Maybe.andThen (consChainToArm context Nothing body)

        AsPattern inner asName ->
            case asUnconsParts inner of
                Just parts ->
                    Just
                        { minLength = 1
                        , isOpen = True
                        , isCatchAll = False
                        , heads = [ simpleHeadName context parts.left ]
                        , restName = simpleRestName parts.right
                        , asName = Just (Node.value asName)
                        , body = body
                        }

                Nothing ->
                    case parseConsChain (unwrapParenthesized inner) of
                        Just chain ->
                            consChainToArm context (Just (Node.value asName)) body chain

                        Nothing ->
                            case Node.value (unwrapParenthesized inner) of
                                AllPattern ->
                                    Just
                                        { minLength = 0
                                        , isOpen = True
                                        , isCatchAll = True
                                        , heads = []
                                        , restName = Nothing
                                        , asName = Just (Node.value asName)
                                        , body = body
                                        }

                                VarPattern name ->
                                    Just
                                        { minLength = 0
                                        , isOpen = True
                                        , isCatchAll = True
                                        , heads = []
                                        , restName = Nothing
                                        , asName = Just name
                                        , body = body
                                        }

                                _ ->
                                    Nothing

        ParenthesizedPattern inner ->
            parsePureListArm context ( inner, body )

        _ ->
            Nothing


consChainToArm : ModuleContext -> Maybe String -> Node Expression -> ConsChain -> Maybe PureListArm
consChainToArm context asName body chain =
    let
        open =
            not (isEmptyListRest chain.rest)
    in
    Just
        { minLength = List.length chain.heads
        , isOpen = open
        , isCatchAll = False
        , heads = List.map (simpleHeadName context) chain.heads
        , restName =
            if open then
                simpleRestName chain.rest

            else
                Nothing
        , asName = asName
        , body = body
        }


simpleHeadName : ModuleContext -> Node Pattern -> String
simpleHeadName context patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern name ->
            name

        AllPattern ->
            "_"

        _ ->
            grenPatternText context patternNode


simpleRestName : Node Pattern -> Maybe String
simpleRestName patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern name ->
            Just name

        AllPattern ->
            Nothing

        ListPattern [] ->
            Nothing

        AsPattern inner asName ->
            case simpleRestName (unwrapParenthesized inner) of
                Just name ->
                    Just name

                Nothing ->
                    Just (Node.value asName)

        ParenthesizedPattern inner ->
            simpleRestName inner

        _ ->
            Nothing


{-| Render a scrutinee expression as Gren, including `::` → `Array.pushFirst`.
Whole-case replacement would otherwise leave Elm cons in the bound scrutinee.
-}
parenthesizeExpr : ModuleContext -> Node Expression -> String
parenthesizeExpr context exprNode =
    let
        text =
            grenExprText context exprNode

        needsParens =
            case Node.value exprNode of
                FunctionOrValue _ _ ->
                    False

                Integer _ ->
                    False

                Floatable _ ->
                    False

                Literal _ ->
                    False

                Hex _ ->
                    False

                ParenthesizedExpression _ ->
                    False

                _ ->
                    True
    in
    if needsParens then
        "(" ++ text ++ ")"

    else
        text


grenExprText : ModuleContext -> Node Expression -> String
grenExprText context (Node range expression) =
    case expression of
        OperatorApplication "::" _ left right ->
            "Array.pushFirst ("
                ++ grenExprText context left
                ++ ") ("
                ++ grenExprText context right
                ++ ")"

        ParenthesizedExpression inner ->
            "(" ++ grenExprText context inner ++ ")"

        TupledExpression members ->
            let
                fields =
                    members
                        |> List.indexedMap
                            (\index member ->
                                fieldLabel index ++ " = " ++ grenExprText context member
                            )
                        |> String.join ", "
            in
            "{ " ++ fields ++ " }"

        UnitExpr ->
            "{}"

        ListExpr elements ->
            elements
                |> List.map (grenExprText context)
                |> String.join ", "
                |> (\inner -> "[" ++ inner ++ "]")

        Application values ->
            case values of
                [] ->
                    ""

                first :: rest ->
                    grenExprText context first
                        ++ (rest
                                |> List.map (\v -> " (" ++ grenExprText context v ++ ")")
                                |> String.join ""
                           )

        OperatorApplication op _ left right ->
            "("
                ++ grenExprText context left
                ++ " "
                ++ op
                ++ " "
                ++ grenExprText context right
                ++ ")"

        IfBlock condition ifTrue ifFalse ->
            "(if "
                ++ grenExprText context condition
                ++ " then "
                ++ grenExprText context ifTrue
                ++ " else "
                ++ grenExprText context ifFalse
                ++ ")"

        Negation inner ->
            "(-" ++ grenExprText context inner ++ ")"

        FunctionOrValue modules name ->
            case modules of
                [] ->
                    -- Whole-case pure-list rewrites embed bodies before the
                    -- catalog mapping pass; apply known Gren renames here.
                    case bareGrenRename name of
                        Just renamed ->
                            renamed

                        Nothing ->
                            name

                _ ->
                    let
                        mod =
                            String.join "." modules
                    in
                    case qualifiedGrenRename mod name of
                        Just renamed ->
                            renamed

                        Nothing ->
                            mod ++ "." ++ name

        Integer n ->
            String.fromInt n

        Hex n ->
            context.extract range

        Floatable n ->
            context.extract range

        Literal s ->
            context.extract range

        CharLiteral _ ->
            context.extract range

        PrefixOperator op ->
            if op == "::" then
                "Array.pushFirst"

            else
                "(" ++ op ++ ")"

        RecordAccess record (Node _ field) ->
            grenExprText context record ++ "." ++ field

        RecordAccessFunction field ->
            if String.startsWith "." field then
                field

            else
                "." ++ field

        LambdaExpression lambda ->
            "(\\"
                ++ (lambda.args
                        |> List.map (grenPatternText context)
                        |> String.join " "
                   )
                ++ " -> "
                ++ grenExprText context lambda.expression
                ++ ")"

        LetExpression letBlock ->
            let
                decls =
                    letBlock.declarations
                        |> List.map (grenLetDeclaration context)
                        |> String.join "\n  "
            in
            "(let\n  "
                ++ decls
                ++ "\nin\n  "
                ++ grenExprText context letBlock.expression
                ++ ")"

        CaseExpression caseBlock ->
            -- Nested cases embedded in whole-case list rewrites must keep
            -- multi-line when/is structure. Flattening via String.words made
            -- arms share a line and gren rejected the unexpected arrows.
            let
                arms =
                    caseBlock.cases
                        |> List.map
                            (\( pattern, body ) ->
                                grenPatternText context pattern
                                    ++ " ->\n        "
                                    ++ grenExprText context body
                            )
                        |> String.join "\n\n    "
            in
            "(when "
                ++ grenExprText context caseBlock.expression
                ++ " is\n    "
                ++ arms
                ++ ")"

        _ ->
            context.extract range
                |> String.words
                |> String.join " "


{-| Bare names that moved off Elm's default Basics into Math.
-}
bareGrenRename : String -> Maybe String
bareGrenRename name =
    if isGrenMathBasics name then
        Just ("Math." ++ name)

    else
        Nothing


isGrenMathBasics : String -> Bool
isGrenMathBasics name =
    -- Note: never include single-letter locals like `e` / bare `pi` here —
    -- FunctionOrValue [] cannot tell local bindings from Basics.
    List.member name
        [ "round"
        , "floor"
        , "ceiling"
        , "truncate"
        , "modBy"
        , "remainderBy"
        , "abs"
        , "sqrt"
        , "logBase"
        , "cos"
        , "sin"
        , "tan"
        , "acos"
        , "asin"
        , "atan"
        , "atan2"
        , "degrees"
        , "radians"
        , "turns"
        ]


{-| Qualified renames that mirror mappings/builtin for pure-list body embedding.
-}
qualifiedGrenRename : String -> String -> Maybe String
qualifiedGrenRename moduleName name =
    case ( moduleName, name ) of
        ( "Basics", n ) ->
            if isGrenMathBasics n || n == "e" || n == "pi" then
                Just ("Math." ++ n)

            else
                Nothing

        ( "String", "length" ) ->
            Just "String.count"

        ( "String", "left" ) ->
            Just "String.takeFirst"

        ( "String", "right" ) ->
            Just "String.takeLast"

        ( "String", "dropLeft" ) ->
            Just "String.dropFirst"

        ( "String", "dropRight" ) ->
            Just "String.dropLast"

        ( "String", "indexes" ) ->
            Just "String.indices"

        ( "String", "cons" ) ->
            Just "String.pushFirst"

        ( "String", "toList" ) ->
            Just "String.toArray"

        ( "String", "fromList" ) ->
            Just "String.fromArray"

        ( "String", "filter" ) ->
            Just "String.keepIf"

        ( "String", "uncons" ) ->
            Just "ElmToGren.Compat.String.uncons"

        ( "String", "concat" ) ->
            Just "ElmToGren.Compat.String.concat"

        ( "List", n ) ->
            -- Catalog List → Array (and a few value renames). Embedded bodies
            -- skip the host mapping pass, so apply the same renames here.
            case n of
                "filter" ->
                    Just "Array.keepIf"

                "filterMap" ->
                    Just "Array.mapAndKeepJust"

                "concat" ->
                    Just "Array.flatten"

                "concatMap" ->
                    Just "Array.mapAndFlatten"

                "head" ->
                    Just "Array.first"

                "take" ->
                    Just "Array.takeFirst"

                "drop" ->
                    Just "Array.dropFirst"

                "sum" ->
                    Just "ElmToGren.Compat.List.sum"

                "product" ->
                    Just "ElmToGren.Compat.List.product"

                "tail" ->
                    Just "ElmToGren.Compat.List.tail"

                "partition" ->
                    Just "ElmToGren.Compat.List.partition"

                "unzip" ->
                    Just "ElmToGren.Compat.List.unzip"

                "map4" ->
                    Just "ElmToGren.Compat.List.map4"

                "map5" ->
                    Just "ElmToGren.Compat.List.map5"

                _ ->
                    Just ("Array." ++ n)

        ( "Tuple", "mapFirst" ) ->
            Just "Tuple.mapFirst"

        ( "Tuple", "mapSecond" ) ->
            Just "Tuple.mapSecond"

        _ ->
            Nothing


grenLetDeclaration : ModuleContext -> Node Elm.Syntax.Expression.LetDeclaration -> String
grenLetDeclaration context (Node _ decl) =
    case decl of
        Elm.Syntax.Expression.LetFunction function ->
            let
                impl =
                    Node.value function.declaration

                name =
                    Node.value impl.name
            in
            name
                ++ " = "
                ++ grenExprText context impl.expression

        Elm.Syntax.Expression.LetDestructuring pattern expr ->
            grenPatternText context pattern
                ++ " = "
                ++ grenExprText context expr


renderPureListCase : ModuleContext -> String -> List PureListArm -> Int -> String
renderPureListCase context scrutinee arms caseCol =
    let
        indent n =
            String.repeat (max 0 (caseCol - 1 + n)) " "

        scrutName =
            "list_scrut_elmToGren"

        -- Emit arms for lengths 0,1,...,maxMin-1 as exact, then open/catchall.
        maxExact =
            arms
                |> List.filter (\a -> not a.isCatchAll)
                |> List.map .minLength
                |> List.maximum
                |> Maybe.withDefault 0

        lengthPatterns : List ( String, PureListArm )
        lengthPatterns =
            List.range 0 maxExact
                |> List.filterMap
                    (\len ->
                        pickArmForLength len arms
                            |> Maybe.map (\arm -> ( String.fromInt len, arm ))
                    )

        -- If some open/catchall remains for length > maxExact, add `_`.
        openTail : List ( String, PureListArm )
        openTail =
            case pickArmForLength (maxExact + 1) arms of
                Just arm ->
                    if arm.isOpen || arm.isCatchAll then
                        [ ( "_", arm ) ]

                    else
                        []

                Nothing ->
                    []

        allBranches =
            lengthPatterns ++ openTail

        renderBranch ( pat, arm ) =
            indent 4
                ++ pat
                ++ " ->\n"
                ++ indent 8
                ++ renderArmBody context scrutName arm (caseCol + 8)

        body =
            allBranches
                |> List.map renderBranch
                |> String.join "\n\n"
    in
    "let\n"
        ++ indent 4
        ++ scrutName
        ++ " =\n"
        ++ indent 8
        ++ scrutinee
        ++ "\n"
        ++ indent 0
        ++ "in\n"
        ++ indent 0
        ++ "when Array.length "
        ++ scrutName
        ++ " is\n"
        ++ body


pickArmForLength : Int -> List PureListArm -> Maybe PureListArm
pickArmForLength len arms =
    -- Elm order: first arm that matches this length.
    case arms of
        [] ->
            Nothing

        arm :: rest ->
            if armMatchesLength len arm then
                Just arm

            else
                pickArmForLength len rest


armMatchesLength : Int -> PureListArm -> Bool
armMatchesLength len arm =
    if arm.isCatchAll then
        True

    else if arm.isOpen then
        len >= arm.minLength

    else
        len == arm.minLength


renderArmBody : ModuleContext -> String -> PureListArm -> Int -> String
renderArmBody context scrutName arm bodyCol =
    let
        -- Nested when/let in grenExprText are multi-line; reindent every
        -- continuation line to the insertion column so Gren's layout rules
        -- still see patterns under their `when`.
        bodyTextRaw =
            grenExprText context arm.body

        bodyAt col =
            reindentBlock col bodyTextRaw

        -- Absolute column indent (1-based column bodyCol).
        pad col =
            String.repeat (max 0 (col - 1)) " "

        letBind name value col =
            "let\n"
                ++ pad (col + 4)
                ++ name
                ++ " =\n"
                ++ pad (col + 8)
                ++ value
                ++ "\n"
                ++ pad col
                ++ "in\n"
                ++ pad col

        bindHeads : List String -> String -> Int -> Int -> String
        bindHeads heads source depth col =
            case heads of
                [] ->
                    let
                        restBind =
                            case arm.restName of
                                Just name ->
                                    letBind name source col

                                Nothing ->
                                    ""

                        asBind =
                            case arm.asName of
                                Just name ->
                                    letBind name scrutName col

                                Nothing ->
                                    ""
                    in
                    restBind ++ asBind ++ bodyAt col

                headName :: more ->
                    let
                        restN =
                            "r" ++ String.fromInt depth ++ "_elmToGren"
                    in
                    "when Array.popFirst "
                        ++ source
                        ++ " is\n"
                        ++ pad (col + 4)
                        ++ "Just { first = "
                        ++ headName
                        ++ ", rest = "
                        ++ restN
                        ++ " } ->\n"
                        ++ pad (col + 8)
                        ++ bindHeads more restN (depth + 1) (col + 8)
                        ++ "\n"
                        ++ pad (col + 4)
                        ++ "Nothing ->\n"
                        ++ pad (col + 8)
                        ++ "Debug.todo \"elm-to-gren: list length mismatch\""
    in
    if arm.isCatchAll then
        case arm.asName of
            Just name ->
                letBind name scrutName bodyCol ++ bodyAt bodyCol

            Nothing ->
                bodyAt bodyCol

    else if List.isEmpty arm.heads then
        bodyAt bodyCol

    else
        bindHeads arm.heads scrutName 0 bodyCol


{-| Reindent continuation lines of a multi-line body.

The first line is already positioned by the caller at column `col` (1-based).
Each later non-blank line keeps its *relative* indent from the block's left
edge and is shifted so that relative 0 lands at `col`.
-}
reindentBlock : Int -> String -> String
reindentBlock col text =
    let
        pad : Int -> String
        pad absoluteCol =
            String.repeat (max 0 (absoluteCol - 1)) " "

        leadingSpaces : String -> Int
        leadingSpaces line =
            String.length line - String.length (String.trimLeft line)
    in
    text
        |> String.lines
        |> List.indexedMap
            (\index line ->
                if index == 0 then
                    line

                else if String.isEmpty (String.trim line) then
                    ""

                else
                    pad (col + leadingSpaces line) ++ String.trimLeft line
            )
        |> String.join "\n"


{-| Visit an expression only for reserved-identifier edits on its free names.
Full case/list rewriting is owned by the outer pure-list compiler.
-}
collectExpressionShallow : Node Expression -> ModuleContext -> ModuleContext
collectExpressionShallow (Node range expression) context =
    case expression of
        FunctionOrValue _ name ->
            addReservedIdentifier range name context

        RecordAccessFunction name ->
            addReservedIdentifier range (String.dropLeft 1 name) context

        _ ->
            context


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
                    parseConsChain inner /= Nothing

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
and the tail is a variable or wildcard (single-level only; multi-cons `as`
falls through to the general cons-chain rewrite without rebuilding).
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


{-| A cons chain `h1 :: h2 :: ... :: rest` with no uncons inside any head and
a final rest that is `_`, a variable, or `[]`.
-}
type alias ConsChain =
    { heads : List (Node Pattern)
    , rest : Node Pattern
    }


parseConsChain : Node Pattern -> Maybe ConsChain
parseConsChain patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        UnConsPattern left right ->
            if patternContainsUncons left then
                Nothing

            else
                case parseConsChain right of
                    Just chain ->
                        Just { heads = left :: chain.heads, rest = chain.rest }

                    Nothing ->
                        if isRestArrayPattern right then
                            Just { heads = [ left ], rest = right }

                        else
                            Nothing

        _ ->
            Nothing


canRewriteUnconsChain : Node Pattern -> Bool
canRewriteUnconsChain patternNode =
    parseConsChain patternNode /= Nothing


canRewriteArrayCasePattern : Node Pattern -> Bool
canRewriteArrayCasePattern patternNode =
    case Node.value patternNode of
        ListPattern members ->
            not (List.any patternContainsUncons members)

        ParenthesizedPattern inner ->
            canRewriteArrayCasePattern inner

        AllPattern ->
            True

        UnConsPattern _ _ ->
            canRewriteUnconsChain patternNode
                || canRewriteCtorHeadUncons patternNode

        AsPattern inner _ ->
            -- Multi-cons under `as` is not rewritten (would drop the binding and
            -- leave the scrutinee wrapped in Array.popFirst with a raw :: pattern).
            asUnconsParts inner /= Nothing

        _ ->
            False


{-| Outer `Ctor args :: rest` where some arg of Ctor is itself an uncons.
The outer list is rewritten to bind the head value; the body peels embedded
list args with Array.popFirst (same as collectCtorEmbeddedUnconsCase).
-}
canRewriteCtorHeadUncons : Node Pattern -> Bool
canRewriteCtorHeadUncons patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        UnConsPattern left right ->
            if not (isRestArrayPattern right) then
                False

            else
                case Node.value (unwrapParenthesized left) of
                    NamedPattern qualifiedName args ->
                        let
                            isReservedMapCtor name =
                                name == "Just" || name == "Nothing" || name == "Ok" || name == "Err"

                            argOk arg =
                                case Node.value (unwrapParenthesized arg) of
                                    UnConsPattern _ _ ->
                                        case parseConsChain (unwrapParenthesized arg) of
                                            Just chain ->
                                                List.length chain.heads >= 1

                                            Nothing ->
                                                False

                                    ListPattern comps ->
                                        not (List.any patternContainsUncons comps)

                                    AllPattern ->
                                        True

                                    VarPattern _ ->
                                        True

                                    NamedPattern _ nestedArgs ->
                                        List.all argOk nestedArgs

                                    TuplePattern comps ->
                                        List.all argOk comps

                                    _ ->
                                        not (patternContainsUncons arg)

                            hasEmbeddedUncons =
                                List.any
                                    (\arg ->
                                        case Node.value (unwrapParenthesized arg) of
                                            UnConsPattern _ _ ->
                                                True

                                            _ ->
                                                False
                                    )
                                    args
                        in
                        not (isReservedMapCtor qualifiedName.name)
                            && hasEmbeddedUncons
                            && List.all argOk args

                    _ ->
                        False

        _ ->
            False


{-| Multi-cons (UnCons chain depth > 1) peels inside one branch.

Shorter *exact* companions (`h :: []`, `[x]`, `[x, y]`) are fine: Gren case
order keeps them as more-specific `rest = []` / fixed-list arms above the
open multi-cons arm, so nested short-match peels are dead code when order is
preserved (as in elm-ui's `h :: []` then `h :: o :: r`).

Shorter *open-rest* companions (`h :: t`) used to be refused wholesale. The
outer `Just { first = h1, rest = r0 }` of a multi-cons arm steals every
non-empty length, so intermediate lengths must be handled by nested `Nothing`
arms. That is safe when each intermediate length has a pasteable sibling body
(see `multiConsNestFallbackOk` + `firstArmMatchingExactLength`): e.g.
`a :: b :: _` then `a :: _` then `_` peels length 2 / 1 / 0 correctly.

Still refuse shorter open rests whose tail is a *named* binding (`a :: xs`):
nested `Nothing` would need `let xs = [] in …` and we do not reconstruct that.
-}
multiConsFallthroughOk : List (Node Pattern) -> Bool
multiConsFallthroughOk patterns =
    let
        multiDepths : List Int
        multiDepths =
            List.filterMap unconsChainDepth patterns

        maxMulti : Int
        maxMulti =
            List.maximum multiDepths |> Maybe.withDefault 0
    in
    if maxMulti <= 1 then
        True

    else
        not (List.any (isShorterOpenRestWithNamedTail maxMulti) patterns)


{-| Open-rest uncons shorter than `maxMulti` whose tail is a named binding.
Those need a reconstructed rest list in nested `Nothing` arms; refuse.
Wild rest (`_`) is allowed — length-specific paste handles it.
-}
isShorterOpenRestWithNamedTail : Int -> Node Pattern -> Bool
isShorterOpenRestWithNamedTail maxMulti patternNode =
    case parseConsChain (unwrapParenthesized patternNode) of
        Just chain ->
            let
                depth : Int
                depth =
                    List.length chain.heads
            in
            depth
                > 0
                && depth
                < maxMulti
                && not (isEmptyListRest chain.rest)
                && isNamedRestPattern chain.rest

        Nothing ->
            case Node.value (unwrapParenthesized patternNode) of
                AsPattern inner _ ->
                    case asUnconsParts inner of
                        Just parts ->
                            -- `as` uncons always binds the full list; cannot
                            -- rebuild that binding in a nested Nothing arm.
                            maxMulti > 1

                        Nothing ->
                            False

                _ ->
                    False


isNamedRestPattern : Node Pattern -> Bool
isNamedRestPattern patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern _ ->
            True

        AsPattern _ _ ->
            True

        _ ->
            False


{-| Exact-empty multi-cons (`a :: b :: []`) peels with a nested
`when rest is []` guard. Failure of that guard cannot try sibling arms that
share the same outer peels, so refuse when any sibling could match a longer
list (open rest, longer exact, or longer fixed list). Catch-all `_` is fine:
the guard pastes that body. Depth-1 `a :: []` stays at the outer `when` and
does not need this check.
-}
multiConsExactEmptyFallthroughOk : List (Node Pattern) -> Bool
multiConsExactEmptyFallthroughOk patterns =
    patterns
        |> List.filterMap exactEmptyMultiConsDepth
        |> List.all (\n -> not (List.any (canMatchListLongerThan n) patterns))


{-| Depth of a multi-cons chain whose final rest is exact `[]` (needs nested
empty-rest guard). Nothing for depth-1 `x :: []` or open rests.
-}
exactEmptyMultiConsDepth : Node Pattern -> Maybe Int
exactEmptyMultiConsDepth patternNode =
    case parseConsChain (unwrapParenthesized patternNode) of
        Just chain ->
            let
                depth : Int
                depth =
                    List.length chain.heads
            in
            if depth >= 2 && isEmptyListRest chain.rest then
                Just depth

            else
                Nothing

        Nothing ->
            Nothing


{-| Whether this list shape can match some list longer than `n` elements.

Bare `_` is False: nested empty-rest / length-mismatch arms paste that body.
Named catch-alls (`other`, `_ as name`) are True: they match longer lists but
cannot be pasted (bindings would be wrong), so exact-empty rewrites must refuse.
-}
canMatchListLongerThan : Int -> Node Pattern -> Bool
canMatchListLongerThan n patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        ListPattern members ->
            if List.any patternContainsUncons members then
                False

            else
                List.length members > n

        UnConsPattern _ _ ->
            case parseConsChain (unwrapParenthesized patternNode) of
                Just chain ->
                    if isEmptyListRest chain.rest then
                        List.length chain.heads > n

                    else
                        -- Open rest matches every length >= heads, including > n.
                        True

                Nothing ->
                    False

        VarPattern _ ->
            True

        AsPattern inner _ ->
            case asUnconsParts inner of
                Just _ ->
                    -- Single-level open `as` uncons matches length >= 1.
                    True

                Nothing ->
                    case Node.value (unwrapParenthesized inner) of
                        AllPattern ->
                            -- `_ as name` matches any length; binding cannot be rebuilt.
                            True

                        VarPattern _ ->
                            True

                        _ ->
                            canMatchListLongerThan n (unwrapParenthesized inner)

        _ ->
            False


needsMultiConsNesting : List (Node Pattern) -> Bool
needsMultiConsNesting patterns =
    patterns
        |> List.filterMap unconsChainDepth
        |> List.maximum
        |> Maybe.withDefault 0
        |> (\depth -> depth >= 2)


{-| Nested multi-cons peels paste a short-match fallback into synthetic
`Nothing` arms without re-running the expression visitor.

Nothing after matching `k` heads means the scrutinee has *exact* length `k`.
Each such length must have a pasteable sibling arm (`firstArmMatchingExactLength`),
not only a trailing catch-all — that is what makes `a :: b :: _` / `a :: _` /
`_` work. Named catch-alls still refuse (cannot rebind). Missing arms become
`Debug.todo` (non-exhaustive Elm).
-}
multiConsNestFallbackOk : List (Node Pattern) -> List ( Node Pattern, Node Expression ) -> Bool
multiConsNestFallbackOk patterns cases =
    if needsMultiConsNesting patterns then
        let
            maxMulti : Int
            maxMulti =
                patterns
                    |> List.filterMap unconsChainDepth
                    |> List.maximum
                    |> Maybe.withDefault 0

            intermediateLengths : List Int
            intermediateLengths =
                List.range 1 (maxMulti - 1)
        in
        List.all
            (\len -> syntheticFallbackOk (firstArmMatchingExactLength len cases))
            intermediateLengths

    else
        True


{-| Embedded ctor uncons always inserts a `Nothing` arm (empty list after
widening `Ctor listName`). Prefer the first arm that would match `Ctor []` in
Elm order: a same-ctor `[]` branch, else a leading `_`. A later `Ctor []`
after `_` must not win.

When a real `Ctor []` (or similar) arm already exists *above* the widened
uncons arm, empty lists never reach the peel — `Nothing` is unreachable and
may be `Debug.todo` even if that arm's body is not copy-safe (tuples, multi-arg
ctors). Refuse only when a named catch-all would have matched empty first
(`CannotSynthesizeFallback`).

Exact tails (`Ctor (x :: [])`) also need a length-mismatch arm from the first
catch-all (`_`). If a named catch-all precedes `_`, refuse.

Nested empty-rest guards cannot fall through to a sibling `Ctor (x :: rest)`
(or longer fixed list) on the same constructor slot, so refuse those shapes.
-}
embeddedUnconsFallbackOk : List ( Node Pattern, Node Expression ) -> Bool
embeddedUnconsFallbackOk cases =
    let
        patterns : List (Node Pattern)
        patterns =
            List.map Tuple.first cases

        ctorNames : List String
        ctorNames =
            patterns
                |> List.concatMap ctorUnconsSlots
                |> List.map Tuple.first

        -- Empty-list arm present (or todo) is enough; paste is best-effort.
        fallbackOk : String -> Bool
        fallbackOk ctorName =
            case firstEmptyListFallback ctorName cases of
                CannotSynthesizeFallback ->
                    False

                UseFallbackBody _ ->
                    True

                UseFallbackTodo ->
                    True

        lengthMismatchOk : Bool
        lengthMismatchOk =
            if hasExactEmptyEmbeddedUncons patterns then
                syntheticFallbackOk (firstCatchAllFallback cases)

            else
                True
    in
    List.all fallbackOk ctorNames
        && lengthMismatchOk
        && embeddedExactEmptySiblingOk patterns


{-| Result of scanning case arms in order for a synthetic fallback body.
-}
type SyntheticFallback
    = UseFallbackBody (Node Expression)
    | UseFallbackTodo
    | CannotSynthesizeFallback


syntheticFallbackOk : SyntheticFallback -> Bool
syntheticFallbackOk choice =
    case choice of
        UseFallbackBody body ->
            isCopySafeFallbackExpression body

        UseFallbackTodo ->
            True

        CannotSynthesizeFallback ->
            False


{-| First arm (Elm order) that matches a list of exact length `n`.

Used for nested multi-cons `Nothing` peels: after binding `k` heads, `Nothing`
means length was exactly `k`. Open rests with wild tails match every length
>= head-count; named catch-alls match but cannot be pasted.
-}
firstArmMatchingExactLength : Int -> List ( Node Pattern, Node Expression ) -> SyntheticFallback
firstArmMatchingExactLength n cases =
    case cases of
        [] ->
            UseFallbackTodo

        ( patternNode, body ) :: rest ->
            if not (patternMatchesExactLength n patternNode) then
                firstArmMatchingExactLength n rest

            else if isUnusableCatchAllPattern patternNode then
                CannotSynthesizeFallback

            else if openRestHasNamedTail patternNode then
                -- Would need `let rest = []` (or a drop) in the synthetic arm.
                CannotSynthesizeFallback

            else
                UseFallbackBody body


patternMatchesExactLength : Int -> Node Pattern -> Bool
patternMatchesExactLength n patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        ListPattern members ->
            (not (List.any patternContainsUncons members))
                && List.length members
                == n

        UnConsPattern _ _ ->
            case parseConsChain (unwrapParenthesized patternNode) of
                Just chain ->
                    let
                        depth =
                            List.length chain.heads
                    in
                    if isEmptyListRest chain.rest then
                        depth == n

                    else
                        -- Open rest matches every length >= depth.
                        depth <= n

                Nothing ->
                    False

        AllPattern ->
            True

        VarPattern _ ->
            True

        AsPattern inner _ ->
            case Node.value (unwrapParenthesized inner) of
                AllPattern ->
                    True

                _ ->
                    patternMatchesExactLength n (unwrapParenthesized inner)

        NamedPattern _ [ inner ] ->
            patternMatchesExactLength n inner

        ParenthesizedPattern inner ->
            patternMatchesExactLength n inner

        _ ->
            False


openRestHasNamedTail : Node Pattern -> Bool
openRestHasNamedTail patternNode =
    case parseConsChain (unwrapParenthesized patternNode) of
        Just chain ->
            not (isEmptyListRest chain.rest) && isNamedRestPattern chain.rest

        Nothing ->
            False


{-| First pasteable catch-all in case order for multi-cons short-list peels.

Bare `_`, fully-wild tuples `(_, _)`, and map-wrapper wildcards (`Just _`,
`Ok _`) are pasteable. Open patterns that would match the same fallthrough but
introduce bindings (`other`, `(xs, _)`, `Just other`) refuse. Specific arms
(`Nothing`, `[]`, `([], True)`) are skipped so a later true catch-all can win.
-}
firstCatchAllFallback : List ( Node Pattern, Node Expression ) -> SyntheticFallback
firstCatchAllFallback cases =
    case cases of
        [] ->
            UseFallbackTodo

        ( patternNode, body ) :: rest ->
            case Node.value (unwrapParenthesized patternNode) of
                AllPattern ->
                    UseFallbackBody body

                TuplePattern components ->
                    if List.all isAllPatternNode components then
                        UseFallbackBody body

                    else if isTupleOpenFallthrough components then
                        -- Open fallthrough like `(other, _)` or `(_, True)` can
                        -- match multi-cons short lists; bindings cannot be
                        -- rebuilt and partial wilds are not total fallthrough.
                        -- Arms that already contain uncons/fixed lists are not
                        -- fallthrough (they are the multi-cons arms themselves).
                        CannotSynthesizeFallback

                    else
                        firstCatchAllFallback rest

                NamedPattern qualifiedName args ->
                    case args of
                        [ inner ] ->
                            if isMapWrapperCtor qualifiedName then
                                case Node.value (unwrapParenthesized inner) of
                                    AllPattern ->
                                        UseFallbackBody body

                                    _ ->
                                        if isUnusableCatchAllPattern (unwrapParenthesized inner) then
                                            CannotSynthesizeFallback

                                        else
                                            firstCatchAllFallback rest

                            else
                                firstCatchAllFallback rest

                        _ ->
                            firstCatchAllFallback rest

                _ ->
                    if isUnusableCatchAllPattern patternNode then
                        CannotSynthesizeFallback

                    else
                        firstCatchAllFallback rest


isAllPatternNode : Node Pattern -> Bool
isAllPatternNode patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        AllPattern ->
            True

        _ ->
            False


{-| Wildcard or binding that can match multi-cons short-list fallthrough.
-}
isOpenCatchAllPattern : Node Pattern -> Bool
isOpenCatchAllPattern patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        AllPattern ->
            True

        VarPattern _ ->
            True

        AsPattern inner _ ->
            isUnusableCatchAllPattern patternNode
                || isOpenCatchAllPattern (unwrapParenthesized inner)

        TuplePattern components ->
            List.any isOpenCatchAllPattern components

        NamedPattern _ [ inner ] ->
            isOpenCatchAllPattern inner

        _ ->
            False


{-| Tuple arm that can absorb multi-cons short-list fallthrough without being a
list/uncons match itself: e.g. `(other, _)`, `(_, True)`. Multi-cons arms like
`(x :: y :: rest, n)` are not fallthrough.
-}
isTupleOpenFallthrough : List (Node Pattern) -> Bool
isTupleOpenFallthrough components =
    not (List.any isPositiveListMatch components)
        && List.any isOpenCatchAllPattern components


{-| Fixed non-empty list or uncons: a real list-shape match, not fallthrough.
-}
isPositiveListMatch : Node Pattern -> Bool
isPositiveListMatch patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        UnConsPattern _ _ ->
            True

        ListPattern members ->
            not (List.isEmpty members)

        AsPattern inner _ ->
            isPositiveListMatch (unwrapParenthesized inner)

        _ ->
            False


{-| `Just` / `Ok` wrappers rewritten via `Maybe.map` / `Result.map` popFirst.
-}
isMapWrapperCtor : { moduleName : List String, name : String } -> Bool
isMapWrapperCtor qualifiedName =
    let
        name : String
        name =
            qualifiedName.name

        modules : List String
        modules =
            qualifiedName.moduleName
    in
    (name == "Just" || name == "Ok")
        && (modules
                == []
                || modules
                == [ "Maybe" ]
                || modules
                == [ "Result" ]
           )


{-| First arm that would match `Ctor []` after an uncons arm fails to.

Same-ctor `[]` and top-level `_` are pasteable. Same-ctor catch-all args and
top-level named catch-alls refuse. Later `Ctor []` after a catch-all must not
override the earlier match.
-}
firstEmptyListFallback : String -> List ( Node Pattern, Node Expression ) -> SyntheticFallback
firstEmptyListFallback ctorName cases =
    case cases of
        [] ->
            UseFallbackTodo

        ( patternNode, body ) :: rest ->
            case Node.value (unwrapParenthesized patternNode) of
                NamedPattern qualifiedName args ->
                    if qualifiedName.name /= ctorName then
                        firstEmptyListFallback ctorName rest

                    else if List.any isEmptyListArg args then
                        UseFallbackBody body

                    else if List.any isCatchAllArg args then
                        CannotSynthesizeFallback

                    else
                        firstEmptyListFallback ctorName rest

                AllPattern ->
                    UseFallbackBody body

                _ ->
                    if isUnusableCatchAllPattern patternNode then
                        CannotSynthesizeFallback

                    else
                        firstEmptyListFallback ctorName rest


{-| Catch-all that matches any value but cannot be inlined into a synthetic
arm: the binding would be missing or wrong. Bare `_` is handled separately via
`firstCatchAllFallback`.
-}
isUnusableCatchAllPattern : Node Pattern -> Bool
isUnusableCatchAllPattern patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        VarPattern _ ->
            True

        AsPattern inner _ ->
            case Node.value (unwrapParenthesized inner) of
                AllPattern ->
                    True

                VarPattern _ ->
                    True

                _ ->
                    isUnusableCatchAllPattern (unwrapParenthesized inner)

        _ ->
            False


{-| Argument that matches any list length under a constructor (empty included).
-}
isCatchAllArg : Node Pattern -> Bool
isCatchAllArg arg =
    case Node.value (unwrapParenthesized arg) of
        AllPattern ->
            True

        VarPattern _ ->
            True

        AsPattern inner _ ->
            case Node.value (unwrapParenthesized inner) of
                AllPattern ->
                    True

                VarPattern _ ->
                    True

                _ ->
                    isCatchAllArg (unwrapParenthesized inner)

        _ ->
            False


hasExactEmptyEmbeddedUncons : List (Node Pattern) -> Bool
hasExactEmptyEmbeddedUncons patterns =
    List.any
        (\patternNode ->
            case Node.value (unwrapParenthesized patternNode) of
                NamedPattern _ [ arg ] ->
                    case parseConsChain (unwrapParenthesized arg) of
                        Just chain ->
                            isEmptyListRest chain.rest

                        Nothing ->
                            False

                _ ->
                    False
        )
        patterns


{-| Exact embedded uncons peels with a nested empty-rest guard. Sibling arms on
the same constructor argument that can match a longer list would be skipped, so
refuse those combinations. Top-level `_` is handled via lengthMismatchFallback.
-}
embeddedExactEmptySiblingOk : List (Node Pattern) -> Bool
embeddedExactEmptySiblingOk patterns =
    let
        exactSlots : List ( String, Int, Int )
        exactSlots =
            List.concatMap embeddedExactEmptySlot patterns

        slotOk : ( String, Int, Int ) -> Bool
        slotOk ( ctorName, argIndex, n ) =
            not
                (List.any
                    (\patternNode ->
                        case Node.value (unwrapParenthesized patternNode) of
                            NamedPattern qualifiedName args ->
                                if qualifiedName.name /= ctorName then
                                    False

                                else
                                    case args |> List.drop argIndex |> List.head of
                                        Just arg ->
                                            canMatchListLongerThan n arg

                                        Nothing ->
                                            False

                            _ ->
                                False
                    )
                    patterns
                )
    in
    List.all slotOk exactSlots


{-| `(ctorName, argIndex, headCount)` for single-arg `Ctor (h1 :: … :: [])`.
-}
embeddedExactEmptySlot : Node Pattern -> List ( String, Int, Int )
embeddedExactEmptySlot (Node _ pattern) =
    case pattern of
        NamedPattern qualifiedName [ arg ] ->
            case parseConsChain (unwrapParenthesized arg) of
                Just chain ->
                    if isEmptyListRest chain.rest then
                        [ ( qualifiedName.name, 0, List.length chain.heads ) ]

                    else
                        []

                Nothing ->
                    []

        _ ->
            []


{-| Depth of an UnCons chain only (not fixed `[...]` patterns).
-}
unconsChainDepth : Node Pattern -> Maybe Int
unconsChainDepth patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        UnConsPattern _ _ ->
            parseConsChain (unwrapParenthesized patternNode)
                |> Maybe.map (\chain -> List.length chain.heads)

        AsPattern inner _ ->
            case asUnconsParts inner of
                Just _ ->
                    Just 1

                Nothing ->
                    Nothing

        _ ->
            Nothing


casePatternListDepth : Node Pattern -> Maybe Int
casePatternListDepth patternNode =
    case Node.value patternNode of
        ParenthesizedPattern inner ->
            casePatternListDepth inner

        ListPattern members ->
            if List.any patternContainsUncons members then
                Nothing

            else
                Just (List.length members)

        UnConsPattern _ _ ->
            parseConsChain patternNode
                |> Maybe.map (\chain -> List.length chain.heads)

        AsPattern inner _ ->
            case asUnconsParts inner of
                Just _ ->
                    Just 1

                Nothing ->
                    parseConsChain (unwrapParenthesized inner)
                        |> Maybe.map (\chain -> List.length chain.heads)

        _ ->
            Nothing


{-| Body used when a nested multi-cons peel fails (list too short). Prefer the
first catch-all `_` body in case order so length-deficient lists keep Elm
fallthrough semantics. Named catch-alls are rejected by the rewrite gate.

Only copy-safe expressions are inlined: the fallback text is pasted into a
synthetic branch and does not receive ordinary source edits (case/when, ::, …).
-}
nothingMatchFallback : String -> List ( Node Pattern, Node Expression ) -> ModuleContext -> String
nothingMatchFallback todoMessage cases context =
    renderSyntheticFallback todoMessage (firstCatchAllFallback cases) context


{-| Fallback for embedded constructor uncons: first arm that would match
`Ctor []` in Elm order (same-ctor `[]`, else leading `_`), else Debug.todo.
-}
embeddedUnconsFallback : String -> String -> List ( Node Pattern, Node Expression ) -> ModuleContext -> String
embeddedUnconsFallback todoMessage ctorName cases context =
    renderSyntheticFallback todoMessage (firstEmptyListFallback ctorName cases) context


renderSyntheticFallback : String -> SyntheticFallback -> ModuleContext -> String
renderSyntheticFallback todoMessage choice context =
    case choice of
        UseFallbackBody body ->
            copySafeFallbackText todoMessage body context

        UseFallbackTodo ->
            "Debug.todo \"" ++ todoMessage ++ "\""

        CannotSynthesizeFallback ->
            "Debug.todo \"" ++ todoMessage ++ "\""


copySafeFallbackText : String -> Node Expression -> ModuleContext -> String
copySafeFallbackText todoMessage body context =
    if isCopySafeFallbackExpression body then
        grenFallbackExpression context body

    else
        "Debug.todo \"" ++ todoMessage ++ "\""


{-| Render a fallback expression as Gren text: tuples become records, and the
result is flattened to one line so nested peel inserts stay well-indented.
-}
grenFallbackExpression : ModuleContext -> Node Expression -> String
grenFallbackExpression context (Node range expression) =
    case expression of
        TupledExpression members ->
            let
                fields =
                    members
                        |> List.indexedMap
                            (\index member ->
                                fieldLabel index ++ " = " ++ grenFallbackExpression context member
                            )
                        |> String.join ", "
            in
            "{ " ++ fields ++ " }"

        ParenthesizedExpression inner ->
            "(" ++ grenFallbackExpression context inner ++ ")"

        UnitExpr ->
            "{}"

        _ ->
            context.extract range
                |> String.words
                |> String.join " "


isEmptyListArg : Node Pattern -> Bool
isEmptyListArg arg =
    case Node.value (unwrapParenthesized arg) of
        ListPattern [] ->
            True

        _ ->
            False


isLowercaseIdentifier : String -> Bool
isLowercaseIdentifier name =
    case String.uncons name of
        Just ( first, _ ) ->
            Char.isLower first

        Nothing ->
            False


{-| Expressions safe to paste into a synthetic Nothing branch without re-running
the expression visitor. Anything needing case/when, tuple, unit, ::, or
multi-arg constructor rewrites must not be copied from source text.

Multi-line expressions are refused: the fallback is pasted after a fixed indent
and later lines keep their original columns, which breaks Gren layout.
-}
isCopySafeFallbackExpression : Node Expression -> Bool
isCopySafeFallbackExpression (Node _ expression) =
    -- Multi-line is allowed: `copySafeFallbackText` collapses whitespace so
    -- nested Nothing arms stay valid Gren. Tuples are emitted as Gren records.
    case expression of
        Integer _ ->
            True

        Hex _ ->
            True

        Floatable _ ->
            True

        Literal _ ->
            True

        CharLiteral _ ->
            True

        FunctionOrValue _ _ ->
            True

        UnitExpr ->
            True

        PrefixOperator operator ->
            operator /= "::"

        OperatorApplication operator _ left right ->
            operator
                /= "::"
                && isCopySafeFallbackExpression left
                && isCopySafeFallbackExpression right

        Negation inner ->
            isCopySafeFallbackExpression inner

        ParenthesizedExpression inner ->
            isCopySafeFallbackExpression inner

        TupledExpression members ->
            -- Pasted as `{ first = …, second = … }` (see copySafeFallbackText).
            List.length members
                <= 3
                && List.all isCopySafeFallbackExpression members

        Application values ->
            -- Multi-arg constructors need record-payload rewrites. Unary
            -- constructors (Just x, Ok x, custom unary) keep the same form in
            -- Gren, so they are safe to paste when the argument is.
            case values of
                (Node _ (FunctionOrValue _ name)) :: rest ->
                    List.all isCopySafeFallbackExpression rest
                        && (isLowercaseIdentifier name || List.length rest == 1)

                _ ->
                    False

        IfBlock condition ifTrue ifFalse ->
            isCopySafeFallbackExpression condition
                && isCopySafeFallbackExpression ifTrue
                && isCopySafeFallbackExpression ifFalse

        ListExpr elements ->
            List.all isCopySafeFallbackExpression elements

        RecordExpr setters ->
            List.all
                (\(Node _ ( _, value )) -> isCopySafeFallbackExpression value)
                setters

        RecordAccess record _ ->
            isCopySafeFallbackExpression record

        RecordAccessFunction _ ->
            True

        _ ->
            False
{-| Inner list shapes under single-arg wrappers (`Just`, `Ok`) plus top-level
`_`, for multi-cons fallthrough checks on Maybe/Result cases.
-}
wrappedListShapePatterns : List (Node Pattern) -> List (Node Pattern)
wrappedListShapePatterns patterns =
    List.concatMap
        (\patternNode ->
            case Node.value (unwrapParenthesized patternNode) of
                AllPattern ->
                    [ patternNode ]

                NamedPattern _ [ inner ] ->
                    [ inner ]

                _ ->
                    []
        )
        patterns


{-| Tuple-component list shapes (plus top-level `_`) for multi-cons safety.
-}
tupleListShapePatterns : Elm.Syntax.Expression.CaseBlock -> List (Node Pattern)
tupleListShapePatterns caseBlock =
    caseBlock.cases
        |> List.concatMap
            (\( patternNode, _ ) ->
                case Node.value (unwrapParenthesized patternNode) of
                    AllPattern ->
                        [ patternNode ]

                    TuplePattern comps ->
                        comps

                    _ ->
                        []
            )


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
            -- Keep `xs as ys` / `_ as ys`. Exact `[] as name` needs a binding the
            -- nested empty-guard path cannot reconstruct, so refuse the chain.
            case Node.value (unwrapParenthesized inner) of
                ListPattern [] ->
                    False

                _ ->
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


collectArrayCase : List ( Node Pattern, Node Expression ) -> String -> ( Node Pattern, Node Expression ) -> ModuleContext -> ModuleContext
collectArrayCase cases shortMatchFallback ( patternNode, body ) context =
    if isSubsumedShorterOpenRestArm cases patternNode then
        -- Multi-cons nesting already handles this exact length via nested
        -- Nothing peels. Drop the redundant arm so Gren does not see two
        -- Just { first, rest } patterns for the same shape.
        removeCaseArm patternNode body context

    else
        case Node.value patternNode of
            AsPattern inner asName ->
                case asUnconsParts inner of
                    Just _ ->
                        collectAsUnconsPattern patternNode inner asName body context

                    Nothing ->
                        collectArrayCasePatternWithBody cases shortMatchFallback patternNode body context

            _ ->
                collectArrayCasePatternWithBody cases shortMatchFallback patternNode body context


{-| Open-rest arm whose lengths are already covered by a deeper multi-cons arm
rewritten with length-specific nested Nothing peels.
-}
isSubsumedShorterOpenRestArm : List ( Node Pattern, Node Expression ) -> Node Pattern -> Bool
isSubsumedShorterOpenRestArm cases patternNode =
    case parseConsChain (unwrapParenthesized patternNode) of
        Just chain ->
            let
                depth =
                    List.length chain.heads

                maxMulti =
                    cases
                        |> List.map Tuple.first
                        |> List.filterMap unconsChainDepth
                        |> List.maximum
                        |> Maybe.withDefault 0
            in
            depth
                > 0
                && depth
                < maxMulti
                && not (isEmptyListRest chain.rest)
                && not (isNamedRestPattern chain.rest)

        Nothing ->
            False


{-| Delete a whole `pattern -> body` arm (including the arrow).
-}
removeCaseArm : Node Pattern -> Node Expression -> ModuleContext -> ModuleContext
removeCaseArm patternNode body context =
    let
        patternRange =
            Node.range patternNode

        bodyRange =
            Node.range body

        armRange =
            { start = patternRange.start
            , end = bodyRange.end
            }
    in
    addEdit Types.ListConsPattern armRange "" context


{-| Rewrite a list/uncons pattern already in an `Array.popFirst` scrutinee
context. Multi-cons chains inject nested `when Array.popFirst` into the branch
body (same technique as as-uncons).
-}
collectArrayCasePatternWithBody : List ( Node Pattern, Node Expression ) -> String -> Node Pattern -> Node Expression -> ModuleContext -> ModuleContext
collectArrayCasePatternWithBody cases shortMatchFallback patternNode body context =
    case parseConsChain patternNode of
        Just chain ->
            collectConsChainInPopFirst cases shortMatchFallback patternNode chain body context

        Nothing ->
            if canRewriteCtorHeadUncons patternNode then
                collectCtorHeadUnconsInPopFirst shortMatchFallback patternNode body context

            else
                collectArrayCasePattern patternNode context


{-| Outer list arm whose head is a constructor carrying nested list uncons, e.g.
`(MediaRule mq (sb :: [])) :: []`. Bind the head value, then peel nested lists
in the body the same way as collectCtorEmbeddedUnconsCase.
-}
collectCtorHeadUnconsInPopFirst : String -> Node Pattern -> Node Expression -> ModuleContext -> ModuleContext
collectCtorHeadUnconsInPopFirst shortMatchFallback patternNode body context =
    case Node.value (unwrapParenthesized patternNode) of
        UnConsPattern left right ->
            case Node.value (unwrapParenthesized left) of
                NamedPattern qualifiedName args ->
                    let
                        unconsRange : Range
                        unconsRange =
                            Node.range (unwrapParenthesized patternNode)

                        headName : String
                        headName =
                            syntheticRestName unconsRange ++ "_head"

                        restText : String
                        restText =
                            restPatternText context right

                        -- Outer peel: bind head value, then match ctor + peel nested lists.
                        withOuterFixed : ModuleContext
                        withOuterFixed =
                            context
                                |> addEdit Types.ListConsPattern
                                    unconsRange
                                    ("Just { first = " ++ headName ++ ", rest = " ++ restText ++ " }")

                        bodyCol : Int
                        bodyCol =
                            (Node.range body).start.column

                        pad : Int -> String
                        pad n =
                            String.repeat (max 0 n) " "

                        ctorName : String
                        ctorName =
                            case qualifiedName.moduleName of
                                [] ->
                                    qualifiedName.name

                                modules ->
                                    String.join "." modules ++ "." ++ qualifiedName.name

                        -- Build ctor match + embedded peels as body prefix.
                        -- Multi-arg → Gren record; uncons args → synthetic list names.
                        preparedArgs :
                            List
                                { text : String
                                , uncons : Maybe ConsChain
                                , listName : String
                                , argRange : Range
                                }
                        preparedArgs =
                            args
                                |> List.indexedMap
                                    (\index arg ->
                                        let
                                            argRange =
                                                Node.range arg

                                            listName =
                                                syntheticRestName argRange ++ "_list"
                                        in
                                        case parseConsChain (unwrapParenthesized arg) of
                                            Just chain ->
                                                { text = listName
                                                , uncons = Just chain
                                                , listName = listName
                                                , argRange = argRange
                                                }

                                            Nothing ->
                                                { text = grenPatternText context arg
                                                , uncons = Nothing
                                                , listName = listName
                                                , argRange = argRange
                                                }
                                    )

                        ctorMatch : String
                        ctorMatch =
                            case preparedArgs of
                                [] ->
                                    ctorName

                                [ only ] ->
                                    ctorName ++ " " ++ only.text

                                many ->
                                    ctorName
                                        ++ " { "
                                        ++ (many
                                                |> List.indexedMap
                                                    (\index item ->
                                                        fieldLabel index ++ " = " ++ item.text
                                                    )
                                                |> String.join ", "
                                           )
                                        ++ " }"

                        emptyListFallback : String
                        emptyListFallback =
                            shortMatchFallback

                        lengthMismatchFallback : String
                        lengthMismatchFallback =
                            shortMatchFallback

                        peels : { prefix : String, suffix : String }
                        peels =
                            preparedArgs
                                |> List.foldl
                                    (\item acc ->
                                        case item.uncons of
                                            Nothing ->
                                                acc

                                            Just chain ->
                                                case chain.heads of
                                                    [] ->
                                                        acc

                                                    firstHead :: moreHeads ->
                                                        let
                                                            exactEmptyRest =
                                                                isEmptyListRest chain.rest

                                                            firstRest =
                                                                if List.isEmpty moreHeads then
                                                                    if exactEmptyRest then
                                                                        item.listName ++ "_e"

                                                                    else
                                                                        restPatternText context chain.rest

                                                                else
                                                                    item.listName ++ "_n0"

                                                            needsEmptyGuard =
                                                                List.isEmpty moreHeads && exactEmptyRest

                                                            open =
                                                                "when Array.popFirst "
                                                                    ++ item.listName
                                                                    ++ " is\n"
                                                                    ++ pad (bodyCol - 1 + 4)
                                                                    ++ "Just { first = "
                                                                    ++ grenPatternText context firstHead
                                                                    ++ ", rest = "
                                                                    ++ firstRest
                                                                    ++ " } ->\n"
                                                                    ++ pad (bodyCol - 1 + 8)
                                                                    ++ (if needsEmptyGuard then
                                                                            "when "
                                                                                ++ firstRest
                                                                                ++ " is\n"
                                                                                ++ pad (bodyCol - 1 + 12)
                                                                                ++ "[] ->\n"
                                                                                ++ pad (bodyCol - 1 + 16)

                                                                        else
                                                                            ""
                                                                       )

                                                            close =
                                                                (if needsEmptyGuard then
                                                                    "\n"
                                                                        ++ pad (bodyCol - 1 + 12)
                                                                        ++ "_ ->\n"
                                                                        ++ pad (bodyCol - 1 + 16)
                                                                        ++ lengthMismatchFallback

                                                                 else
                                                                    ""
                                                                )
                                                                    ++ "\n"
                                                                    ++ pad (bodyCol - 1 + 4)
                                                                    ++ "Nothing ->\n"
                                                                    ++ pad (bodyCol - 1 + 8)
                                                                    ++ emptyListFallback

                                                            deeper =
                                                                if List.isEmpty moreHeads then
                                                                    { prefix = "", suffix = "" }

                                                                else
                                                                    nestedPopWrap [] lengthMismatchFallback moreHeads chain.rest firstRest body context
                                                        in
                                                        { prefix = acc.prefix ++ open ++ deeper.prefix
                                                        , suffix = deeper.suffix ++ close ++ acc.suffix
                                                        }
                                    )
                                    { prefix = "", suffix = "" }

                        openCtor : String
                        openCtor =
                            "when "
                                ++ headName
                                ++ " is\n"
                                ++ pad (bodyCol - 1 + 4)
                                ++ ctorMatch
                                ++ " ->\n"
                                ++ pad (bodyCol - 1 + 8)

                        closeCtor : String
                        closeCtor =
                            "\n"
                                ++ pad (bodyCol - 1 + 4)
                                ++ "_ ->\n"
                                ++ pad (bodyCol - 1 + 8)
                                ++ shortMatchFallback
                    in
                    withOuterFixed
                        |> addInsertion Types.ListConsExpression
                            (Node.range body).start
                            (openCtor ++ peels.prefix)
                        |> addInsertion Types.ListConsExpression
                            (Node.range body).end
                            (peels.suffix ++ closeCtor)
                        -- Scan nested patterns for reserved names only.
                        |> (\ctx -> List.foldl collectPattern ctx args)
                        |> collectPattern right

                _ ->
                    collectArrayCasePattern patternNode context

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
            -- Depth-1 only. Multi-cons goes through WithBody.
            context
                |> addInsertion Types.ListConsPattern (Node.range left).start "Just { first = "
                |> addConsSeparatorEdit Types.ListConsPattern left right ", rest = "
                |> addInsertion Types.ListConsPattern (Node.range right).end " }"
                |> collectPattern left
                |> collectPattern right

        _ ->
            collectPattern patternNode context


{-| Rewrite `h1 :: h2 :: ... :: rest` under an outer `Array.popFirst`.

The pattern becomes `Just { first = h1, rest = rest0 }` and each additional
head is peeled with a nested `when Array.popFirst` wrapping the branch body.
-}
collectConsChainInPopFirst : List ( Node Pattern, Node Expression ) -> String -> Node Pattern -> ConsChain -> Node Expression -> ModuleContext -> ModuleContext
collectConsChainInPopFirst cases shortMatchFallback patternNode chain body context =
    case chain.heads of
        [] ->
            collectPattern patternNode context

        firstHead :: moreHeads ->
            let
                -- Use the uncons span, not outer parentheses, so
                -- `Just (x :: xs)` keeps its closing `)`.
                unconsRange : Range
                unconsRange =
                    Node.range (unwrapParenthesized patternNode)

                needsNesting : Bool
                needsNesting =
                    not (List.isEmpty moreHeads)

                restName : String
                restName =
                    if needsNesting then
                        syntheticRestName unconsRange

                    else
                        restPatternText context chain.rest

                withOuter : ModuleContext
                withOuter =
                    context
                        |> addInsertion Types.ListConsPattern (Node.range firstHead).start "Just { first = "
                        |> addEdit Types.ListConsPattern
                            { start = (Node.range firstHead).end
                            , end = unconsRange.end
                            }
                            (", rest = " ++ restName ++ " }")
                        |> collectPattern firstHead
                        -- Rest/later heads are deleted by the edit above; still
                        -- collect for reserved-name diagnostics on their text.
                        |> (\ctx -> List.foldl collectPattern ctx moreHeads)
                        |> collectPattern chain.rest

                nested : { prefix : String, suffix : String }
                nested =
                    if needsNesting then
                        nestedPopWrap cases shortMatchFallback moreHeads chain.rest restName body context

                    else
                        { prefix = "", suffix = "" }
            in
            withOuter
                |> (if String.isEmpty nested.prefix then
                        identity

                    else
                        addInsertion Types.ListConsExpression (Node.range body).start nested.prefix
                   )
                |> (if String.isEmpty nested.suffix then
                        identity

                    else
                        addInsertion Types.ListConsExpression (Node.range body).end nested.suffix
                   )


restPatternText : ModuleContext -> Node Pattern -> String
restPatternText context restNode =
    case Node.value (unwrapParenthesized restNode) of
        VarPattern name ->
            name

        AllPattern ->
            "_"

        ListPattern [] ->
            "[]"

        _ ->
            -- Keep `as` bindings and other rest patterns as source text.
            context.extract (Node.range restNode)


syntheticRestName : Range -> String
syntheticRestName range =
    "rest_r" ++ String.fromInt range.start.row ++ "_c" ++ String.fromInt range.start.column ++ "_elmToGren"


{-| Nested `when Array.popFirst` around a multi-cons branch body.

Prefix opens each Just arm; suffix closes each Nothing arm after the body so
the generated Gren remains a complete `when` expression.

Indentation is absolute from the original body column. Level 0 `when` is
inserted at the body column; each peel uses +4 for the branch patterns and +8
for the branch body (where a deeper `when` may start). Using `level+1` /
`level+2` alone puts a nested `when` and its `Just` arm on the same column
(invalid Gren layout for chains of three or more cons cells).

Exact-length tails (`h1 :: h2 :: []`) cannot use `rest = []` inside a nested
`Just` arm: Gren requires that `when` to cover every `Just` shape. The last
peel therefore binds a synthetic rest and guards with `when rest is [] -> ...`.
-}
nestedPopWrap : List ( Node Pattern, Node Expression ) -> String -> List (Node Pattern) -> Node Pattern -> String -> Node Expression -> ModuleContext -> { prefix : String, suffix : String }
nestedPopWrap cases shortMatchFallback heads finalRest firstRestName body context =
    let
        bodyCol : Int
        bodyCol =
            (Node.range body).start.column

        -- n is in steps of 4 columns from the body column (n=0).
        indent : Int -> String
        indent n =
            String.repeat (max 0 (bodyCol - 1 + n * 4)) " "

        exactEmptyRest : Bool
        exactEmptyRest =
            isEmptyListRest finalRest

        build : Int -> String -> List (Node Pattern) -> { prefix : String, suffix : String }
        build level restName remaining =
            case remaining of
                [] ->
                    { prefix = "", suffix = "" }

                head :: more ->
                    let
                        isLast : Bool
                        isLast =
                            List.isEmpty more

                        nextRest : String
                        nextRest =
                            if isLast then
                                if exactEmptyRest then
                                    restName ++ "_n" ++ String.fromInt level ++ "_e"

                                else
                                    restPatternText context finalRest

                            else
                                restName ++ "_n" ++ String.fromInt level

                        headText : String
                        headText =
                            grenPatternText context head

                        deeper : { prefix : String, suffix : String }
                        deeper =
                            build (level + 1) nextRest more

                        -- when at bodyCol + 8*level (via parent body indent);
                        -- Just/Nothing at +4; nested body / next when at +8.
                        branchIndent : Int
                        branchIndent =
                            2 * level + 1

                        bodyIndent : Int
                        bodyIndent =
                            2 * level + 2

                        needsEmptyGuard : Bool
                        needsEmptyGuard =
                            isLast && exactEmptyRest

                        -- Outer Just already bound one head; each nested peel
                        -- level binds one more. Nothing at this level means the
                        -- scrutinee length was exactly (level + 1).
                        exactLengthForNothing : Int
                        exactLengthForNothing =
                            level + 1

                        lengthFallback : String
                        lengthFallback =
                            if List.isEmpty cases then
                                shortMatchFallback

                            else
                                renderSyntheticFallback
                                    "elm-to-gren: multi-cons did not match"
                                    (firstArmMatchingExactLength exactLengthForNothing cases)
                                    context

                        open : String
                        open =
                            "when Array.popFirst "
                                ++ restName
                                ++ " is\n"
                                ++ indent branchIndent
                                ++ "Just { first = "
                                ++ headText
                                ++ ", rest = "
                                ++ nextRest
                                ++ " } ->\n"
                                ++ indent bodyIndent
                                ++ (if needsEmptyGuard then
                                        "when "
                                            ++ nextRest
                                            ++ " is\n"
                                            ++ indent (bodyIndent + 1)
                                            ++ "[] ->\n"
                                            ++ indent (bodyIndent + 2)

                                    else
                                        ""
                                   )

                        close : String
                        close =
                            (if needsEmptyGuard then
                                "\n"
                                    ++ indent (bodyIndent + 1)
                                    ++ "_ ->\n"
                                    ++ indent (bodyIndent + 2)
                                    ++ shortMatchFallback

                             else
                                ""
                            )
                                ++ "\n"
                                ++ indent branchIndent
                                ++ "Nothing ->\n"
                                ++ indent bodyIndent
                                ++ lengthFallback
                    in
                    { prefix = open ++ deeper.prefix
                    , suffix = deeper.suffix ++ close
                    }
    in
    build 0 firstRestName heads


{-| True when the pattern is a fixed empty list (`[]`), after parentheses.
-}
isEmptyListRest : Node Pattern -> Bool
isEmptyListRest patternNode =
    case Node.value (unwrapParenthesized patternNode) of
        ListPattern [] ->
            True

        _ ->
            False


{-| Render a pattern as Gren text for injection into synthetic branches.

Used when the original pattern span is deleted (multi-cons tails, embedded
uncons args) so tuple/unit/multi-arg constructor shapes still become Gren.
-}
grenPatternText : ModuleContext -> Node Pattern -> String
grenPatternText context patternNode =
    case Node.value patternNode of
        AllPattern ->
            "_"

        UnitPattern ->
            "{}"

        VarPattern name ->
            name

        CharPattern _ ->
            context.extract (Node.range patternNode)

        StringPattern _ ->
            context.extract (Node.range patternNode)

        IntPattern value ->
            String.fromInt value

        HexPattern _ ->
            context.extract (Node.range patternNode)

        FloatPattern _ ->
            context.extract (Node.range patternNode)

        ParenthesizedPattern inner ->
            "(" ++ grenPatternText context inner ++ ")"

        TuplePattern members ->
            "{ "
                ++ (members
                        |> List.indexedMap
                            (\index member ->
                                fieldLabel index ++ " = " ++ grenPatternText context member
                            )
                        |> String.join ", "
                   )
                ++ " }"

        ListPattern members ->
            "["
                ++ (members
                        |> List.map (grenPatternText context)
                        |> String.join ", "
                   )
                ++ "]"

        RecordPattern fields ->
            "{ "
                ++ (fields
                        |> List.map Node.value
                        |> String.join ", "
                   )
                ++ " }"

        NamedPattern qualifiedName args ->
            let
                name : String
                name =
                    case qualifiedName.moduleName of
                        [] ->
                            qualifiedName.name

                        modules ->
                            String.join "." modules ++ "." ++ qualifiedName.name
            in
            case args of
                [] ->
                    name

                single :: [] ->
                    name ++ " " ++ grenPatternText context single

                first :: rest ->
                    name
                        ++ " { "
                        ++ ((first :: rest)
                                |> List.indexedMap
                                    (\index arg ->
                                        fieldLabel index ++ " = " ++ grenPatternText context arg
                                    )
                                |> String.join ", "
                           )
                        ++ " }"

        AsPattern inner asName ->
            grenPatternText context inner ++ " as " ++ Node.value asName

        UnConsPattern _ _ ->
            context.extract (Node.range patternNode)

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
                componentOk component =
                    case Node.value (unwrapParenthesized component) of
                        ListPattern comps ->
                            not (List.any patternContainsUncons comps)

                        AllPattern ->
                            True

                        UnConsPattern _ _ ->
                            canRewriteUnconsChain (unwrapParenthesized component)

                        _ ->
                            -- Non-list columns (constructors, vars, records, …)
                            -- are allowed when they contain no uncons of their own.
                            not (patternContainsUncons component)

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


{-| Multi-cons (depth >= 2) injects nested `when` wrappers at the branch body
start/end. Co-located insertions from two columns would merge by string order
and can mis-nest, so allow at most one column that needs a body wrap.
-}
tupleMultiConsBodyWrapOk : Elm.Syntax.Expression.CaseBlock -> Bool
tupleMultiConsBodyWrapOk caseBlock =
    let
        columnNeedsBodyWrap : Int -> Bool
        columnNeedsBodyWrap index =
            List.any
                (\( patternNode, _ ) ->
                    case Node.value (unwrapParenthesized patternNode) of
                        TuplePattern comps ->
                            case comps |> List.drop index |> List.head of
                                Just component ->
                                    case unconsChainDepth component of
                                        Just depth ->
                                            depth >= 2

                                        Nothing ->
                                            False

                                Nothing ->
                                    False

                        _ ->
                            False
                )
                caseBlock.cases

        arity : Int
        arity =
            case Node.value caseBlock.expression of
                TupledExpression members ->
                    List.length members

                _ ->
                    0

        wrapColumns : Int
        wrapColumns =
            List.range 0 (arity - 1)
                |> List.filter columnNeedsBodyWrap
                |> List.length
    in
    wrapColumns <= 1


collectTupleListCase : String -> Elm.Syntax.Expression.CaseBlock -> ModuleContext -> ModuleContext
collectTupleListCase shortMatchFallback caseBlock context =
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
            (\( patternNode, body ) found ->
                case Node.value patternNode of
                    TuplePattern comps ->
                        let
                            withTuple : ModuleContext
                            withTuple =
                                addTupleEdits Types.TuplePattern "=" (Node.range patternNode) comps found
                        in
                        List.foldl
                            (\comp ctx -> collectArrayCasePatternWithBody [] shortMatchFallback comp body ctx)
                            withTuple
                            comps

                    _ ->
                        found
            )
            withScrutinee


listInnerPatternOk : Node Pattern -> Bool
listInnerPatternOk inner =
    case Node.value (unwrapParenthesized inner) of
        ListPattern comps ->
            not (List.any patternContainsUncons comps)

        AllPattern ->
            True

        UnConsPattern _ _ ->
            canRewriteUnconsChain (unwrapParenthesized inner)

        _ ->
            False


{-| A case over a `Maybe (List a)` whose branches are `Nothing`, `Just []`,
`Just (x :: xs)` (plus optionally `_`). The scrutinee is wrapped in
`Maybe.map Array.popFirst` and the inner list patterns are rewritten in place.
-}
isMaybeUnconsCase : List (Node Pattern) -> Bool
isMaybeUnconsCase patterns =
    let
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
                    isMaybeName qualifiedName "Just" && listInnerPatternOk inner

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


collectMaybeUnconsCase : List ( Node Pattern, Node Expression ) -> String -> ( Node Pattern, Node Expression ) -> ModuleContext -> ModuleContext
collectMaybeUnconsCase cases shortMatchFallback ( patternNode, body ) context =
    case Node.value patternNode of
        NamedPattern _ [ inner ] ->
            case Node.value inner of
                ListPattern (_ :: _) ->
                    -- The rewrite turns `[ x ]` into a constructor
                    -- application, which needs parentheses under `Just`.
                    context
                        |> addInsertion Types.ListConsPattern (Node.range inner).start "("
                        |> addInsertion Types.ListConsPattern (Node.range inner).end ")"
                        |> collectArrayCasePatternWithBody cases shortMatchFallback inner body

                _ ->
                    collectArrayCasePatternWithBody cases shortMatchFallback inner body context

        _ ->
            context


{-| A case over `Result e (List a)` with `Err`, `Ok []`, `Ok (x :: xs)`.
Wrapped with `Result.map Array.popFirst`.
-}
isResultUnconsCase : List (Node Pattern) -> Bool
isResultUnconsCase patterns =
    let
        isResultName : { moduleName : List String, name : String } -> String -> Bool
        isResultName qualifiedName expected =
            qualifiedName.name
                == expected
                && (qualifiedName.moduleName == [] || qualifiedName.moduleName == [ "Result" ])

        patternOk : Node Pattern -> Bool
        patternOk (Node _ pattern) =
            case pattern of
                AllPattern ->
                    True

                NamedPattern qualifiedName [ inner ] ->
                    if isResultName qualifiedName "Err" then
                        -- Result.map only transforms Ok; uncons under Err would
                        -- remain a raw :: pattern after the rewrite.
                        not (patternContainsUncons inner)

                    else if isResultName qualifiedName "Ok" then
                        listInnerPatternOk inner

                    else
                        False

                _ ->
                    False

        hasInnerUncons : Node Pattern -> Bool
        hasInnerUncons (Node _ pattern) =
            case pattern of
                NamedPattern qualifiedName [ inner ] ->
                    isResultName qualifiedName "Ok"
                        && (case Node.value (unwrapParenthesized inner) of
                                UnConsPattern _ _ ->
                                    True

                                _ ->
                                    False
                           )

                _ ->
                    False
    in
    List.any hasInnerUncons patterns && List.all patternOk patterns


collectResultUnconsCase : List ( Node Pattern, Node Expression ) -> String -> ( Node Pattern, Node Expression ) -> ModuleContext -> ModuleContext
collectResultUnconsCase cases shortMatchFallback ( patternNode, body ) context =
    case Node.value patternNode of
        NamedPattern qualifiedName [ inner ] ->
            if qualifiedName.name == "Ok" then
                case Node.value inner of
                    ListPattern (_ :: _) ->
                        context
                            |> addInsertion Types.ListConsPattern (Node.range inner).start "("
                            |> addInsertion Types.ListConsPattern (Node.range inner).end ")"
                            |> collectArrayCasePatternWithBody cases shortMatchFallback inner body

                    _ ->
                        collectArrayCasePatternWithBody cases shortMatchFallback inner body context

            else
                collectPattern patternNode context

        _ ->
            collectPattern patternNode context


{-| Uncons nested under a single-argument non-Maybe/Result constructor, e.g.
`Node (x :: xs)`. The list argument is rebound to a fresh name and the branch
body peels with `Array.popFirst`. Multi-argument constructors are refused: they
need record-payload pattern edits that this path does not apply.
-}
isCtorEmbeddedUnconsCase : List (Node Pattern) -> Bool
isCtorEmbeddedUnconsCase patterns =
    let
        isReservedMapCtor : String -> Bool
        isReservedMapCtor name =
            name == "Just" || name == "Nothing" || name == "Ok" || name == "Err"

        argOk : Node Pattern -> Bool
        argOk arg =
            case Node.value (unwrapParenthesized arg) of
                UnConsPattern _ _ ->
                    -- Single-level only. Multi-cons under arbitrary ctors cannot
                    -- safely fall through to sibling branches like `Box other`.
                    case parseConsChain (unwrapParenthesized arg) of
                        Just chain ->
                            List.length chain.heads == 1

                        Nothing ->
                            False

                ListPattern comps ->
                    not (List.any patternContainsUncons comps)

                AllPattern ->
                    True

                VarPattern _ ->
                    True

                _ ->
                    not (patternContainsUncons arg)

        patternOk : Node Pattern -> Bool
        patternOk (Node _ pattern) =
            case pattern of
                AllPattern ->
                    True

                NamedPattern qualifiedName [] ->
                    -- Nullary sibling; this path does not rewrite it.
                    not (isReservedMapCtor qualifiedName.name)

                NamedPattern qualifiedName args ->
                    -- Multi-arg constructors become Gren records; collectCtorEmbeddedUnconsCase
                    -- rewrites each arg that is an uncons chain and leaves simple args alone.
                    not (isReservedMapCtor qualifiedName.name)
                        && List.all argOk args

                _ ->
                    False

        hasEmbeddedUncons : Node Pattern -> Bool
        hasEmbeddedUncons (Node _ pattern) =
            case pattern of
                NamedPattern _ args ->
                    List.any
                        (\arg ->
                            case Node.value (unwrapParenthesized arg) of
                                UnConsPattern _ _ ->
                                    True

                                _ ->
                                    False
                        )
                        args

                _ ->
                    False
    in
    List.any hasEmbeddedUncons patterns
        && List.all patternOk patterns
        && not (ctorUnconsShadowsCatchAll patterns)


{-| `Box listName` matches empty lists too. A sibling `Box other` / `Box _`
would be unreachable for `[]` after rewrite, so refuse those shapes.
-}
ctorUnconsShadowsCatchAll : List (Node Pattern) -> Bool
ctorUnconsShadowsCatchAll patterns =
    let
        unconsSlots : List ( String, Int )
        unconsSlots =
            List.concatMap ctorUnconsSlots patterns

        catchAllSlots : List ( String, Int )
        catchAllSlots =
            List.concatMap ctorCatchAllSlots patterns
    in
    List.any (\slot -> List.member slot catchAllSlots) unconsSlots


ctorUnconsSlots : Node Pattern -> List ( String, Int )
ctorUnconsSlots (Node _ pattern) =
    case pattern of
        NamedPattern qualifiedName args ->
            args
                |> List.indexedMap Tuple.pair
                |> List.filterMap
                    (\( index, arg ) ->
                        case Node.value (unwrapParenthesized arg) of
                            UnConsPattern _ _ ->
                                Just ( qualifiedName.name, index )

                            _ ->
                                Nothing
                    )

        _ ->
            []


ctorCatchAllSlots : Node Pattern -> List ( String, Int )
ctorCatchAllSlots (Node _ pattern) =
    case pattern of
        NamedPattern qualifiedName args ->
            args
                |> List.indexedMap Tuple.pair
                |> List.filterMap
                    (\( index, arg ) ->
                        case Node.value (unwrapParenthesized arg) of
                            VarPattern _ ->
                                Just ( qualifiedName.name, index )

                            AllPattern ->
                                Just ( qualifiedName.name, index )

                            _ ->
                                Nothing
                    )

        _ ->
            []


collectCtorEmbeddedUnconsCase : List ( Node Pattern, Node Expression ) -> ( Node Pattern, Node Expression ) -> ModuleContext -> ModuleContext
collectCtorEmbeddedUnconsCase cases ( patternNode, body ) context =
    case Node.value patternNode of
        NamedPattern qualifiedName args ->
            let
                -- Empty list after widening `Ctor listName` (Nothing of popFirst).
                emptyListFallback : String
                emptyListFallback =
                    embeddedUnconsFallback
                        "elm-to-gren: embedded uncons did not match"
                        qualifiedName.name
                        cases
                        context

                -- Longer-than-exact tails after `x :: []` peels. Prefer `_`, not
                -- a sibling `Ctor []` body (that arm is for the empty list only).
                lengthMismatchFallback : String
                lengthMismatchFallback =
                    nothingMatchFallback
                        "elm-to-gren: embedded uncons did not match"
                        cases
                        context

                bodyCol : Int
                bodyCol =
                    (Node.range body).start.column

                pad : Int -> String
                pad n =
                    String.repeat (max 0 n) " "
                preparedArgs :
                    List
                        { text : String
                        , uncons : Maybe ConsChain
                        , listName : String
                        , arg : Node Pattern
                        }
                preparedArgs =
                    args
                        |> List.map
                            (\arg ->
                                let
                                    argRange =
                                        Node.range arg

                                    listName =
                                        syntheticRestName argRange ++ "_list"
                                in
                                case parseConsChain (unwrapParenthesized arg) of
                                    Just chain ->
                                        { text = listName
                                        , uncons = Just chain
                                        , listName = listName
                                        , arg = arg
                                        }

                                    Nothing ->
                                        { text = grenPatternText context arg
                                        , uncons = Nothing
                                        , listName = listName
                                        , arg = arg
                                        }
                            )

                ctorName : String
                ctorName =
                    case qualifiedName.moduleName of
                        [] ->
                            qualifiedName.name

                        modules ->
                            String.join "." modules ++ "." ++ qualifiedName.name

                -- Multi-arg constructors must be Gren records; single-arg stays
                -- positional (`Box listName`).
                ctorPattern : String
                ctorPattern =
                    case preparedArgs of
                        [] ->
                            ctorName

                        [ only ] ->
                            ctorName ++ " " ++ only.text

                        many ->
                            ctorName
                                ++ " { "
                                ++ (many
                                        |> List.indexedMap
                                            (\index item ->
                                                fieldLabel index ++ " = " ++ item.text
                                            )
                                        |> String.join ", "
                                   )
                                ++ " }"

                withCtorPattern : ModuleContext
                withCtorPattern =
                    context
                        |> addEdit Types.ListConsPattern (Node.range patternNode) ctorPattern
                        |> (\ctx ->
                                List.foldl
                                    (\item c ->
                                        case item.uncons of
                                            Just chain ->
                                                -- Do not collect the UnCons node itself (that
                                                -- emits a refusal diagnostic); only scan leaves.
                                                c
                                                    |> (\c2 -> List.foldl collectPattern c2 chain.heads)
                                                    |> collectPattern chain.rest

                                            Nothing ->
                                                collectPattern item.arg c
                                    )
                                    ctx
                                    preparedArgs
                           )

                peels : { prefix : String, suffix : String }
                peels =
                    preparedArgs
                        |> List.foldl
                            (\item acc ->
                                case item.uncons of
                                    Nothing ->
                                        acc

                                    Just chain ->
                                        case chain.heads of
                                            [] ->
                                                acc

                                            firstHead :: moreHeads ->
                                                let
                                                    exactEmptyRest =
                                                        isEmptyListRest chain.rest

                                                    firstRest =
                                                        if List.isEmpty moreHeads then
                                                            if exactEmptyRest then
                                                                item.listName ++ "_e"

                                                            else
                                                                restPatternText context chain.rest

                                                        else
                                                            item.listName ++ "_n0"

                                                    needsEmptyGuard =
                                                        List.isEmpty moreHeads && exactEmptyRest

                                                    open =
                                                        "when Array.popFirst "
                                                            ++ item.listName
                                                            ++ " is\n"
                                                            ++ pad (bodyCol - 1 + 4)
                                                            ++ "Just { first = "
                                                            ++ grenPatternText context firstHead
                                                            ++ ", rest = "
                                                            ++ firstRest
                                                            ++ " } ->\n"
                                                            ++ pad (bodyCol - 1 + 8)
                                                            ++ (if needsEmptyGuard then
                                                                    "when "
                                                                        ++ firstRest
                                                                        ++ " is\n"
                                                                        ++ pad (bodyCol - 1 + 12)
                                                                        ++ "[] ->\n"
                                                                        ++ pad (bodyCol - 1 + 16)

                                                                else
                                                                    ""
                                                               )

                                                    close =
                                                        (if needsEmptyGuard then
                                                            "\n"
                                                                ++ pad (bodyCol - 1 + 12)
                                                                ++ "_ ->\n"
                                                                ++ pad (bodyCol - 1 + 16)
                                                                ++ lengthMismatchFallback

                                                         else
                                                            ""
                                                        )
                                                            ++ "\n"
                                                            ++ pad (bodyCol - 1 + 4)
                                                            ++ "Nothing ->\n"
                                                            ++ pad (bodyCol - 1 + 8)
                                                            ++ emptyListFallback

                                                    deeper =
                                                        if List.isEmpty moreHeads then
                                                            { prefix = "", suffix = "" }

                                                        else
                                                            nestedPopWrap [] lengthMismatchFallback moreHeads chain.rest firstRest body context
                                                in
                                                { prefix = acc.prefix ++ open ++ deeper.prefix
                                                , suffix = deeper.suffix ++ close ++ acc.suffix
                                                }
                            )
                            { prefix = "", suffix = "" }
            in
            withCtorPattern
                |> (if String.isEmpty peels.prefix then
                        identity

                    else
                        addInsertion Types.ListConsExpression (Node.range body).start peels.prefix
                   )
                |> (if String.isEmpty peels.suffix then
                        identity

                    else
                        addInsertion Types.ListConsExpression (Node.range body).end peels.suffix
                   )

        _ ->
            collectPattern patternNode context


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
    addResolvedReferenceAt (Node.range node) node name isType context


{-| Like `addResolvedReference`, but the rewrite range may be a sub-span of the
lookup node (e.g. constructor name without pattern payload).
-}
addResolvedReferenceAt : Range -> Node a -> String -> Bool -> ModuleContext -> ModuleContext
addResolvedReferenceAt nodeRange node name isType context =
    case ModuleNameLookupTable.fullModuleNameFor context.lookupTable node of
        Just definingModule ->
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
    namedConstructorFunction extract
        range
        (List.range 0 (arity - 1) |> List.map fieldLabel)


namedConstructorFunction : (Range -> String) -> Range -> List String -> String
namedConstructorFunction extract range fieldNames =
    let
        arguments : List String
        arguments =
            List.indexedMap (\index _ -> "arg" ++ String.fromInt (index + 1) ++ "_elmToGren") fieldNames

        fields : String
        fields =
            List.map2 (\field argument -> field ++ " = " ++ argument) fieldNames arguments
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
    let
        withName : ModuleContext
        withName =
            addReservedIdentifierNode constructor.name context
    in
    if List.length constructor.arguments > 1 then
        addPayloadEdits Types.CustomType ":" constructor.arguments withName

    else
        withName


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
                            let
                                signature =
                                    Node.value signatureNode
                            in
                            withFunctionName
                                |> addReservedIdentifierNode signature.name
                                |> collectTypeAnnotation signature.typeAnnotation

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

                snippet : String
                snippet =
                    context.extract range
                        |> String.replace "\n" " "
                        |> (\s ->
                                if String.length s > 80 then
                                    String.left 77 s ++ "..."

                                else
                                    s
                           )
            in
            addDiagnostic
                { code = "UNMAPPED_SYMBOL"
                , severity = Types.Error
                , message =
                    "List pattern `"
                        ++ snippet
                        ++ "` cannot stay as (::). Gren arrays match with Array.popFirst → Just { first, rest } / Nothing."
                , range = Just range
                , help =
                    Just
                        "Put this pattern in a `case` on the list (with [] / x :: xs / x :: y :: rest arms) so the rewrite can insert Array.popFirst. Function arguments and let-destructuring of (::) are not rewritten yet."
                }
                withChildren

        ListPattern members ->
            List.foldl collectPattern context members

        VarPattern name ->
            addReservedIdentifier range name context

        NamedPattern qualifiedName members ->
            let
                -- Map catalog may rewrite constructor names (Http.BadStatus →
                -- Compat). Range must cover only the name, not the payload.
                constructorRange : Range
                constructorRange =
                    case members of
                        [] ->
                            range

                        first :: _ ->
                            { start = range.start
                            , end = (Node.range first).start
                            }

                withMappedName : ModuleContext
                withMappedName =
                    addResolvedReferenceAt constructorRange patternNode qualifiedName.name False context

                withChildren : ModuleContext
                withChildren =
                    List.foldl collectPattern withMappedName members
            in
            case namedPlatformPayloadFields qualifiedName.moduleName qualifiedName.name of
                Just fieldNames ->
                    -- Gren renames multi-arg constructor payloads to records with
                    -- domain field names (Http Response, Json.Decode.Error, …).
                    -- Prefer those labels over positional first/second even when
                    -- elm-review resolved the constructor from the Elm graph.
                    if List.length members == List.length fieldNames then
                        addNamedPayloadEdits fieldNames members withChildren

                    else
                        addConstructorArityDiagnostic range qualifiedName.name (List.length fieldNames) (List.length members) withChildren

                Nothing ->
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
                                -- Bare Json.Decode.Error constructors often resolve as
                                -- Unresolved when only `import Json.Decode exposing (..)`
                                -- is used. Match the known 2-arg Gren record shapes.
                                case ( qualifiedName.name, List.length members ) of
                                    ( "Field", 2 ) ->
                                        addNamedPayloadEdits [ "name", "error" ] members withChildren

                                    ( "Index", 2 ) ->
                                        addNamedPayloadEdits [ "index", "error" ] members withChildren

                                    ( "Failure", 2 ) ->
                                        addNamedPayloadEdits [ "message", "value" ] members withChildren

                                    _ ->
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
    addNamedPayloadEditsWithSeparator kind
        separator
        (List.indexedMap (\index _ -> fieldLabel index) members)
        members
        context


{-| Gren renames certain multi-arg constructors to a single record payload with
domain field labels. Match by constructor name (module-agnostic) so both
resolved and unresolved references rewrite correctly.
-}
namedPlatformPayloadFields : List String -> String -> Maybe (List String)
namedPlatformPayloadFields moduleParts name =
    let
        moduleName =
            String.join "." moduleParts
    in
    case name of
        -- Distinctive Http.Response constructors (Gren uses named records).
        "BadStatus_" ->
            Just [ "metadata", "body" ]

        "GoodStatus_" ->
            Just [ "metadata", "body" ]

        "BadPayload" ->
            -- Older Http.Error: BadPayload String body → positional pair
            Just [ "first", "second" ]

        "Field" ->
            if moduleName == "Json.Decode" || moduleName == "Decode" then
                Just [ "name", "error" ]

            else
                Nothing

        "Index" ->
            if moduleName == "Json.Decode" || moduleName == "Decode" then
                Just [ "index", "error" ]

            else
                Nothing

        "Failure" ->
            if moduleName == "Json.Decode" || moduleName == "Decode" then
                Just [ "message", "value" ]

            else
                Nothing

        _ ->
            Nothing


{-| Like `addPayloadEdits`, but uses explicit field names (for platform
constructors whose Gren form is a single record payload with known labels).
-}
addNamedPayloadEdits : List String -> List (Node value) -> ModuleContext -> ModuleContext
addNamedPayloadEdits labels members context =
    addNamedPayloadEditsWithSeparator Types.CustomConstructor "=" labels members context


addNamedPayloadEditsWithSeparator : EditKind -> String -> List String -> List (Node value) -> ModuleContext -> ModuleContext
addNamedPayloadEditsWithSeparator kind separator labels members context =
    case ( members, labels ) of
        ( firstMember :: remainingMembers, firstLabel :: remainingLabels ) ->
            let
                withFields : ModuleContext
                withFields =
                    List.map2 Tuple.pair remainingLabels remainingMembers
                        |> List.foldl
                            (\( label, member ) found ->
                                addInsertion kind
                                    (Node.range member).start
                                    (", " ++ label ++ " " ++ separator ++ " ")
                                    found
                            )
                            (addInsertion kind
                                (Node.range firstMember).start
                                ("{ " ++ firstLabel ++ " " ++ separator ++ " ")
                                context
                            )
            in
            case List.reverse members |> List.head of
                Just last ->
                    addInsertion kind (Node.range last).end " }" withFields

                Nothing ->
                    withFields

        _ ->
            context


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
