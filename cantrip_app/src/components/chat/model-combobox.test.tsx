import {
  modelProfileSummarySchema,
  type ModelProfileSummary,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  filterConfiguredModels,
  ModelComboboxMenu,
  modelSearchText,
} from "./model-combobox";

const now = "2026-08-27T12:00:00.000Z";

function model(
  id: string,
  name: string,
  providerName: string,
  providerModelName: string,
): ModelProfileSummary {
  return modelProfileSummarySchema.parse({
    id,
    name,
    canonicalModelId: providerModelName,
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

describe("model combobox", () => {
  it("renders an auto-focused shadcn command search and selectable models", () => {
    const markup = renderToStaticMarkup(
      <ModelComboboxMenu
        getOptionDisabled={(candidate) => candidate.id === "gemma"}
        getOptionNote={(candidate) =>
          candidate.id === "gemma" ? "Different provider" : null
        }
        models={models}
        query=""
        selectedValue="sol"
        setQuery={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Search models"');
    expect(markup).toContain("autofocus");
    expect(markup).toContain("Search models…");
    expect(markup).toContain("Gemma 4");
    expect(markup).toContain("GPT 5.6 Sol");
    expect(markup).toContain("Different provider");
    expect(markup).toContain('aria-disabled="true"');
  });

  it("searches display names, canonical IDs, providers, and routed model names", () => {
    expect(modelSearchText(models[1]!)).toContain("openrouter");
    expect(filterConfiguredModels(models, "openai/gpt-5.6")).toEqual([
      models[1],
    ]);
    expect(filterConfiguredModels(models, "ollama")).toEqual([models[0]]);
    expect(filterConfiguredModels(models, "gemma4:26b")).toEqual([models[0]]);
  });
});
