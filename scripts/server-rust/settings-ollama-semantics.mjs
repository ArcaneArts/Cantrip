import { ollamaModelInventorySchema } from "../../packages/protocol/dist/index.js";
import { normalizeOllamaModel } from "../../cantrip_server/src/models/ollama-catalog.ts";

export function ollamaSemantics(emit) {
  const base = {
    name: "model",
    modifiedAt: null,
    sizeBytes: null,
    digest: null,
    family: null,
    families: [],
    parameterSize: null,
    quantization: null,
    capabilities: [],
    modelInfo: {},
  };
  const run = (models) => {
    const input = JSON.parse(
      JSON.stringify({ models, observedAt: "2026-10-27T00:00:00.000Z" }),
    );
    let expected;
    try {
      expected = {
        value: ollamaModelInventorySchema
          .parse(input)
          .models.map(normalizeOllamaModel),
      };
    } catch (error) {
      expected = { error: error.message };
    }
    emit("ollama", input, expected);
  };
  const numbers = [
    null,
    false,
    "128",
    0,
    0.1,
    0.49,
    0.49999999999999994,
    0.5,
    0.5000000000000001,
    0.99,
    1,
    1.4999999999999998,
    1.5,
    1.5000000000000002,
    2.4999999999999996,
    2.5,
    -1,
    2 ** 52 - 1,
    2 ** 52 + 1,
    1e40,
    Number.MAX_VALUE,
  ];
  for (const architecture of [
    undefined,
    null,
    false,
    "",
    "llama",
    "mamba.hybrid",
    "ΟΣ",
    "\ud800",
  ])
    for (const number of numbers)
      for (const capabilities of [
        [],
        ["VISION", "TOOLS", "THINKING", "COMPLETION"],
        [" ViSiOn ", "tools", "VISION", "ΟΣ", "İ", "\ud800"],
      ])
        run([
          {
            ...base,
            capabilities,
            modelInfo: {
              "general.architecture": architecture,
              [`${architecture}.context_length`]: number,
              "fallback.context_length": 2.5,
              "nested.extra.context_length": 10000,
            },
          },
        ]);
  let seed = 429178;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let index = 0; index < 5000; index++) {
    const info = {};
    for (let key = 0; key < random(10); key++) {
      const name = [
        "general.architecture",
        "llama.context_length",
        "mamba.context_length",
        "a.b.context_length",
        ".context_length",
        "\ud800.context_length",
        "ΟΣ.context_length",
        "constructor",
        "7",
      ][random(9)];
      info[name] = random(3)
        ? numbers[random(numbers.length)]
        : ["llama", "mamba", "ΟΣ", "\ud800"][random(4)];
    }
    run([
      {
        ...base,
        name: [" llama ", "model 🦀", "\ud800", "�"][random(4)],
        family: random(2) ? " llama " : null,
        capabilities: Array.from(
          { length: random(10) },
          () =>
            [
              "completion",
              "TOOLS",
              "vision",
              "thinking",
              "embedding",
              "İ",
              "ΟΣ",
            ][random(7)],
        ),
        modelInfo: info,
        families: [" family ", "🦀"],
        digest: " opaque ",
        parameterSize: " 8B ",
        quantization: " Q4 ",
        sizeBytes: index,
      },
    ]);
  }
  for (const patch of [
    { name: " " },
    { capabilities: [null] },
    { capabilities: "vision" },
    { modelInfo: null },
    { sizeBytes: -1 },
    { modifiedAt: "invalid" },
    { family: 12 },
  ])
    run([{ ...base, ...patch }]);
  run([]);
}
