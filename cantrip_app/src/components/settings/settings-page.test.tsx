import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "./settings-page";

function renderSettings(initialSection: "general" | "models") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
    expect(general).not.toContain(
      "Logical models with ordered provider failover routes.",
    );

    const models = renderSettings("models");
    expect(models).toContain("Search providers and models");
    expect(models).toContain(
      "Logical models with ordered provider failover routes.",
    );
    expect(models).toContain(
      "Ollama, compatible APIs, and isolated ChatGPT accounts.",
    );
    expect(models).not.toContain("System follows the operating system.");
  });
});
