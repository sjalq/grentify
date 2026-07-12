module ElmToGren.Types exposing
    ( ConstructorInfo
    , Diagnostic
    , DiagnosticSeverity(..)
    , EditKind(..)
    , ExposedItem
    , ImportFact
    , ModuleExtraction
    , Platform(..)
    , RecordAliasInfo
    , ResolvedReference
    , SourceEdit
    , editKindToString
    , platformToString
    , severityToString
    )

import Elm.Syntax.Range exposing (Range)
import Json.Encode as Encode

type EditKind
    = CaseKeyword
    | OfKeyword
    | Unit
    | TupleExpression
    | TuplePattern
    | TupleType
    | ListConsExpression
    | ListConsPattern
    | ModuleReference
    | SymbolReference
    | CustomType
    | CustomConstructor
    | RecordAliasConstructor
    | Manual


type DiagnosticSeverity
    = Info
    | Warning
    | Error


type Platform
    = Common
    | Browser
    | Node


type alias SourceEdit =
    { range : Range
    , replacement : String
    , kind : EditKind
    , rule : String
    }


type alias Diagnostic =
    { code : String
    , severity : DiagnosticSeverity
    , message : String
    , range : Maybe Range
    , help : Maybe String
    }


type alias ConstructorInfo =
    { moduleName : String
    , name : String
    , arity : Int
    }


type alias RecordAliasInfo =
    { moduleName : String
    , name : String
    , fields : List String
    }


{-| A value or type reference resolved to its canonical defining module. -}
type alias ResolvedReference =
    { range : Range
    , moduleName : String
    , name : String
    , text : String
    , isType : Bool
    }


type alias ExposedItem =
    { name : String
    , text : String
    }


type alias ImportFact =
    { range : Range
    , moduleName : String
    , alias : Maybe String
    , exposingAll : Bool
    , exposed : List ExposedItem
    }


type alias ModuleExtraction =
    { path : String
    , moduleName : String
    , edits : List SourceEdit
    , diagnostics : List Diagnostic
    , importedModules : List String
    , requiredAdapters : List String
    , constructors : List ConstructorInfo
    , recordAliases : List RecordAliasInfo
    , references : List ResolvedReference
    , importFacts : List ImportFact
    , detectedPlatform : Platform
    , -- Phase 1: resolved simplified AST for the host pipeline (Json.Encode.Value).
      -- Encoded as a JSON object; host decodes independently of edit application.
      ast : Encode.Value
    }


editKindToString : EditKind -> String
editKindToString kind =
    case kind of
        CaseKeyword ->
            "case-keyword"

        OfKeyword ->
            "of-keyword"

        Unit ->
            "unit"

        TupleExpression ->
            "tuple-expression"

        TuplePattern ->
            "tuple-pattern"

        TupleType ->
            "tuple-type"

        ListConsExpression ->
            "list-cons-expression"

        ListConsPattern ->
            "list-cons-pattern"

        ModuleReference ->
            "module-reference"

        SymbolReference ->
            "symbol-reference"

        CustomType ->
            "custom-type"

        CustomConstructor ->
            "custom-constructor"

        RecordAliasConstructor ->
            "record-alias-constructor"

        Manual ->
            "manual"


severityToString : DiagnosticSeverity -> String
severityToString severity =
    case severity of
        Info ->
            "info"

        Warning ->
            "warning"

        Error ->
            "error"


platformToString : Platform -> String
platformToString platform =
    case platform of
        Common ->
            "common"

        Browser ->
            "browser"

        Node ->
            "node"
