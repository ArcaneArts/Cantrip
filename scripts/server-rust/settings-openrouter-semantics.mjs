import {
  isOpenRouterProvider,
  normalizeOpenRouterModel,
} from "../../cantrip_server/src/models/openrouter-catalog.ts";

export function openRouterSemantics(emit) {
  let seed = 812723;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const texts = [
    null,
    false,
    0,
    {},
    [],
    "",
    " ",
    " TEXT ",
    "IMAGE",
    "\ud800",
    "ΟΣ",
    "\uFEFF high\u2029",
  ];
  const arrays = [
    null,
    false,
    {},
    [],
    ["text", "IMAGE", " text ", null, 1, "\ud800", "ΟΣ", "ος"],
  ];
  const numbers = [
    null,
    false,
    "2048",
    -1,
    0,
    0.1,
    0.49999999999999994,
    0.5,
    1.5,
    2147483648,
    9007199254740991,
    1e100,
  ];
  const pick = (values) => values[random(values.length)];
  const jsonText = (raw) => {
    raw = raw.toWellFormed();
    let expected;
    try {
      expected = { serialized: JSON.stringify(JSON.parse(raw)) };
    } catch (error) {
      expected = { error: error.message };
    }
    emit("openrouter-json", raw, expected);
  };
  for (const raw of [
    "",
    " ",
    "bad",
    "<html>offline</html>",
    "[object Object]",
    "undefined",
    "NaN",
    "Infinity",
    "-",
    "-x",
    "01",
    "-01",
    "1.",
    "1e",
    "1e+",
    "[",
    "{",
    "{a:1}",
    '{"a":}',
    '{"a":1,}',
    "[1,]",
    "[1 2]",
    '{"a" 1}',
    '"unterminated',
    '"\\',
    '"\\u12',
    '"\\x"',
    '"\\🦀"',
    '"raw\ncontrol"',
    '{"data":[]}x',
    "1e9999",
    '"\\ud800"',
  ])
    jsonText(raw);
  const valid = [
    "null",
    "false",
    "true",
    "-123.5e2",
    '"🦀 text"',
    '{"data":[{"id":"model","n":123}]}',
    '[1,null,true,{"a":"ΟΣ"}]',
  ];
  const mutations = [
    "",
    " ",
    "\n",
    "\r",
    "\r\n",
    "\t",
    "\uFEFF",
    "\u2028",
    "<",
    '"',
    "\\",
    "\u0000",
    "a",
    "0",
    "[",
    "]",
    "{",
    "}",
    ",",
    ":",
    "+",
    "-",
    "e",
    "u",
    "🦀",
    "é",
  ];
  for (let index = 0; index < 10000; index++) {
    const raw = pick(valid),
      at = random(raw.length + 1),
      inserted = pick(mutations);
    jsonText(raw.slice(0, at) + inserted + raw.slice(at + (random(2) ? 1 : 0)));
  }
  for (const prefix of [
    "",
    " ".repeat(10),
    " ".repeat(30),
    "\r\n\r ",
    '{"🦀":',
    '["🦀",',
  ]) {
    for (const suffix of ["", " ".repeat(10), " ".repeat(40)]) {
      for (const token of ["x", "🦀", "falseX", "\\", "é"])
        jsonText(prefix + token + suffix);
    }
  }
  for (let index = 0; index < 6000; index++) {
    const input = JSON.parse(
      JSON.stringify({
        id: ["model", " model ", "\ud800"][random(3)],
        canonical_slug: pick(texts),
        name: pick(texts),
        description: pick(texts),
        context_length: pick(numbers),
        architecture: random(3)
          ? {
              input_modalities: pick(arrays),
              output_modalities: pick(arrays),
              instruct_type: pick(texts),
              tokenizer: pick(texts),
            }
          : pick(texts),
        reasoning: random(3)
          ? {
              supported_efforts: [
                " HIGH ",
                "high",
                " Low ",
                "ΟΣ",
                "ος",
                "\ud800",
                null,
              ],
              default_effort: ["high", "LOW", "missing", null][random(4)],
              mandatory: pick(texts),
            }
          : pick(texts),
        top_provider: random(3)
          ? {
              context_length: pick(numbers),
              max_completion_tokens: pick(numbers),
            }
          : pick(texts),
        supported_parameters: Array.from(
          { length: random(8) },
          () =>
            [
              " tools ",
              "TOOL_CHOICE",
              "parallel_tool_calls",
              "response_format",
              "structured_outputs",
              "include_reasoning",
              "reasoning_effort",
              null,
              0,
            ][random(9)],
        ),
        unknown: { __proto__: null, index },
      }),
    );
    emit("openrouter-normalize", input, normalizeOpenRouterModel(input));
  }
  const long = {
    id: "long",
    description: "a".repeat(19999) + "🦀" + "b".repeat(100),
  };
  emit("openrouter-normalize", long, normalizeOpenRouterModel(long));
  for (const kind of [
    "openai-compatible",
    "grok",
    "chatgpt",
    "OpenAI-compatible",
  ]) {
    for (const baseUrl of [
      "https://openrouter.ai/api/v1",
      "https://api.OPENROUTER.ai:443/path",
      "https://notopenrouter.ai/",
      "https://openrouter.ai.evil.example/",
      "https://openrouter.ai./",
      "custom://OPENROUTER.AI/models",
      "ftp://openrouter.ai/path",
      "openrouter.ai",
      "https://user:secret@openrouter.ai/",
      "https://openrouter.ai\\@evil.example/",
      "https://[::1]/",
      "https://openrouter.ai%2f.evil/",
      "https://\ud800/",
      "https://openrouter.ai\n/path",
    ]) {
      const input = { kind, baseUrl };
      emit("openrouter-provider", input, isOpenRouterProvider(input));
    }
  }
}
