module ElmToGren.Rule exposing (rule)

{-| Extract a resolved AST (when encodable) plus range edits and reference facts.

**Primary product for the host:** the encoded AST (`Types.ast`). Structural Gren
laws (list peels, multi-arg / record-alias ctors, reserved binders) run on the
host (`Ast.*`). This rule still emits range edits for modules without AST and
for residual non-list shapes so fixtures and the no-AST fallback stay consistent.

Edits are extracted rather than applied via `elm-review --fix` because Gren
syntax is not valid Elm and the fixer would reject them.
-}

import Dict exposing (Dict)
import Elm.Syntax.Declaration exposing (Declaration(..))
import Elm.Syntax.Exposing exposing (Exposing(..), TopLevelExpose(..))
import Elm.Syntax.Expression exposing (Expression(..), LetDeclaration(..))
import Elm.Syntax.File exposing (File)
import Elm.Syntax.Import exposing (Import)
import Elm.Syntax.Module exposing (Module(..))
import Elm.Syntax.Node as Node exposing (Node(..))
import Elm.Syntax.Pattern exposing (Pattern(..), QualifiedNameRef)
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

        -- List/cons case totalization lives on the host (Ast.MatchCompile).
        -- Here we only rename `case` → `when` and scan reserved identifiers.
        -- Do not run collectPattern on arms: that would refuse (::) patterns the
        -- host is about to compile away on the AST path.
        patterns : List (Node Pattern)
        patterns =
            List.map Tuple.first caseBlock.cases
    in
    List.foldl collectCaseArmPatternNames withKeyword patterns


{-| Structural edits + reserved names on case-arm patterns, without refusing `(::)`.

List/cons *totalization* is owned by the host `Ast.MatchCompile` path. Tuple,
unit, and constructor structural edits still apply here so the edit path and
review fixtures stay consistent for non-list shapes.
-}
collectCaseArmPatternNames : Node Pattern -> ModuleContext -> ModuleContext
collectCaseArmPatternNames ((Node range pattern) as patternNode) context =
    case pattern of
        UnitPattern ->
            addEdit Types.Unit range "{}" context

        TuplePattern members ->
            let
                withTuple : ModuleContext
                withTuple =
                    addTupleEdits Types.TuplePattern "=" range members context
            in
            List.foldl collectCaseArmPatternNames withTuple members

        RecordPattern fieldNames ->
            List.foldl addReservedIdentifierNode context fieldNames

        UnConsPattern left right ->
            -- Leave (::) for the host match compiler; still scan leaves.
            collectCaseArmPatternNames right (collectCaseArmPatternNames left context)

        ListPattern members ->
            List.foldl collectCaseArmPatternNames context members

        VarPattern name ->
            addReservedIdentifier range name context

        NamedPattern qualifiedName members ->
            let
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
                    List.foldl collectCaseArmPatternNames withMappedName members
            in
            case namedPlatformPayloadFields qualifiedName.moduleName qualifiedName.name of
                Just fieldNames ->
                    if List.length members == List.length fieldNames then
                        addNamedPayloadEdits fieldNames members withChildren

                    else
                        withChildren

                Nothing ->
                    case resolveReference patternNode qualifiedName.moduleName qualifiedName.name context of
                        Resolved (ConstructorReference constructor) ->
                            if constructor.arity > 1 && constructor.arity == List.length members then
                                addPayloadEdits Types.CustomConstructor "=" members withChildren

                            else
                                withChildren

                        _ ->
                            withChildren

        AsPattern inner asName ->
            collectCaseArmPatternNames inner context
                |> addReservedIdentifierNode asName

        ParenthesizedPattern inner ->
            collectCaseArmPatternNames inner context

        _ ->
            context


{-| Every arm is a pure list shape with simple heads: `[]`, fixed lists,
`h1 :: h2 :: … :: rest` (vars/`_` heads), or catch-all. No ctor/tuple nesting.
-}

unwrapParenthesized : Node Pattern -> Node Pattern
unwrapParenthesized ((Node _ pattern) as patternNode) =
    case pattern of
        ParenthesizedPattern inner ->
            unwrapParenthesized inner

        _ ->
            patternNode


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
                -- Gren renames multi-arg constructor payloads to records with
                -- domain field names (Http Response, Json.Decode.Error, …).
                -- The table is a HINT keyed on distinctive names: it applies
                -- only when the pattern's arity matches. A mismatch means the
                -- pattern is a same-named ctor from an unrelated package
                -- (e.g. treeview's 4-arg Node vs elm-syntax's 2-arg Node),
                -- which must resolve through the Elm graph like any other.
                Just fieldNames ->
                    if List.length members == List.length fieldNames then
                        addNamedPayloadEdits fieldNames members withChildren

                    else
                        resolveConstructorPattern patternNode range qualifiedName members withChildren

                Nothing ->
                    resolveConstructorPattern patternNode range qualifiedName members withChildren

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

        -- stil4m/elm-syntax multi-arg ctor (Range, value) → Gren record payload.
        "Node" ->
            if
                moduleName
                    == "Elm.Syntax.Node"
                    || moduleName
                    == "Node"
                    || String.isEmpty moduleName
            then
                Just [ "first", "second" ]

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


{-| Resolve a constructor pattern through the Elm graph and lower its payload.
Shared by the table-miss and table-arity-mismatch paths of NamedPattern.
-}
resolveConstructorPattern : Node Pattern -> Range -> QualifiedNameRef -> List (Node Pattern) -> ModuleContext -> ModuleContext
resolveConstructorPattern patternNode range qualifiedName members withChildren =
    case resolveReference patternNode qualifiedName.moduleName qualifiedName.name withChildren of
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

                    -- stil4m/elm-syntax: Node Range a. Often unresolved
                    -- when only the dependency interface is available
                    -- (e.g. porting jfmengels/elm-review).
                    ( "Node", 2 ) ->
                        addPayloadEdits Types.CustomConstructor "=" members withChildren

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
