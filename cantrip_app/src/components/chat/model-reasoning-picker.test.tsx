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
  nextReasoningTriggerState,
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
    expect(markup).not.toContain('aria-label="Configure reasoning effort"');
    expect(markup).not.toContain("<select");
  });

  it("places the reasoning trigger immediately after the model selector", () => {
    const reasoningState = chatReasoningStateSchema.parse({
      modelId: "sol",
      reasoningEffort: "high",
      options: [
        { effort: "low", description: null },
        { effort: "high", description: null },
      ],
      reasoningMandatory: false,
      incompleteMetadata: false,
    });
    const markup = renderToStaticMarkup(
      <ModelReasoningPicker
        models={models}
        selectedModelId="sol"
        reasoningEffort="high"
        reasoningState={reasoningState}
        onSelectModel={() => {}}
        onSelectReasoning={() => {}}
      />,
    );

    const modelTrigger = markup.indexOf('aria-label="Select agent model"');
    const reasoningTrigger = markup.indexOf(
      'aria-label="Configure reasoning effort"',
    );
    expect(modelTrigger).toBeGreaterThanOrEqual(0);
    expect(reasoningTrigger).toBeGreaterThan(modelTrigger);
    expect(markup.slice(modelTrigger, reasoningTrigger)).toContain(
      "GPT 5.6 Sol",
    );
    expect(markup.slice(reasoningTrigger)).toContain("lucide-brain");
  });

  it("toggles the reasoning panel closed when its trigger is clicked again", () => {
    expect(nextReasoningTriggerState(false, "models")).toEqual({
      open: true,
      panel: "reasoning",
    });
    expect(nextReasoningTriggerState(true, "models")).toEqual({
      open: true,
      panel: "reasoning",
    });
    expect(nextReasoningTriggerState(true, "reasoning")).toEqual({
      open: false,
      panel: "reasoning",
    });
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

  it("offers the documented GLM reasoning choices per message", () => {
    const glm53 = chatReasoningStateSchema.parse({
      modelId: "glm-5.3",
      reasoningEffort: null,
      options: [
        { effort: "low", description: "Low reasoning effort" },
        { effort: "high", description: "High reasoning effort" },
        { effort: "max", description: "Maximum reasoning effort" },
      ],
      reasoningMandatory: false,
      incompleteMetadata: false,
    });
    const glm5Turbo = chatReasoningStateSchema.parse({
      modelId: "glm-5-turbo",
      reasoningEffort: null,
      options: [],
      reasoningMandatory: false,
      incompleteMetadata: false,
    });

    expect(modelReasoningChoices(glm53)).toEqual([
      { effort: null, label: "Default" },
      { effort: "low", label: "low" },
      { effort: "high", label: "high" },
      { effort: "max", label: "max" },
    ]);
    expect(modelReasoningChoices(glm5Turbo)).toEqual([
      { effort: null, label: "Default" },
    ]);
  });
});
