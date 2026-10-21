import { words, type LanguageCatalog, type LanguageDefinition } from "./types";

const cLike: LanguageDefinition = {
  keywords: words(
    "if else for while do switch case default break continue return throw try catch finally new class extends implements interface enum import export package public private protected static const let var async await yield this super abstract final override virtual volatile synchronized native transient instanceof typeof void delete in of with debugger function constructor get set as is",
  ),
  types: words(
    "int float double bool boolean char byte short long string String Object Number Boolean Array List Map Set Promise never unknown any number bigint symbol dynamic",
  ),
  literals: words("true false null undefined nil None NaN Infinity"),
  lineComments: ["//"],
  blockComments: [["/*", "*/"]],
  quotes: ['"', "'"],
};
const language = (
  extra: Partial<LanguageDefinition>,
  keywords = "",
): LanguageDefinition => ({
  ...cLike,
  ...extra,
  keywords: new Set([...cLike.keywords, ...words(keywords)]),
});

export const definitions: LanguageCatalog = {
  javascript: language({ template: true }),
  typescript: language(
    { template: true },
    "type namespace declare keyof readonly infer satisfies asserts unique module require global",
  ),
  jsx: language({ template: true, jsx: true }),
  tsx: language(
    { template: true, jsx: true },
    "type namespace declare keyof readonly infer satisfies asserts unique",
  ),
  rust: language(
    { nestedComments: true },
    "fn pub mut impl trait struct use mod crate self Self match ref move unsafe extern where dyn loop macro_rules union type as let const static async await",
  ),
  dart: language(
    { multilineQuotes: ['\"\"\"', "'''"], template: true },
    "library part typedef mixin extension factory required covariant late on show hide with deferred external operator",
  ),
  python: {
    keywords: words(
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    ),
    types: words("int float bool str bytes list dict set tuple object type"),
    literals: words("True False None"),
    lineComments: ["#"],
    quotes: ['"', "'"],
    multilineQuotes: ['\"\"\"', "'''"],
  },
  go: language(
    { quotes: ['"', "'", "`"], multilineQuotes: ["`"] },
    "func defer go chan select fallthrough range map struct type interface package import",
  ),
  java: language(
    { multilineQuotes: ['\"\"\"'] },
    "record sealed permits non-sealed throws strictfp assert module requires opens provides uses",
  ),
  kotlin: language(
    { multilineQuotes: ['\"\"\"'], nestedComments: true, template: true },
    "fun val object companion data sealed when internal open lateinit suspend inline reified crossinline noinline out by init annotation expect actual",
  ),
  swift: language(
    { multilineQuotes: ['\"\"\"'], nestedComments: true },
    "func protocol extension guard defer struct associatedtype typealias inout fileprivate internal open weak unowned lazy convenience required some any actor nonisolated",
  ),
  c: language(
    {},
    "struct typedef union sizeof restrict _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local",
  ),
  cpp: language(
    {},
    "struct typedef union sizeof alignas alignof auto constexpr consteval constinit decltype namespace template typename using friend explicit noexcept nullptr operator co_await co_return co_yield concept requires",
  ),
  csharp: language(
    { multilineQuotes: ['\"\"\"'], template: true },
    "namespace using struct record delegate event partial sealed internal readonly ref out params lock checked unchecked unsafe fixed stackalloc nameof global init required file",
  ),
  ruby: {
    keywords: words(
      "alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield private protected public require require_relative include extend attr_reader attr_writer attr_accessor",
    ),
    literals: words("true false nil"),
    lineComments: ["#"],
    blockComments: [["=begin", "=end"]],
    quotes: ['"', "'", "`"],
    multilineQuotes: ['"', "'", "`"],
    template: true,
  },
  php: language(
    { lineComments: ["//", "#"], hashVariables: true },
    "echo print require require_once include include_once namespace use trait readonly match fn foreach endforeach elseif endif endfor endwhile isset unset empty list array callable declare goto",
  ),
  lua: {
    keywords: words(
      "and break do else elseif end for function goto if in local not or repeat return then until while",
    ),
    literals: words("true false nil"),
    lineComments: ["--"],
    blockComments: [
      ["--[[", "]]"],
      ["--[=[", "]=]"],
    ],
    quotes: ['"', "'"],
    multilineQuotes: ["[[", "[=["],
  },
};
