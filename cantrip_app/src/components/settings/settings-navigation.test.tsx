import { Cpu, Network, SlidersHorizontal } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  SettingsNavigationLayout,
  settingsSearchResults,
  type SettingsNavigationSection,
} from "./settings-navigation";

type Section = "general" | "models" | "workers";

const sections: readonly SettingsNavigationSection<Section>[] = [
  {
    id: "general",
    label: "General",
    description: "Appearance and permissions",
    icon: SlidersHorizontal,
    searchItems: [
      {
        id: "appearance",
        label: "Appearance",
        description: "Theme and contrast",
      },
    ],
  },
  {
    id: "models",
    label: "Models",
    description: "Providers and routing",
    icon: Cpu,
    searchItems: [
      {
        id: "providers",
        label: "Model providers",
        description: "API endpoints and credentials",
      },
    ],
  },
  {
    id: "workers",
    label: "Workers",
    description: "Connected worker runtimes",
    icon: Network,
    searchItems: [
      {
        id: "connectivity",
        label: "Worker connectivity",
        description: "Online status and enrollment",
      },
    ],
  },
];

describe("settings navigation", () => {
  it("searches setting metadata across inactive categories", () => {
    expect(settingsSearchResults("API credentials", sections)).toEqual([
      expect.objectContaining({
        id: "providers",
        sectionId: "models",
        sectionLabel: "Models",
      }),
    ]);
    expect(settingsSearchResults("worker", sections)).toEqual([
      expect.objectContaining({
        id: "connectivity",
        sectionId: "workers",
      }),
    ]);
  });

  it("renders a desktop sidebar and a mobile category index", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigationLayout
        activeSection="general"
        ariaLabel="Account settings categories"
        searchQuery=""
        sections={sections}
        title="Settings"
        onSearchQueryChange={vi.fn()}
        onSectionChange={vi.fn()}
      >
        <div>General settings content</div>
      </SettingsNavigationLayout>,
    );

    expect(markup).toContain('data-slot="settings-sidebar"');
    expect(markup).toContain('data-slot="sidebar-scroll-region"');
    expect(markup).toContain('data-slot="settings-mobile-categories"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain("Choose a category or search every setting.");
    expect(markup).not.toContain("All settings");
    expect(markup).toContain("General settings content");
    expect(markup).not.toContain('role="tablist"');
  });

  it("renders global results instead of the active category on search", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigationLayout
        activeSection="general"
        ariaLabel="Account settings categories"
        searchQuery="worker"
        sections={sections}
        title="Settings"
        onSearchQueryChange={vi.fn()}
        onSectionChange={vi.fn()}
      >
        <div>General settings content</div>
      </SettingsNavigationLayout>,
    );

    expect(markup).toContain("1 matching setting across all categories.");
    expect(markup).toContain("Worker connectivity");
    expect(markup).toContain("Workers");
    expect(markup).not.toContain("No settings match");
  });
});
