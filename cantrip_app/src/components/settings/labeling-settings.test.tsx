import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UserSettings } from "@cantrip/protocol";
import { LabelingSettings } from "./labeling-settings";
import { settingsNavigationSections } from "./settings-page";
import { settingsSearchResults } from "./settings-navigation";

describe("labeling preferences", () => {
  it("indexes labeling configuration in General settings", () => {
    expect(
      settingsSearchResults("labeling model", settingsNavigationSections),
    ).toEqual([
      expect.objectContaining({ id: "automatic-titles", sectionId: "general" }),
    ]);
  });
  it("shows default-on switches and default model", () => {
    const markup = renderToStaticMarkup(
      <LabelingSettings
        settings={
          {
            autoNameTasks: true,
            autoNameChats: true,
            randomAgentNames: false,
            labelingModelId: null,
          } as UserSettings
        }
        models={[]}
        pending={false}
        update={vi.fn()}
      />,
    );
    expect(markup.match(/checked=""/gu)).toHaveLength(2);
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain("Use default model");
    expect(markup).toContain("six words");
    expect(markup).toContain("three");
  });
  it("soft-disables chat titling without unchecking it when random names are on", () => {
    const markup = renderToStaticMarkup(
      <LabelingSettings
        settings={
          {
            autoNameTasks: true,
            autoNameChats: true,
            randomAgentNames: true,
            labelingModelId: null,
          } as UserSettings
        }
        models={[]}
        pending={false}
        update={vi.fn()}
      />,
    );
    expect(markup.match(/checked=""/gu)).toHaveLength(2);
    expect(markup.match(/disabled=""/gu)).toHaveLength(1);
    expect(markup).toContain("Its setting is retained");
  });
});
