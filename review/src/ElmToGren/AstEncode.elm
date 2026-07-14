module ElmToGren.AstEncode exposing (encodeFile)

{-| Phase 1: encode a resolved, simplified AST for the host pipeline.

Every value/type reference carries its canonical module from the lookup table
when available. The host applies catalog name substitution on the tree and
pretty-prints; this module has zero Gren knowledge.
-}

import Elm.Syntax.Declaration as Declaration exposing (Declaration(..))
import Elm.Syntax.Exposing as Exposing exposing (Exposing(..), TopLevelExpose(..))
import Elm.Syntax.Expression as Expression exposing (Expression(..), LetDeclaration(..))
import Elm.Syntax.File exposing (File)
import Elm.Syntax.Import exposing (Import)
import Elm.Syntax.Module as Module exposing (Module(..))
import Elm.Syntax.ModuleName exposing (ModuleName)
import Elm.Syntax.Node as Node exposing (Node(..))
import Elm.Syntax.Pattern as Pattern exposing (Pattern(..))
import Elm.Syntax.Range exposing (Range)
import Elm.Syntax.Signature exposing (Signature)
import Elm.Syntax.TypeAnnotation as TypeAnnotation exposing (TypeAnnotation(..))
import Json.Encode as Encode
import Review.ModuleNameLookupTable as ModuleNameLookupTable exposing (ModuleNameLookupTable)


encodeFile : ModuleNameLookupTable -> File -> Encode.Value
encodeFile lookup file =
    Encode.object
        [ ( "schemaVersion", Encode.int 1 )
        , ( "moduleDefinition", encodeModule (Node.value file.moduleDefinition) )
        , ( "comments", Encode.list (Node.value >> Encode.string) file.comments )
        , ( "imports", Encode.list (Node.value >> encodeImport) file.imports )
        , ( "declarations"
          , Encode.list (encodeDeclaration lookup) file.declarations
          )
        ]


encodeModule : Module -> Encode.Value
encodeModule module_ =
    case module_ of
        NormalModule data ->
            Encode.object
                [ ( "kind", Encode.string "normal" )
                , ( "moduleName", Encode.string (encodeModuleName (Node.value data.moduleName)) )
                , ( "exposing", encodeExposing (Node.value data.exposingList) )
                ]

        PortModule data ->
            Encode.object
                [ ( "kind", Encode.string "port" )
                , ( "moduleName", Encode.string (encodeModuleName (Node.value data.moduleName)) )
                , ( "exposing", encodeExposing (Node.value data.exposingList) )
                ]

        EffectModule data ->
            Encode.object
                [ ( "kind", Encode.string "effect" )
                , ( "moduleName", Encode.string (encodeModuleName (Node.value data.moduleName)) )
                , ( "exposing", encodeExposing (Node.value data.exposingList) )
                ]


encodeImport : Import -> Encode.Value
encodeImport import_ =
    Encode.object
        [ ( "moduleName", Encode.string (encodeModuleName (Node.value import_.moduleName)) )
        , ( "alias"
          , import_.moduleAlias
                |> Maybe.map (Node.value >> encodeModuleName >> Encode.string)
                |> Maybe.withDefault Encode.null
          )
        , ( "exposing"
          , import_.exposingList
                |> Maybe.map (Node.value >> encodeExposing)
                |> Maybe.withDefault Encode.null
          )
        ]


encodeExposing : Exposing -> Encode.Value
encodeExposing exposing_ =
    case exposing_ of
        All _ ->
            Encode.object [ ( "kind", Encode.string "all" ) ]

        Explicit nodes ->
            Encode.object
                [ ( "kind", Encode.string "explicit" )
                , ( "items", Encode.list (Node.value >> encodeTopLevelExpose) nodes )
                ]


encodeTopLevelExpose : TopLevelExpose -> Encode.Value
encodeTopLevelExpose expose =
    case expose of
        InfixExpose name ->
            Encode.object
                [ ( "kind", Encode.string "infix" )
                , ( "name", Encode.string name )
                ]

        FunctionExpose name ->
            Encode.object
                [ ( "kind", Encode.string "function" )
                , ( "name", Encode.string name )
                ]

        TypeOrAliasExpose name ->
            Encode.object
                [ ( "kind", Encode.string "typeOrAlias" )
                , ( "name", Encode.string name )
                ]

        TypeExpose { name, open } ->
            Encode.object
                [ ( "kind", Encode.string "type" )
                , ( "name", Encode.string name )
                , ( "open", Encode.bool (open /= Nothing) )
                ]


encodeDeclaration : ModuleNameLookupTable -> Node Declaration -> Encode.Value
encodeDeclaration lookup (Node _ declaration) =
    case declaration of
        FunctionDeclaration function ->
            let
                impl =
                    Node.value function.declaration

                name =
                    Node.value impl.name
            in
            Encode.object
                [ ( "kind", Encode.string "function" )
                , ( "name", Encode.string name )
                , ( "documentation", encodeMaybeString (Maybe.map Node.value function.documentation) )
                , ( "signature"
                  , function.signature
                        |> Maybe.map (Node.value >> encodeSignature lookup)
                        |> Maybe.withDefault Encode.null
                  )
                , ( "arguments", Encode.list (encodePattern lookup) impl.arguments )
                , ( "expression", encodeExpression lookup impl.expression )
                ]

        AliasDeclaration aliasDecl ->
            Encode.object
                [ ( "kind", Encode.string "alias" )
                , ( "name", Encode.string (Node.value aliasDecl.name) )
                , ( "documentation", encodeMaybeString (Maybe.map Node.value aliasDecl.documentation) )
                , ( "generics", Encode.list (Node.value >> Encode.string) aliasDecl.generics )
                , ( "typeAnnotation", encodeType lookup aliasDecl.typeAnnotation )
                ]

        CustomTypeDeclaration customType ->
            Encode.object
                [ ( "kind", Encode.string "customType" )
                , ( "name", Encode.string (Node.value customType.name) )
                , ( "documentation", encodeMaybeString (Maybe.map Node.value customType.documentation) )
                , ( "generics", Encode.list (Node.value >> Encode.string) customType.generics )
                , ( "constructors"
                  , Encode.list
                        (\(Node _ ctor) ->
                            Encode.object
                                [ ( "name", Encode.string (Node.value ctor.name) )
                                , ( "arguments", Encode.list (encodeType lookup) ctor.arguments )
                                ]
                        )
                        customType.constructors
                  )
                ]

        PortDeclaration signature ->
            Encode.object
                [ ( "kind", Encode.string "port" )
                , ( "signature", encodeSignature lookup signature )
                ]

        InfixDeclaration _ ->
            Encode.object [ ( "kind", Encode.string "infix" ) ]

        Destructuring pattern expression ->
            Encode.object
                [ ( "kind", Encode.string "destructuring" )
                , ( "pattern", encodePattern lookup pattern )
                , ( "expression", encodeExpression lookup expression )
                ]


encodeSignature : ModuleNameLookupTable -> Signature -> Encode.Value
encodeSignature lookup signature =
    Encode.object
        [ ( "name", Encode.string (Node.value signature.name) )
        , ( "typeAnnotation", encodeType lookup signature.typeAnnotation )
        ]


encodeType : ModuleNameLookupTable -> Node TypeAnnotation -> Encode.Value
encodeType lookup (Node range typeAnnotation) =
    case typeAnnotation of
        GenericType name ->
            Encode.object
                [ ( "kind", Encode.string "generic" )
                , ( "name", Encode.string name )
                ]

        Typed (Node _ ( moduleName, name )) args ->
            Encode.object
                [ ( "kind", Encode.string "typed" )
                , ( "moduleName"
                  , resolveModule lookup range moduleName
                        |> Maybe.map Encode.string
                        |> Maybe.withDefault
                            (if List.isEmpty moduleName then
                                Encode.null

                             else
                                Encode.string (String.join "." moduleName)
                            )
                  )
                , ( "name", Encode.string name )
                , ( "arguments", Encode.list (encodeType lookup) args )
                ]

        Unit ->
            Encode.object [ ( "kind", Encode.string "unit" ) ]

        Tupled items ->
            Encode.object
                [ ( "kind", Encode.string "tuple" )
                , ( "items", Encode.list (encodeType lookup) items )
                ]

        Record fields ->
            Encode.object
                [ ( "kind", Encode.string "record" )
                , ( "fields"
                  , Encode.list
                        (\(Node _ ( Node _ fieldName, annotation )) ->
                            Encode.object
                                [ ( "name", Encode.string fieldName )
                                , ( "typeAnnotation", encodeType lookup annotation )
                                ]
                        )
                        fields
                  )
                ]

        GenericRecord (Node _ ext) (Node _ fields) ->
            Encode.object
                [ ( "kind", Encode.string "genericRecord" )
                , ( "extension", Encode.string ext )
                , ( "fields"
                  , Encode.list
                        (\(Node _ ( Node _ fieldName, annotation )) ->
                            Encode.object
                                [ ( "name", Encode.string fieldName )
                                , ( "typeAnnotation", encodeType lookup annotation )
                                ]
                        )
                        fields
                  )
                ]

        FunctionTypeAnnotation left right ->
            Encode.object
                [ ( "kind", Encode.string "function" )
                , ( "left", encodeType lookup left )
                , ( "right", encodeType lookup right )
                ]


encodePattern : ModuleNameLookupTable -> Node Pattern -> Encode.Value
encodePattern lookup (Node range pattern) =
    case pattern of
        AllPattern ->
            Encode.object [ ( "kind", Encode.string "all" ) ]

        UnitPattern ->
            Encode.object [ ( "kind", Encode.string "unit" ) ]

        CharPattern char ->
            Encode.object
                [ ( "kind", Encode.string "char" )
                , ( "value", Encode.string (String.fromChar char) )
                ]

        StringPattern string ->
            Encode.object
                [ ( "kind", Encode.string "string" )
                , ( "value", Encode.string string )
                ]

        IntPattern int ->
            Encode.object
                [ ( "kind", Encode.string "int" )
                , ( "value", encodeIntValue int )
                ]

        HexPattern int ->
            Encode.object
                [ ( "kind", Encode.string "hex" )
                , ( "value", encodeIntValue int )
                ]

        FloatPattern float ->
            Encode.object
                [ ( "kind", Encode.string "float" )
                , ( "value", Encode.float float )
                ]

        TuplePattern items ->
            Encode.object
                [ ( "kind", Encode.string "tuple" )
                , ( "items", Encode.list (encodePattern lookup) items )
                ]

        RecordPattern fields ->
            Encode.object
                [ ( "kind", Encode.string "record" )
                , ( "fields", Encode.list (Node.value >> Encode.string) fields )
                ]

        UnConsPattern head tail ->
            Encode.object
                [ ( "kind", Encode.string "cons" )
                , ( "head", encodePattern lookup head )
                , ( "tail", encodePattern lookup tail )
                ]

        ListPattern items ->
            Encode.object
                [ ( "kind", Encode.string "list" )
                , ( "items", Encode.list (encodePattern lookup) items )
                ]

        VarPattern name ->
            Encode.object
                [ ( "kind", Encode.string "var" )
                , ( "name", Encode.string name )
                ]

        NamedPattern { moduleName, name } args ->
            Encode.object
                [ ( "kind", Encode.string "named" )
                , ( "moduleName"
                  , resolveModule lookup range moduleName
                        |> Maybe.map Encode.string
                        |> Maybe.withDefault
                            (if List.isEmpty moduleName then
                                Encode.null

                             else
                                Encode.string (String.join "." moduleName)
                            )
                  )
                , ( "name", Encode.string name )
                , ( "arguments", Encode.list (encodePattern lookup) args )
                ]

        AsPattern inner (Node _ asName) ->
            Encode.object
                [ ( "kind", Encode.string "as" )
                , ( "pattern", encodePattern lookup inner )
                , ( "name", Encode.string asName )
                ]

        ParenthesizedPattern inner ->
            encodePattern lookup inner


encodeExpression : ModuleNameLookupTable -> Node Expression -> Encode.Value
encodeExpression lookup (Node range expression) =
    case expression of
        UnitExpr ->
            Encode.object [ ( "kind", Encode.string "unit" ) ]

        Application values ->
            Encode.object
                [ ( "kind", Encode.string "application" )
                , ( "parts", Encode.list (encodeExpression lookup) values )
                ]

        OperatorApplication op _ left right ->
            Encode.object
                [ ( "kind", Encode.string "binop" )
                , ( "operator", Encode.string op )
                , ( "left", encodeExpression lookup left )
                , ( "right", encodeExpression lookup right )
                ]

        FunctionOrValue moduleName name ->
            Encode.object
                [ ( "kind", Encode.string "var" )
                , ( "moduleName"
                  , resolveModule lookup range moduleName
                        |> Maybe.map Encode.string
                        |> Maybe.withDefault
                            (if List.isEmpty moduleName then
                                Encode.null

                             else
                                Encode.string (String.join "." moduleName)
                            )
                  )
                , ( "name", Encode.string name )
                ]

        IfBlock condition ifTrue ifFalse ->
            Encode.object
                [ ( "kind", Encode.string "if" )
                , ( "condition", encodeExpression lookup condition )
                , ( "then", encodeExpression lookup ifTrue )
                , ( "else", encodeExpression lookup ifFalse )
                ]

        PrefixOperator op ->
            Encode.object
                [ ( "kind", Encode.string "prefix" )
                , ( "operator", Encode.string op )
                ]

        Operator op ->
            Encode.object
                [ ( "kind", Encode.string "operator" )
                , ( "operator", Encode.string op )
                ]

        Integer int ->
            Encode.object
                [ ( "kind", Encode.string "int" )
                -- String form: Json.Encode.int is JS-safe only; eetf smallBigMax
                -- and similar big literals would otherwise encode as null.
                , ( "value", encodeIntValue int )
                ]

        Hex int ->
            Encode.object
                [ ( "kind", Encode.string "hex" )
                , ( "value", encodeIntValue int )
                ]

        Floatable float ->
            Encode.object
                [ ( "kind", Encode.string "float" )
                , ( "value", Encode.float float )
                ]

        Negation inner ->
            Encode.object
                [ ( "kind", Encode.string "negation" )
                , ( "expression", encodeExpression lookup inner )
                ]

        Literal string ->
            Encode.object
                [ ( "kind", Encode.string "string" )
                , ( "value", Encode.string string )
                ]

        CharLiteral char ->
            Encode.object
                [ ( "kind", Encode.string "char" )
                , ( "value", Encode.string (String.fromChar char) )
                ]

        TupledExpression items ->
            Encode.object
                [ ( "kind", Encode.string "tuple" )
                , ( "items", Encode.list (encodeExpression lookup) items )
                ]

        ParenthesizedExpression inner ->
            encodeExpression lookup inner

        LetExpression letBlock ->
            Encode.object
                [ ( "kind", Encode.string "let" )
                , ( "declarations", Encode.list (encodeLetDeclaration lookup) letBlock.declarations )
                , ( "expression", encodeExpression lookup letBlock.expression )
                ]

        CaseExpression caseBlock ->
            Encode.object
                [ ( "kind", Encode.string "case" )
                , ( "expression", encodeExpression lookup caseBlock.expression )
                , ( "cases"
                  , Encode.list
                        (\( pattern, body ) ->
                            Encode.object
                                [ ( "pattern", encodePattern lookup pattern )
                                , ( "body", encodeExpression lookup body )
                                ]
                        )
                        caseBlock.cases
                  )
                ]

        LambdaExpression lambda ->
            Encode.object
                [ ( "kind", Encode.string "lambda" )
                , ( "arguments", Encode.list (encodePattern lookup) lambda.args )
                , ( "expression", encodeExpression lookup lambda.expression )
                ]

        RecordExpr setters ->
            Encode.object
                [ ( "kind", Encode.string "record" )
                , ( "fields"
                  , Encode.list
                        (\(Node _ ( Node _ fieldName, value )) ->
                            Encode.object
                                [ ( "name", Encode.string fieldName )
                                , ( "value", encodeExpression lookup value )
                                ]
                        )
                        setters
                  )
                ]

        ListExpr items ->
            Encode.object
                [ ( "kind", Encode.string "list" )
                , ( "items", Encode.list (encodeExpression lookup) items )
                ]

        RecordAccess record (Node _ field) ->
            Encode.object
                [ ( "kind", Encode.string "access" )
                , ( "record", encodeExpression lookup record )
                , ( "field", Encode.string field )
                ]

        RecordAccessFunction field ->
            Encode.object
                [ ( "kind", Encode.string "accessFunction" )
                , ( "field"
                  , Encode.string
                        (if String.startsWith "." field then
                            String.dropLeft 1 field

                         else
                            field
                        )
                  )
                ]

        RecordUpdateExpression (Node _ name) setters ->
            Encode.object
                [ ( "kind", Encode.string "update" )
                , ( "name", Encode.string name )
                , ( "fields"
                  , Encode.list
                        (\(Node _ ( Node _ fieldName, value )) ->
                            Encode.object
                                [ ( "name", Encode.string fieldName )
                                , ( "value", encodeExpression lookup value )
                                ]
                        )
                        setters
                  )
                ]

        GLSLExpression code ->
            Encode.object
                [ ( "kind", Encode.string "glsl" )
                , ( "code", Encode.string code )
                ]


encodeLetDeclaration : ModuleNameLookupTable -> Node LetDeclaration -> Encode.Value
encodeLetDeclaration lookup (Node _ declaration) =
    case declaration of
        LetFunction function ->
            let
                impl =
                    Node.value function.declaration
            in
            Encode.object
                [ ( "kind", Encode.string "function" )
                , ( "name", Encode.string (Node.value impl.name) )
                , ( "arguments", Encode.list (encodePattern lookup) impl.arguments )
                , ( "expression", encodeExpression lookup impl.expression )
                ]

        LetDestructuring pattern expression ->
            Encode.object
                [ ( "kind", Encode.string "destructure" )
                , ( "pattern", encodePattern lookup pattern )
                , ( "expression", encodeExpression lookup expression )
                ]


encodeModuleName : ModuleName -> String
encodeModuleName moduleName =
    String.join "." moduleName


encodeMaybeString : Maybe String -> Encode.Value
encodeMaybeString value =
    case value of
        Just string ->
            Encode.string string

        Nothing ->
            Encode.null


{-| Encode integers as decimal strings. `Json.Encode.int` is limited to the
JS-safe range and emits `null` for larger Elm ints (e.g. eetf `smallBigMax`).
Host decode accepts both number and string forms.
-}
encodeIntValue : Int -> Encode.Value
encodeIntValue n =
    Encode.string (String.fromInt n)


resolveModule : ModuleNameLookupTable -> Range -> ModuleName -> Maybe String
resolveModule lookup range written =
    case ModuleNameLookupTable.moduleNameAt lookup range of
        Just real ->
            if List.isEmpty real then
                if List.isEmpty written then
                    Nothing

                else
                    Just (String.join "." written)

            else
                Just (String.join "." real)

        Nothing ->
            if List.isEmpty written then
                Nothing

            else
                Just (String.join "." written)
