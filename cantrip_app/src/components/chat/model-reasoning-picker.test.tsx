import {
  chatReasoningStateSchema,
  modelProfileSummarySchema,
  type ModelProfileSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  filterConfiguredModels,
  ModelReasoningPicker,
  modelReasoningChoices,
} from "./model-reasoning-picker";

const now = "2026-08-15T12:00:00.000Z";

function model(
  id: string,
  name: string,
  providerName: string,
  providerModelName: string,
): ModelProfileSummary {
  return modelProfileSummarySchema.parse({
    id,
    name,
    routes: [
      {
        id: `${id}-route`,
        providerId: `${id}-provider`,
        providerName,
        providerModelId: null,
        modelName: providerModelName,
        position: 0,
        enabled: true,
      },
    ],
    routingPolicy: "priority",
    createdAt: now,
    updatedAt: now,
  });
}

const models = [
  model("gemma", "Gemma 4", "Ollama", "gemma4:26b"),
  model("sol", "GPT 5.6 Sol", "OpenRouter", "openai/gpt-5.6-sol"),
];

describe("model reasoning picker", () => {
  it("renders the current model as a shrink-wrapped text trigger", () => {
    const markup = renderToStaticMarkup(
      <ModelReasoningPicker
        models={models}
        selectedModelId="sol"
        reasoningEffort={null}
        onSelectModel={() => {}}
        onSelectReasoning={() => {}}
      />,
    );

    expect(markup).toContain(">GPT 5.6 Sol<");
    expect(markup).toContain('aria-label="Select agent model"');
    expect(markup).not.toContain("<select");
  });

  it("filters by display name, provider, and provider model name", () => {
    expect(filterConfiguredModels(models, "openrouter")).toEqual([models[1]]);
    expect(filterConfiguredModels(models, "gemma4:26b")).toEqual([models[0]]);
    expect(filterConfiguredModels(models, "sol")).toEqual([models[1]]);
  });

  it("offers provider default only when reasoning is optional", () => {
    const optional = chatReasoningStateSchema.parse({
      modelId: "sol",
      reasoningEffort: "high",
      options: [
        { effort: "low", description: null },
        { effort: "high", description: null },
      ],
      reasoningMandatory: false,
      incompleteMetadata: false,
    });
    const mandatory = { ...optional, reasoningMandatory: true };

    expect(modelReasoningChoices(optional).map(({ effort }) => effort)).toEqual(
      [null, "low", "high"],
    );
    expect(
      modelReasoningChoices(mandatory).map(({ effort }) => effort),
    ).toEqual(["low", "high"]);
  });

  it("orders the slider from least to most reasoning", () => {
    const state = chatReasoningStateSchema.parse({
      modelId: "sol",
      reasoningEffort: "medium",
      options: [
        { effort: "xhigh", description: null },
        { effort: "high", description: null },
        { effort: "low", description: null },
        { effort: "medium", description: null },
      ],
      reasoningMandatory: true,
      incompleteMetadata: false,
    });

    expect(modelReasoningChoices(state).map(({ effort }) => effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
