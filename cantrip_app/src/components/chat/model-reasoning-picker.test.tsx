import {
  chatReasoningStateSchema,
  modelProfileSummarySchema,
  type ModelConfiguration,
  type ModelProfileSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  chatModelConfiguration,
  defaultModelConfiguration,
  filterConfiguredModels,
  ModelReasoningPicker,
  modelConfigurationSettingsUpdate,
  modelReasoningChoices,
  modelsShareProvider,
} from "./model-reasoning-picker";

const now = "2026-08-15T12:00:00.000Z";

function model(
  id: string,
  name: string,
  providerName: string,
  providerModelName: string,
  providerId = `${id}-provider`,
): ModelProfileSummary {
  return modelProfileSummarySchema.parse({
    id,
    name,
    routes: [
      {
        id: `${id}-route`,
        providerId,
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

const inheritedConfiguration: ModelConfiguration = {
  modelId: "sol",
  reasoningEffort: "high",
  customSubagentModel: false,
  subagentModelId: "gemma",
  subagentReasoningEffort: "low",
};

describe("model reasoning picker", () => {
  it("uses one trigger for the complete root and subagent configuration", () => {
    const markup = renderToStaticMarkup(
      <ModelReasoningPicker
        configuration={inheritedConfiguration}
        models={models}
        onSave={() => {}}
      />,
    );

    expect(markup).toContain("GPT 5.6 Sol");
    expect(markup).toContain("Subagents inherit root");
    expect(markup).toContain('aria-label="Configure agent models"');
    expect(markup).not.toContain("lucide-brain");
    expect(markup).not.toContain("<select");
  });

  it("summarizes a custom subagent without a second composer control", () => {
    const markup = renderToStaticMarkup(
      <ModelReasoningPicker
        configuration={{
          ...inheritedConfiguration,
          customSubagentModel: true,
        }}
        models={models}
        onSave={() => {}}
      />,
    );

    expect(markup).toContain("Gemma 4");
    expect(markup).toContain("lucide-check");
    expect(markup).not.toContain("lucide-brain");
  });

  it("maps legacy chats to inherited subagent defaults", () => {
    expect(
      chatModelConfiguration(
        {
          modelId: null,
          reasoningEffort: "medium",
        },
        "sol",
      ),
    ).toEqual({
      modelId: "sol",
      reasoningEffort: "medium",
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    });
  });

  it("round-trips all default model configuration fields through settings", () => {
    const configuration = defaultModelConfiguration({
      defaultModelId: "sol",
      defaultReasoningEffort: "high",
      defaultCustomSubagentModel: true,
      defaultSubagentModelId: "gemma",
      defaultSubagentReasoningEffort: "low",
    });

    expect(modelConfigurationSettingsUpdate(configuration)).toEqual({
      defaultModelId: "sol",
      defaultReasoningEffort: "high",
      defaultCustomSubagentModel: true,
      defaultSubagentModelId: "gemma",
      defaultSubagentReasoningEffort: "low",
    });
  });

  it("retains saved custom values while inheritance is active", () => {
    expect(
      modelConfigurationSettingsUpdate(inheritedConfiguration),
    ).toMatchObject({
      defaultCustomSubagentModel: false,
      defaultSubagentModelId: "gemma",
      defaultSubagentReasoningEffort: "low",
    });
  });

  it("filters by display name, provider, and provider model name", () => {
    expect(filterConfiguredModels(models, "openrouter")).toEqual([models[1]]);
    expect(filterConfiguredModels(models, "gemma4:26b")).toEqual([models[0]]);
    expect(filterConfiguredModels(models, "sol")).toEqual([models[1]]);
  });

  it("marks subagent models compatible only when an enabled provider is shared", () => {
    const root = model("root", "Root", "OpenAI", "root", "shared");
    const child = model("child", "Child", "OpenAI", "child", "shared");
    expect(modelsShareProvider(root, child)).toBe(true);
    expect(modelsShareProvider(root, models[0]!)).toBe(false);
  });

  it("orders optional reasoning choices from provider default to highest", () => {
    const state = chatReasoningStateSchema.parse({
      modelId: "sol",
      reasoningEffort: "medium",
      options: [
        { effort: "xhigh", description: null },
        { effort: "low", description: null },
        { effort: "medium", description: null },
      ],
      reasoningMandatory: false,
      incompleteMetadata: false,
    });

    expect(modelReasoningChoices(state).map(({ effort }) => effort)).toEqual([
      null,
      "low",
      "medium",
      "xhigh",
    ]);
  });
});
