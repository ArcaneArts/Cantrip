import { settingsBundleSchema, type SettingsBundle } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  EliteModePreferenceControl,
  ProModePreferenceControl,
  SettingsPage,
  changedAccountLabel,
  initialProviderName,
  settingsNavigationSections,
  settingsNavigationSectionsForResources,
  type SettingsSection,
} from "./settings-page";
import { settingsSearchResults } from "./settings-navigation";

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

function settingsWithContentGutters(contentGutters: boolean): SettingsBundle {
  return settingsBundleSchema.parse({
    preferences: {
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 80,
      contentGutters,
      sidebarWidth: 288,
      desktopFrameRate: 30,
      desktopStreamQuality: "adaptive",
      defaultModelId: null,
    },
    providers: [],
    models: [],
  });
}

describe("account settings", () => {
  it("opens Pro Mode configuration without letting a secondary click toggle it", async () => {
    const configured: boolean[] = [];
    const checkedChanges: boolean[] = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProModePreferenceControl
          checked={false}
          disabled={false}
          onCheckedChange={(checked) => checkedChanges.push(checked)}
          onConfigure={() => configured.push(true)}
        />,
      );
    });
    const label = renderer.root.findByType("label");
    const secondaryMouseDown = {
      button: 2,
      ctrlKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const contextMenu = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const secondaryClick = {
      button: 2,
      ctrlKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    label.props.onMouseDownCapture(secondaryMouseDown);
    label.props.onClickCapture(secondaryClick);
    label.props.onContextMenuCapture(contextMenu);

    expect(secondaryMouseDown.preventDefault).toHaveBeenCalledOnce();
    expect(secondaryMouseDown.stopPropagation).toHaveBeenCalledOnce();
    expect(secondaryClick.preventDefault).toHaveBeenCalledOnce();
    expect(secondaryClick.stopPropagation).toHaveBeenCalledOnce();
    expect(contextMenu.preventDefault).toHaveBeenCalledOnce();
    expect(contextMenu.stopPropagation).toHaveBeenCalledOnce();
    expect(configured).toEqual([true]);
    expect(checkedChanges).toEqual([]);

    const primaryMouseDown = {
      button: 0,
      ctrlKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    label.props.onMouseDownCapture(primaryMouseDown);
    renderer.root.findByType("input").props.onChange({
      target: { checked: true },
    });

    expect(primaryMouseDown.preventDefault).not.toHaveBeenCalled();
    expect(primaryMouseDown.stopPropagation).not.toHaveBeenCalled();
    expect(checkedChanges).toEqual([true]);

    await act(async () => renderer.unmount());
  });

  it("toggles Elite Mode normally and configures it with a touch long press", async () => {
    vi.useFakeTimers();
    const configured: boolean[] = [];
    const checkedChanges: boolean[] = [];
    let renderer!: TestRenderer.ReactTestRenderer;

    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <EliteModePreferenceControl
            checked
            disabled={false}
            onCheckedChange={(checked) => checkedChanges.push(checked)}
            onConfigure={() => configured.push(true)}
          />,
        );
      });
      const label = renderer.root.findByType("label");

      label.props.onPointerDownCapture({ pointerType: "touch" });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      expect(configured).toEqual([true]);

      const contextMenuAfterLongPress = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      label.props.onContextMenuCapture(contextMenuAfterLongPress);

      expect(contextMenuAfterLongPress.preventDefault).toHaveBeenCalledOnce();
      expect(contextMenuAfterLongPress.stopPropagation).toHaveBeenCalledOnce();
      expect(configured).toEqual([true]);

      const clickAfterLongPress = {
        button: 0,
        ctrlKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      label.props.onClickCapture(clickAfterLongPress);

      expect(clickAfterLongPress.preventDefault).toHaveBeenCalledOnce();
      expect(clickAfterLongPress.stopPropagation).toHaveBeenCalledOnce();
      expect(checkedChanges).toEqual([]);

      label.props.onPointerDownCapture({ pointerType: "touch" });
      label.props.onPointerUpCapture();
      const regularTap = {
        button: 0,
        ctrlKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      label.props.onClickCapture(regularTap);
      renderer.root.findByType("input").props.onChange({
        target: { checked: false },
      });

      expect(regularTap.preventDefault).not.toHaveBeenCalled();
      expect(regularTap.stopPropagation).not.toHaveBeenCalled();
      expect(checkedChanges).toEqual([false]);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      vi.useRealTimers();
    }
  });

  it("defaults new Ollama providers to the Ollama name", () => {
    expect(initialProviderName(null)).toBe("Ollama");
    expect(initialProviderName({ name: "Local models" })).toBe("Local models");
  });

  it("only saves changed, non-empty account labels", () => {
    expect(changedAccountLabel("Arcane", "  Personal  ")).toBe("Personal");
    expect(changedAccountLabel("Arcane", " Arcane ")).toBeNull();
    expect(changedAccountLabel("Arcane", "   ")).toBeNull();
  });

  it("keeps the Elite lab out of the visible settings navigation", () => {
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
    expect(markup).toContain('data-slot="settings-sidebar"');
    expect(markup).toContain('data-slot="settings-mobile-categories"');
    expect(markup).not.toContain('role="tablist"');
  });

  it("indexes settings from every account category", () => {
    expect(
      settingsSearchResults("project membership", settingsNavigationSections),
    ).toEqual([
      expect.objectContaining({
        id: "project-membership",
        sectionId: "workspaces",
      }),
    ]);
    expect(
      settingsSearchResults("MCP HTTP", settingsNavigationSections),
    ).toEqual([
      expect.objectContaining({ id: "mcp-servers", sectionId: "mcp" }),
    ]);
    expect(
      settingsSearchResults("VSIX marketplace", settingsNavigationSections),
    ).toEqual([
      expect.objectContaining({ id: "extensions", sectionId: "code" }),
    ]);
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
    expect(code).toContain("Editor and extensions");
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
    expect(markup).toContain('aria-label="Elite Mode"');
    expect(markup).not.toContain('aria-label="Configure Elite Mode"');
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

  it("keeps content gutters off by default and exposes them in General", () => {
    const disabled = renderSettings("general");
    const enabled = renderSettings("general", settingsWithContentGutters(true));

    expect(disabled).toContain('aria-label="Content gutters"');
    expect(disabled).not.toContain(
      'aria-label="Content gutters" type="checkbox" class="size-3.5 accent-primary" checked=""',
    );
    expect(enabled).toContain(
      'aria-label="Content gutters" type="checkbox" class="size-3.5 accent-primary" checked=""',
    );
    expect(enabled).toContain('data-content-gutter="standard"');
    expect(
      renderSettings("code", settingsWithContentGutters(true)),
    ).not.toContain('data-content-gutter="standard"');
  });

  it("keeps random agent names disabled by default", () => {
    const markup = renderSettings("general");

    expect(markup).toContain("Agent chat names");
    expect(markup).toContain('aria-label="Use random agent names"');
    expect(markup).not.toContain(
      'aria-label="Use random agent names" checked=""',
    );
  });

  it("keeps the current prompt header enabled by default and exposes its toggle", () => {
    const defaultMarkup = renderSettings("general");
    const disabledMarkup = renderSettings(
      "general",
      settingsBundleSchema.parse({
        preferences: {
          theme: "system",
          highContrast: false,
          proMode: false,
          proModeOpacity: 80,
          sidebarWidth: 288,
          showChatPromptOverlay: false,
          desktopFrameRate: 30,
          desktopStreamQuality: "adaptive",
          defaultModelId: null,
        },
        providers: [],
        models: [],
      }),
    );

    expect(defaultMarkup).toContain("Chat display");
    expect(defaultMarkup).toContain("Show current prompt");
    expect(defaultMarkup).toMatch(
      /aria-label="Show current prompt header"[^>]*checked=""/u,
    );
    expect(disabledMarkup).not.toMatch(
      /aria-label="Show current prompt header"[^>]*checked=""/u,
    );
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
    expect(markup).toContain(">Policy<");
    expect(markup).toContain("Search policies");
    expect(markup).toContain("Policy");
  });

  it("separates general preferences from model and provider management", () => {
    const general = renderSettings("general");
    expect(general).toContain("System follows the operating system.");
    expect(general).toContain("Default agent permissions");
    expect(general).toContain("Standalone Chat permissions");
    expect(general).toContain("YOLO mode");
    expect(general).toContain("Search all settings");
    const standalonePermissions = general.indexOf(
      ">Standalone Chat permissions<",
    );
    expect(
      general.slice(standalonePermissions - 300, standalonePermissions),
    ).toContain("lucide-lock");
    expect(general).not.toContain("Cantrip updates");
    expect(general).not.toContain(
      "Logical models with ordered provider failover routes.",
    );

    const models = renderSettings("models");
    expect(models).toContain("Search all settings");
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
    const navigationSections = settingsNavigationSectionsForResources(
      settings.providers,
      settings.models,
    );

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
    expect(settingsSearchResults("gemma4:26b", navigationSections)).toEqual([
      expect.objectContaining({ id: "model:model-1", sectionId: "models" }),
    ]);
    expect(settingsSearchResults("127.0.0.1", navigationSections)).toEqual([
      expect.objectContaining({
        id: "provider:provider-1",
        sectionId: "models",
      }),
    ]);
  });
});
