import { words, type LanguageCatalog } from "./types";

const data = {
  keywords: new Set<string>(),
  quotes: ['"', "'"],
  literals: words("true false null yes no on off"),
};
export const definitions: LanguageCatalog = {
  plain: { keywords: new Set() },
  html: data,
  xml: data,
  css: {
    ...data,
    blockComments: [["/*", "*/"]],
    keywords: words(
      "important inherit initial unset revert auto none block inline flex grid solid relative absolute fixed sticky transparent",
    ),
  },
  scss: {
    ...data,
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    hashVariables: true,
    keywords: words(
      "mixin include extend import use forward function return if else each for while important default global",
    ),
  },
  json: { ...data, quotes: ['"'] },
  jsonc: {
    ...data,
    quotes: ['"'],
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
  },
  yaml: { ...data, lineComments: ["#"] },
  toml: { ...data, lineComments: ["#"], multilineQuotes: ['\"\"\"', "'''"] },
  markdown: data,
  shell: {
    ...data,
    lineComments: ["#"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ['"', "'", "`"],
    template: true,
    hashVariables: true,
    keywords: words(
      "if then else elif fi for while until do done in case esac function select time coproc return break continue export local readonly declare typeset unset source alias unalias set trap exec eval shift read printf echo exit test",
    ),
  },
  batch: {
    keywords: words(
      "assoc break call cd chcp chdir cls cmd color copy date del dir do echo else endlocal erase errorlevel exist exit for ftype goto if in md mkdir mklink move not path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol defined equ neq lss leq gtr geq enabledelayedexpansion disabledelayedexpansion",
    ),
    quotes: ['"'],
    caseInsensitive: true,
  },
  sql: {
    ...data,
    lineComments: ["--"],
    blockComments: [["/*", "*/"]],
    multilineQuotes: ["'"],
    quotes: ["'", '"', "`"],
    caseInsensitive: true,
    keywords: words(
      "select from where join inner outer left right full cross on as and or not null is in exists between like ilike order by group having limit offset fetch union all distinct with recursive insert into values update set delete create alter drop table view index schema database primary foreign key references constraint check default unique cascade returning begin commit rollback transaction grant revoke case when then else end over partition window filter count sum avg min max asc desc explain analyze truncate replace conflict do nothing",
    ),
  },
  dockerfile: {
    ...data,
    lineComments: ["#"],
    hashVariables: true,
    caseInsensitive: true,
    keywords: words(
      "from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as",
    ),
  },
  makefile: {
    ...data,
    lineComments: ["#"],
    hashVariables: true,
    keywords: words(
      "include ifdef ifndef ifeq ifneq else endif define endef override export unexport private vpath",
    ),
  },
  env: {
    ...data,
    lineComments: ["#"],
    hashVariables: true,
    keywords: words("export"),
  },
  ini: { ...data, lineComments: [";", "#"] },
  properties: { ...data, lineComments: ["#", "!"] },
};
