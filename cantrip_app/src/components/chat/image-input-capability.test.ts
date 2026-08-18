import type {
  ModelProfileSummary,
  ModelProviderSummary,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  imageInputCapabilityMessage,
  resolveImageInputCapability,
} from "./image-input-capability";

const provider = {
  id: "openrouter",
  name: "OpenRouter",
} as ModelProviderSummary;

function model(routes: ModelProfileSummary["routes"]): ModelProfileSummary {
  return { id: "glm", name: "GLM 5.2", routes } as ModelProfileSummary;
}

function route(
  providerId: string,
  providerModelId: string,
): ModelProfileSummary["routes"][number] {
  return {
    id: `route-${providerId}`,
    providerId,
    providerName: providerId === "openrouter" ? "OpenRouter" : "Vision Host",
    providerModelId,
    modelName: "z-ai/glm-5.2",
    position: 0,
    enabled: true,
    discoveryManaged: true,
  };
}

function catalog(
  providerId: string,
  modelId: string,
  supportsVision: boolean | null,
): ProviderModelCatalogResult {
  return {
    providerId,
    models: [
      {
        id: modelId,
        providerId,
        nativeModelId: "z-ai/glm-5.2",
        canonicalModelId: "z-ai/glm-5.2",
        supportsVision,
      } as ProviderModelCatalogEntry,
    ],
    availability: [],
    syncStates: [],
    servedStale: false,
  };
}

describe("chat image input capability", () => {
  it("identifies an OpenRouter text-only model from cached catalog metadata", () => {
    const capability = resolveImageInputCapability({
      catalogs: new Map([
        ["openrouter", catalog("openrouter", "glm-openrouter", false)],
      ]),
      model: model([route("openrouter", "glm-openrouter")]),
      providers: [provider],
    });

    expect(capability.state).toBe("unsupported");
    expect(imageInputCapabilityMessage("GLM 5.2", capability)).toBe(
      "GLM 5.2 is text-only through OpenRouter. The image will stay attached so you can switch models; if sent now, the agent receives its worker-local file path instead.",
    );
  });

  it("reports positive support when the route accepts images", () => {
    const capability = resolveImageInputCapability({
      catalogs: new Map([
        ["openrouter", catalog("openrouter", "glm-openrouter", true)],
      ]),
      model: model([route("openrouter", "glm-openrouter")]),
      providers: [provider],
    });

    expect(capability.state).toBe("supported");
    expect(imageInputCapabilityMessage("Vision model", capability)).toBe(
      "Vision model accepts image input.",
    );
  });

  it("preserves ChatGPT image support without waiting for catalog discovery", () => {
    const chatgptProvider: ModelProviderSummary = {
      ...provider,
      id: "chatgpt",
      kind: "chatgpt",
      name: "ChatGPT",
    };
    const capability = resolveImageInputCapability({
      catalogs: new Map(),
      model: model([route("chatgpt", "codex-model")]),
      providers: [chatgptProvider],
    });

    expect(capability.state).toBe("supported");
  });

  it("explains mixed route capabilities without blocking the attachment", () => {
    const visionProvider = {
      ...provider,
      id: "vision-provider",
      name: "Vision Host",
    };
    const capability = resolveImageInputCapability({
      catalogs: new Map([
        ["openrouter", catalog("openrouter", "glm-openrouter", false)],
        ["vision-provider", catalog("vision-provider", "glm-vision", true)],
      ]),
      model: model([
        route("openrouter", "glm-openrouter"),
        route("vision-provider", "glm-vision"),
      ]),
      providers: [provider, visionProvider],
    });

    expect(capability.state).toBe("mixed");
    expect(imageInputCapabilityMessage("GLM 5.2", capability)).toContain(
      "accepts images through Vision Host, but not through OpenRouter",
    );
  });

  it("reserves unknown for a route without catalog metadata", () => {
    const capability = resolveImageInputCapability({
      catalogs: new Map(),
      model: model([route("openrouter", "glm-openrouter")]),
      providers: [provider],
    });

    expect(capability.state).toBe("unknown");
    expect(imageInputCapabilityMessage("GLM 5.2", capability)).toContain(
      "No image capability metadata is available for OpenRouter",
    );
  });
});
