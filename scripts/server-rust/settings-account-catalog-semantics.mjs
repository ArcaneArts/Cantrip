import {
  chatGptModelInventorySchema,
  grokModelInventorySchema,
} from "../../packages/protocol/dist/index.js";
import { normalizeChatGptModel } from "../../cantrip_server/src/models/chatgpt-catalog.ts";
import {
  normalizeGrokCatalogModel,
  enrichGrokCatalogVisionFromOpenRouter,
} from "../../cantrip_server/src/models/grok-catalog.ts";
import {
  chatGptCatalogModel,
  grokCatalogModel,
} from "./settings-provider-fixtures.mjs";

export function accountCatalogSemantics(emit) {
  let seed = 632887;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const run = (op, models) => {
    const input = JSON.parse(
      JSON.stringify({ models, observedAt: "2026-10-27T00:00:00.000Z" }),
    );
    let expected;
    try {
      expected = {
        value: (op === "chatgpt"
          ? chatGptModelInventorySchema
          : grokModelInventorySchema
        )
          .parse(input)
          .models.map(
            op === "chatgpt"
              ? normalizeChatGptModel
              : normalizeGrokCatalogModel,
          ),
      };
    } catch (error) {
      expected = { error: error.message };
    }
    emit(op, input, expected);
  };
  for (let index = 0; index < 2500; index++) {
    const modalities = [
      [],
      ["text"],
      ["image"],
      [" Image ", "text", "image", "image"],
      ["\ud800", "�"],
    ][random(5)];
    run("chatgpt", [
      {
        ...chatGptCatalogModel,
        id: ["catalog", " 🦀 ", "\ud800"][random(3)],
        model: [" gpt-model ", "ΟΣ", "\ud800"][random(3)],
        description: ["", " ", "🦀\ud800"][random(3)],
        modelSpecialty: [null, "", "family"][random(3)],
        inputModalities: modalities,
        hidden: !!random(2),
        isDefault: !!random(2),
        supportedReasoningEfforts: Array.from({ length: random(4) }, () => ({
          reasoningEffort: ["low", "medium", "high"][random(3)],
          description: ["", " ", "🦀\ud800"][random(3)],
        })),
        upgradeInfo: random(2)
          ? null
          : { public: [index, "\ud800"], nested: { "\udfff": false } },
        availabilityNux: { public: true },
        additionalSpeedTiers: ["", "fast"],
        serviceTiers: [{ id: "", name: "tier", description: "🦀\ud800" }],
      },
    ]);
    run("grok", [
      {
        ...grokCatalogModel,
        id: ["grok-model", " ΟΣ ", "\ud800"][random(3)],
        description: [null, "", "🦀\ud800"][random(3)],
        inputModalities: modalities,
        outputModalities: random(2) ? [] : ["text", "image"],
        contextWindow: [null, 1, 128000, 2147483648][random(4)],
        defaultReasoningEffort: [null, "low", "high"][random(3)],
        supportsReasoning: !!random(2),
        supportedReasoningEfforts: random(2)
          ? []
          : [{ effort: "high", description: null }],
        hidden: !!random(2),
        isDefault: !!random(2),
        rawMetadata: { public: [index, "\ud800"] },
      },
    ]);
  }
  for (const [op, model] of [
    ["chatgpt", chatGptCatalogModel],
    ["grok", grokCatalogModel],
  ]) {
    run(op, []);
    for (const patch of [
      { inputModalities: null },
      { hidden: null },
      { displayName: " " },
      { supportedReasoningEfforts: [null] },
      { defaultReasoningEffort: "invalid" },
    ])
      run(op, [{ ...model, ...patch }]);
  }
  const normalized = normalizeGrokCatalogModel(
    grokModelInventorySchema.parse({
      models: [grokCatalogModel],
      observedAt: "2026-10-27T00:00:00.000Z",
    }).models[0],
  );
  const ids = [
    "grok-model",
    " GROK-MODEL ",
    "x-ai/grok-model",
    "ΟΣ",
    "ος",
    "\ud800",
    "�",
    " ",
  ];
  for (let index = 0; index < 2500; index++) {
    const models = [
      {
        ...normalized,
        nativeModelId: ids[random(ids.length)],
        supportsVision: [null, true, false][random(3)],
        inputModalities: ["text", "\ud800", "text"],
      },
    ];
    const candidates = Array.from({ length: random(4) }, () => ({
      ...normalized,
      nativeModelId: ids[random(ids.length)],
      canonicalModelId: random(2) ? null : ids[random(ids.length)],
      supportsVision: [null, true, false][random(3)],
      inputModalities: ["text", "image", "image", "�", "\ud800"],
    }));
    emit(
      "grok-vision",
      { models, candidates },
      enrichGrokCatalogVisionFromOpenRouter(models, candidates),
    );
  }
}
