import { Cpu, Network, SlidersHorizontal } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
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
        keywords: ["shared option"],
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
        keywords: ["shared option"],
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
  it("embeds one working control under its category without navigating or clearing search", async () => {
    const changed = vi.fn();
    const section = vi.fn();
    const query = vi.fn();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(
        <SettingsNavigationLayout
          activeSection="general"
          ariaLabel="Settings"
          searchQuery="API credentials"
          sections={sections}
          title="Settings"
          onSearchQueryChange={query}
          onSectionChange={section}
        >
          {(section, results) => (
            <label>
              <input
                aria-label="Provider option"
                type="checkbox"
                onChange={changed}
              />
              {section}: {results?.[0]?.label}
            </label>
          )}
        </SettingsNavigationLayout>,
      );
    });
    const groups = view.root.findAllByProps({
      "data-slot": "settings-search-section",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.props["aria-label"]).toBe("Models");
    const controls = view.root.findAllByProps({
      "aria-label": "Provider option",
    });
    expect(controls).toHaveLength(1);
    await act(async () => controls[0]!.props.onChange());
    expect(changed).toHaveBeenCalledOnce();
    expect(section).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });
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

  it("groups controls from multiple categories in navigation order", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigationLayout
        activeSection="workers"
        ariaLabel="Settings"
        searchQuery="shared option"
        sections={sections}
        title="Settings"
        onSearchQueryChange={vi.fn()}
        onSectionChange={vi.fn()}
      >
        {(section) => <input aria-label={`${section} option`} />}
      </SettingsNavigationLayout>,
    );
    expect(markup.indexOf('data-settings-section="general"')).toBeLessThan(
      markup.indexOf('data-settings-section="models"'),
    );
    expect(markup.match(/aria-label="general option"/g)).toHaveLength(1);
    expect(markup.match(/aria-label="models option"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="workers option"');
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
        {() => <div>General settings content</div>}
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
        {(section) => (
          <div>
            {section === "workers"
              ? "Worker connectivity"
              : "General settings content"}
          </div>
        )}
      </SettingsNavigationLayout>,
    );

    expect(markup).toContain("1 matching setting across all categories.");
    expect(markup).toContain("Worker connectivity");
    expect(markup).toContain("Workers");
    expect(markup).not.toContain("No settings match");
  });
});
