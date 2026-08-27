import { settingsBundleSchema, type SettingsBundle } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SettingsPage,
  changedAccountLabel,
  initialProviderName,
  type SettingsSection,
} from "./settings-page";

function renderSettings(
  initialSection: SettingsSection,
  settings?: SettingsBundle,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (settings) queryClient.setQueryData(["settings"], settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SettingsPage appearance="dark" initialSection={initialSection} />
    </QueryClientProvider>,
  );
}

describe("account settings", () => {
  it("defaults new Ollama providers to the Ollama name", () => {
    expect(initialProviderName(null)).toBe("Ollama");
    expect(initialProviderName({ name: "Local models" })).toBe("Local models");
  });

  it("only saves changed, non-empty account labels", () => {
    expect(changedAccountLabel("Arcane", "  Personal  ")).toBe("Personal");
    expect(changedAccountLabel("Arcane", " Arcane ")).toBeNull();
    expect(changedAccountLabel("Arcane", "   ")).toBeNull();
  });

  it("keeps the Elite lab out of the visible settings tabs", () => {
    const markup = renderSettings("general");
    const general = markup.indexOf(">General<");
    const usage = markup.indexOf(">Usage<");
    const code = markup.indexOf(">Code<");
    const models = markup.indexOf(">Models<");
    const tasks = markup.indexOf(">Tasks<");
    const workers = markup.indexOf(">Workers<");
    const logs = markup.indexOf(">Logs<");

    expect(general).toBeGreaterThanOrEqual(0);
    expect(markup).not.toContain(">Elite<");
    expect(code).toBeGreaterThan(general);
    expect(usage).toBeGreaterThan(code);
    expect(models).toBeGreaterThan(usage);
    expect(tasks).toBeGreaterThan(models);
    expect(workers).toBeGreaterThan(tasks);
    expect(logs).toBeGreaterThan(workers);
  });

  it("exposes account usage as its own settings section", () => {
    const markup = renderSettings("usage");

    expect(markup).toContain(">Usage<");
    expect(markup).toContain("Loading account usage…");
  });

  it("mounts the retained Code settings workbench only after Code is activated", () => {
    expect(renderSettings("general")).not.toContain(
      'data-slot="code-settings-surface"',
    );
    const code = renderSettings("code");
    expect(code).toContain('data-slot="code-settings-surface"');
    expect(code).toContain("Starting the Code customization workbench…");
    expect(code).toContain("Code customization sections");
    expect(code).toContain("Extensions");
    expect(code).toContain("Code customization worker");
    expect(code).not.toContain("VS Code settings</p>");
  });

  it("keeps the Elite configuration entry in Appearance without Pro Mode", () => {
    const markup = renderSettings("general");
    const appearance = markup.indexOf(">Appearance<");
    const eliteMode = markup.indexOf(">Elite Mode<");
    const nextSettingsRow = markup.indexOf(">Default agent permissions<");

    expect(appearance).toBeGreaterThanOrEqual(0);
    expect(eliteMode).toBeGreaterThan(appearance);
    expect(eliteMode).toBeLessThan(nextSettingsRow);
    expect(markup).toContain("Elite Mode");
    expect(markup).not.toContain("elite-secret-entry");
    expect(markup).toContain('aria-label="Configure Elite Mode"');
  });

  it("uses a compact brightness dropdown in Appearance", () => {
    const markup = renderSettings("general");

    expect(markup).toContain('aria-label="Brightness"');
    expect(markup).toContain(
      '<option value="system" selected="">System</option>',
    );
    expect(markup).toContain('<option value="light">Light</option>');
    expect(markup).toContain('<option value="dark">Dark</option>');
  });

  it("exposes the visual reveal laboratory as its own section", () => {
    const markup = renderSettings("elite");
    expect(markup).toContain("Elite reveal laboratory");
    expect(markup).toContain("Experimental");
    expect(markup).toContain("Configure");
    expect(markup).toContain('data-elite-reveal=""');
  });

  it("exposes root policy management as its own settings section", () => {
    const markup = renderSettings("policies");
    expect(markup).toContain(">Policies<");
    expect(markup).toContain("Search policies");
    expect(markup).toContain("Policy");
  });

  it("separates general preferences from model and provider management", () => {
    const general = renderSettings("general");
    expect(general).toContain("System follows the operating system.");
    expect(general).toContain("Default agent permissions");
    expect(general).toContain("Standalone Chat permissions");
    expect(general).toContain("YOLO mode");
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
    expect(markup).toContain("Default model configuration");
    expect(markup).toContain("Standalone Chat defaults");
    expect(markup).toContain(
      "Root and subagent defaults for newly created IDE Agent chats.",
    );
    expect(markup).toContain('aria-label="Configure default models"');
    expect(markup).toContain("Subagents inherit root");
    expect(markup).not.toContain("Default for new agents");
    expect(markup).toContain("py-1.5");
    expect(markup).not.toContain("lucide-pencil");
  });
});
