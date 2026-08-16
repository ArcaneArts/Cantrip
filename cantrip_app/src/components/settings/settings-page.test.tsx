import { settingsBundleSchema, type SettingsBundle } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "./settings-page";

function renderSettings(
  initialSection: "general" | "models",
  settings?: SettingsBundle,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (settings) queryClient.setQueryData(["settings"], settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SettingsPage initialSection={initialSection} />
    </QueryClientProvider>,
  );
}

describe("account settings", () => {
  it("places Models immediately after General", () => {
    const markup = renderSettings("general");
    const general = markup.indexOf(">General<");
    const models = markup.indexOf(">Models<");
    const workers = markup.indexOf(">Workers<");

    expect(general).toBeGreaterThanOrEqual(0);
    expect(models).toBeGreaterThan(general);
    expect(workers).toBeGreaterThan(models);
  });

  it("separates general preferences from model and provider management", () => {
    const general = renderSettings("general");
    expect(general).toContain("System follows the operating system.");
    expect(general).toContain("Search general settings");
    expect(general).not.toContain("Cantrip updates");
    expect(general).not.toContain(
      "Logical models with ordered provider failover routes.",
    );

    const models = renderSettings("models");
    expect(models).toContain("Search providers and models");
    expect(models).toContain(
      "Logical models with ordered provider failover routes.",
    );
    expect(models).toContain(
      "Ollama, compatible APIs, and portable ChatGPT or Grok accounts.",
    );
    expect(models).not.toContain("System follows the operating system.");
  });

  it("uses compact provider and model rows as the edit targets", () => {
    const settings = settingsBundleSchema.parse({
      preferences: {
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: "model-1",
      },
      providers: [
        {
          id: "provider-1",
          name: "Ollama",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          hasApiKey: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      models: [
        {
          id: "model-1",
          name: "gemma4:26b",
          routingPolicy: "priority",
          routes: [
            {
              id: "route-1",
              providerId: "provider-1",
              providerName: "Ollama",
              modelName: "gemma4:26b",
              enabled: true,
              position: 0,
            },
          ],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    const markup = renderSettings("models", settings);

    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-label="Edit Ollama"');
    expect(markup).toContain('aria-label="Edit gemma4:26b"');
    expect(markup).toContain("py-1.5");
    expect(markup).not.toContain("lucide-pencil");
  });
});
