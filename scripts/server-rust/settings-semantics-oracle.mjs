// Execute the current production helpers; the native runtime never loads this.
import {
  summarizeAgentTime,
  groupAgentTime,
} from "../../cantrip_server/src/analytics/agent-time.ts";
import {
  enrichCatalogFromExactOpenRouterMatch,
  exactOpenRouterAliases,
} from "../../cantrip_server/src/models/catalog-enrichment.ts";
import { normalizeResponsesBaseUrl } from "../../packages/protocol/src/providers.ts";
import { catalogMetadataSnapshot } from "../../cantrip_server/src/db/repository/provider-catalog.ts";
import { routingCases } from "./settings-routing-cases.mjs";
import { ollamaSemantics } from "./settings-ollama-semantics.mjs";
import { accountCatalogSemantics } from "./settings-account-catalog-semantics.mjs";
import { openRouterSemantics } from "./settings-openrouter-semantics.mjs";
import { accountAuthenticationSemantics } from "./settings-auth-semantics.mjs";
let count = 0;
function emit(op, input, expected) {
  console.log(JSON.stringify({ id: count++, op, input, expected }));
}
const date = (v) => (v === null ? null : new Date(v));
function time(input) {
  const rows = input.rows.map((row) => ({
    ...row,
    startedAt: date(row.startedAt),
    completedAt: date(row.completedAt),
  }));
  const now = date(input.now);
  emit("time", input, {
    total: summarizeAgentTime(rows, now),
    groups: [...groupAgentTime(rows, (row) => row.key, now)],
  });
}
const interval = (start, end, status = "completed", key = "model") => ({
  startedAt: start,
  completedAt: end,
  attemptStatus: status,
  key,
});
const now = 1793059200123;
for (const start of [
  null,
  "invalid",
  -8640000000000000,
  -1,
  0,
  now - 86400001,
  now - 86400000,
  now - 1,
  now,
  now + 1,
  8640000000000000,
]) {
  for (const end of [
    null,
    "invalid",
    -1,
    0,
    now - 1,
    now,
    now + 1,
    8640000000000000,
  ]) {
    for (const status of [
      "running",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "compacted",
    ])
      time({ now, rows: [interval(start, end, status)] });
  }
}
for (const clock of ["invalid", -8640000000000000, 0, 8640000000000000])
  time({
    now: clock,
    rows: [
      interval(0, 10),
      interval(0, null, "running"),
      interval(-100, -1, "failed"),
    ],
  });
let seed = 71893;
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
};
for (let n = 0; n < 400; n++) {
  const rows = Array.from({ length: random(65) }, () => {
    const start = now - random(172800002);
    return interval(
      start,
      random(3) === 0 ? null : start + random(1000000) - 100,
      ["running", "completed", "failed"][random(3)],
      [null, "", "model", "other", "__proto__", "\ud800", "�"][random(7)],
    );
  });
  time({ now, rows });
  time({ now, rows: rows.toReversed() });
}
const catalog = {
  id: "catalog",
  providerId: "provider",
  nativeModelId: "gpt-5",
  canonicalModelId: null,
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  inputModalities: ["text"],
  outputModalities: [],
  supportsTools: null,
  supportsParallelTools: null,
  supportsStructuredOutput: null,
  supportsVision: null,
  supportsReasoning: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  reasoningMandatory: null,
  family: null,
  parameterSize: null,
  quantization: null,
  digest: null,
  metadataSource: "codex",
  matchConfidence: null,
};
const source = {
  ...catalog,
  id: "openrouter",
  nativeModelId: "openai/gpt-5",
  metadataSource: "openrouter",
  description: "OpenRouter description",
  contextWindow: 400000,
  maxOutputTokens: 32000,
  inputModalities: ["text", "image", "text"],
  outputModalities: ["text"],
  supportsTools: true,
  supportsParallelTools: true,
  supportsStructuredOutput: true,
  supportsVision: true,
  supportsReasoning: true,
  supportedReasoningEfforts: [{ effort: "high", description: null }],
  defaultReasoningEffort: "high",
  reasoningMandatory: true,
  family: "gpt",
  matchConfidence: 0.75,
};
const enrich = (catalog, kind, candidates) =>
  emit(
    "enrich",
    { catalog, kind, candidates },
    {
      aliases: catalog ? [...exactOpenRouterAliases(catalog, kind)] : [],
      catalog: enrichCatalogFromExactOpenRouterMatch(catalog, kind, candidates),
    },
  );
for (const kind of ["chatgpt", "grok", "ollama", "openai-compatible"]) {
  for (const nativeModelId of [
    "gpt-5",
    "GPT-5",
    "\ufeffgpt-5\u00a0",
    "ΟΣ",
    "\ud800",
    "�",
    "",
  ])
    for (const canonicalModelId of [
      null,
      "openai/gpt-5",
      "x-ai/gpt-5",
      " openai/GPT-5 ",
    ])
      for (const candidates of [
        [],
        [source],
        [source, { ...source, id: "duplicate" }],
        [
          {
            ...source,
            nativeModelId: "unrelated",
            canonicalModelId: "OPENAI/GPT-5",
          },
        ],
      ])
        enrich(
          { ...catalog, nativeModelId, canonicalModelId },
          kind,
          candidates,
        );
  for (const key of [
    "description",
    "contextWindow",
    "maxOutputTokens",
    "supportsTools",
    "supportsParallelTools",
    "supportsStructuredOutput",
    "supportsVision",
    "supportsReasoning",
    "family",
    "matchConfidence",
  ])
    enrich({ ...catalog, [key]: source[key] }, kind, [source]);
  enrich({ ...catalog, metadataSource: "openrouter" }, kind, [source]);
  enrich({ ...catalog, outputModalities: ["audio"] }, kind, [source]);
  enrich(
    {
      ...catalog,
      inputModalities: ["image", "text", "image"],
      supportsVision: false,
    },
    kind,
    [source],
  );
  enrich(null, kind, [source]);
}
for (const host of [
  "openrouter.ai",
  "OPENROUTER.AI",
  "sub.openrouter.ai",
  "openrouter.ai.evil.invalid",
  "localhost:11434",
  "user:pass@example.com",
  "[::1]:11434",
  "例え.テスト",
]) {
  for (const scheme of ["http", "https", "ftp", "custom"]) {
    for (const pathname of [
      "",
      "/",
      "///",
      "/api/v1/",
      "/api/v1/chat/completions",
      "/api/v1/CHAT/COMPLETIONS/",
      "/responses",
      "/responses//",
      "/chat",
      "/chat/",
      "/prefix/chat",
      "/prefix//responses/",
      "/a/../responses",
      "/%72esponses",
      "/你好/responses",
      "/path with spaces/responses",
    ]) {
      const value = `${scheme}://${host}${pathname}?api_key=opaque#fragment`;
      try {
        emit("url", value, { value: normalizeResponsesBaseUrl(value) });
      } catch (error) {
        emit("url", value, { error: error.message });
      }
    }
  }
}
for (const value of [
  "invalid",
  "/relative",
  "http:",
  "http:example.com/responses",
  "mailto:user@example.com/responses",
  "urn:example/responses?secret=1#x",
  "data:text/plain,responses",
  "https://example.com/\\responses",
  "https://openrouter.ai:443/responses",
  " https://openrouter.ai/ ",
  "https://example.com/\ud800/responses",
]) {
  try {
    emit("url", value, { value: normalizeResponsesBaseUrl(value) });
  } catch (error) {
    emit("url", value, { error: error.message });
  }
}
const sensitiveKeys = [
  "apiKey",
  "API_KEY",
  "api-key",
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "client-secret",
  "access_token",
  "refreshToken",
  "idToken",
  "credential",
  "header",
  "headers",
  "apiKey",
  "ſecret",
];
const metadata = (rawMetadata, extra = {}) => ({
  ...catalog,
  rawMetadata,
  ...extra,
});
const hash = (model) => {
  emit("hash", model, catalogMetadataSnapshot(model));
  emit("json", model, JSON.stringify(model));
  const keys = Object.keys(model.rawMetadata).sort((a, b) =>
    a.localeCompare(b),
  );
  for (let i = 1; i < keys.length; i++) {
    const left = keys[i - 1],
      right = keys[i];
    emit(
      "collate",
      { locale: new Intl.Collator().resolvedOptions().locale, left, right },
      Math.sign(left.localeCompare(right)),
    );
  }
};
for (const key of sensitiveKeys) {
  hash(
    metadata({
      [key]: "sensitive",
      keep: { [key]: "also sensitive", visible: true },
      array: [{ [key]: "nested", visible: false }],
    }),
  );
  hash(metadata({ [key + "Suffix"]: "retained", ["prefix" + key]: 42 }));
}
for (const keys of [
  ["2", "01", "1", "10", "4294967294", "4294967295", "-0", "0"],
  ["a", "A", "á", "á", "Å", "Å", "Å", "ß", "ss", "é", "é"],
  ["__proto__", "constructor", "prototype", "toString", "", "﻿", "\ud800", "�"],
  ["1", "١", "１", "2", "٢", "２", "10", "١٠"],
]) {
  hash(metadata(Object.fromEntries(keys.map((key, i) => [key, i]))));
  hash(
    metadata(Object.fromEntries(keys.toReversed().map((key, i) => [key, i]))),
  );
}
for (let n = 0; n < 1200; n++) {
  const entries = Array.from({ length: random(25) }, (_, i) => {
    const key =
      String.fromCharCode(random(65536)) +
      ["a", "A", "1", "secret", "é", "é", String(i)][random(7)];
    const value = [
      null,
      false,
      true,
      random(1000000) / 100,
      -0,
      1e-7,
      1e21,
      "\udfff",
      "😀",
      [random(9), { password: "redacted", visible: true }],
    ][random(10)];
    return [key, value];
  });
  hash(
    metadata(Object.fromEntries(entries), n % 2 === 0 ? { hidden: false } : {}),
  );
}
// ICU4X normally repairs invalid UTF-16, whereas ICU4C localeCompare gives
// unpaired units distinct implicit weights. Exercise the native extension
// against actual ICU4C, including normalization, contractions and real U+FFFF.
for (const locale of [
  "en-US",
  "de",
  "sv",
  "fr",
  "ja",
  "ko",
  "zh",
  "ar",
  "th",
  "tr",
  "lt",
  "da",
  "es",
]) {
  const collator = new Intl.Collator(locale);
  const collate = (left, right) =>
    emit(
      "collate",
      { locale, left, right },
      Math.sign(collator.compare(left, right)),
    );
  for (const unit of [0xd800, 0xd801, 0xdbff, 0xdc00, 0xdffe, 0xdfff]) {
    const surrogate = String.fromCharCode(unit);
    for (const edge of [
      "",
      "\0",
      "a",
      "A",
      "é",
      "é",
      "\ud7ff",
      "\ue000",
      "\ufdd0",
      "\ufffd",
      "\uffff",
      "😀",
      "\u{10ffff}",
      "\ud800",
      "\udfff",
    ]) {
      for (const prefix of ["", "a", "á", "á", "ch", "ᄀ", "\u0301", "\ud800"])
        for (const suffix of ["", "\u0301", "\u0327\u0301", "a", "\udfff"])
          collate(prefix + surrogate + suffix, prefix + edge + suffix);
    }
  }
  for (let n = 0; n < 400; n++) {
    const make = () =>
      Array.from(
        { length: random(12) },
        () =>
          [
            "a",
            "A",
            "á",
            "á",
            "Å",
            "ch",
            "ß",
            "ss",
            "æ",
            "I",
            "ı",
            "i̇",
            "ᄀ",
            "가",
            "カ",
            "か",
            "\u0301",
            "\u0327",
            "\u0345",
            "\ufeff",
            "\uffff",
            String.fromCharCode(0xd800 + random(2048)),
            String.fromCodePoint(random(0x110000)),
          ][random(23)],
      ).join("");
    collate(make(), make());
  }
}
const rootCollator = new Intl.Collator("en-US");
for (let unit = 0; unit <= 0xffff; unit++) {
  const left = String.fromCharCode(unit);
  for (const right of ["\ud800", "\udfff"])
    emit(
      "collate",
      { locale: "en-US", left, right },
      Math.sign(rootCollator.compare(left, right)),
    );
}
routingCases(emit);
ollamaSemantics(emit);
accountCatalogSemantics(emit);
openRouterSemantics(emit);
accountAuthenticationSemantics(emit);
console.log(JSON.stringify({ done: count }));
