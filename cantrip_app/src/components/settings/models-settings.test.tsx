import {
  modelProfileSummarySchema,
  modelProviderSummarySchema,
  settingsBundleSchema,
  type ModelProfileSummary,
} from "@cantrip/protocol";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup as renderStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ModelsSettings } from "./models-settings";
import {
  modelsForProvider,
  modelsSettingsSearchTab,
  providerModelsTab,
  unassignedModels,
} from "./models-settings-state";
import {
  providerSetupDefaults,
  providerSetupFor,
  providerSetupOptions,
  providerInstanceName,
} from "./provider-setup";

// Models settings now includes a query-backed inference usage panel. Supply
// its real query context while keeping worker requests out of navigation tests.
function queryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["workers"], []);
  return client;
}
function withQueries(children: ReactNode, client = queryClient()) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function renderToStaticMarkup(children: ReactNode) {
  return renderStaticMarkup(withQueries(children));
}
function createView(...args: Parameters<typeof TestRenderer.create>) {
  const client = queryClient();
  const view = TestRenderer.create(withQueries(args[0], client), args[1]);
  const update = view.update.bind(view);
  view.update = (element) => update(withQueries(element, client));
  return view;
}

// Exercise menu callbacks without a browser portal; the real primitives are covered by UI QA.
vi.mock("@radix-ui/react-context-menu", () => {
  const Pass = ({ children }: { children: ReactNode }) => children;
  return { Root: Pass, Trigger: Pass, Portal: Pass };
});
vi.mock("@radix-ui/react-dropdown-menu", () => {
  const Pass = ({ children }: { children: ReactNode }) => children;
  return { Root: Pass, Trigger: Pass, Portal: Pass };
});
vi.mock("@/components/ui/styled-menu", () => ({
  StyledContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  StyledDropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  StyledContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect(): void;
  }) => <button onClick={onSelect}>{children}</button>,
  StyledDropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: ReactNode;
    onSelect(): void;
    disabled?: boolean;
    title?: string;
  }) => (
    <button {...props} onClick={onSelect}>
      {children}
    </button>
  ),
}));

const now = "2026-10-07T12:00:00.000Z";
const providers = ["local", "remote"].map((id) =>
  modelProviderSummarySchema.parse({
    id,
    name: id === "local" ? "Ollama" : "OpenRouter",
    kind: id === "local" ? "ollama" : "openai-compatible",
    baseUrl:
      id === "local"
        ? "http://localhost:11434/v1"
        : "https://openrouter.ai/api/v1",
    hasApiKey: false,
    createdAt: now,
    updatedAt: now,
  }),
);
function model(id: string, routes: [string, boolean][]): ModelProfileSummary {
  return modelProfileSummarySchema.parse({
    id,
    name: id,
    routingPolicy: "priority",
    createdAt: now,
    updatedAt: now,
    routes: routes.map(([providerId, enabled], position) => ({
      id: `${id}-${position}`,
      providerId,
      providerName: providerId,
      modelName: id,
      enabled,
      position,
    })),
  });
}
const models = [
  model("local-only", [["local", true]]),
  model("remote-only", [["remote", true]]),
  model("failover", [
    ["local", false],
    ["remote", true],
    ["local", true],
  ]),
  model("orphan", [["deleted", true]]),
];
const preferences = settingsBundleSchema.parse({
  preferences: {
    theme: "system",
    highContrast: false,
    proMode: false,
    proModeOpacity: 80,
    sidebarWidth: 288,
    desktopFrameRate: 30,
    desktopStreamQuality: "adaptive",
    defaultModelId: null,
  },
  providers: [],
  models: [],
}).preferences;
function props(
  overrides: Partial<ComponentProps<typeof ModelsSettings>> = {},
): ComponentProps<typeof ModelsSettings> {
  return {
    activeTab: "general",
    models,
    providers,
    preferences,
    preferencesPending: false,
    removingModel: false,
    onTabChange: vi.fn(),
    onAddProvider: vi.fn(),
    onEditProvider: vi.fn(),
    onAddModel: vi.fn(),
    onEditModel: vi.fn(),
    onRemoveModel: vi.fn(),
    onPreferencesChange: vi.fn().mockResolvedValue(undefined),
    renderProviderOverview: (provider) => (
      <div>{provider.name} usage and status</div>
    ),
    ...overrides,
  };
}

describe("Models provider navigation", () => {
  it.each(["general", "provider:local"] as const)(
    "leaves the tab strip transparent with %s selected",
    async (activeTab) => {
      let view!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        view = createView(<ModelsSettings {...props({ activeTab })} />);
      });
      const strip = view.root.findByProps({ role: "tablist" }).parent!;
      const classes = (strip.props.className as string).split(/\s+/);
      expect(classes.filter((name) => name.startsWith("bg-"))).toEqual([
        "bg-transparent",
      ]);
      expect(classes).toContain("sticky");
      expect(classes).toContain("border-b");
      await act(async () => view.unmount());
    },
  );

  it("scrolls the selected provider into view after tab changes", async () => {
    const scrollIntoView = vi.fn();
    const inputs = props();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = createView(<ModelsSettings {...inputs} />, {
        createNodeMock: (element) =>
          (element.props as { role?: string }).role === "tablist"
            ? { querySelector: () => ({ scrollIntoView }) }
            : null,
      });
    });
    scrollIntoView.mockClear();
    await act(async () => {
      view.update(<ModelsSettings {...inputs} activeTab="provider:remote" />);
    });
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    await act(async () => view.unmount());
  });
  it("includes disabled/failover routes once per provider and retains orphan profiles", () => {
    expect(modelsForProvider(models, "local").map(({ id }) => id)).toEqual([
      "local-only",
      "failover",
    ]);
    expect(modelsForProvider(models, "remote").map(({ id }) => id)).toEqual([
      "remote-only",
      "failover",
    ]);
    expect(modelsForProvider(models, "missing")).toEqual([]);
    expect(unassignedModels(models, providers).map(({ id }) => id)).toEqual([
      "orphan",
    ]);
    expect(unassignedModels(models, [])).toEqual(models);
  });

  it.each([
    ["provider:local", "provider:local"],
    ["provider:missing", "general"],
    ["model:local-only", "provider:local"],
    ["model:failover", "provider:remote"],
    ["model:orphan", "general"],
    ["model:missing", "general"],
    ["default-model", "general"],
  ])("routes search result %s to %s", (id, expected) => {
    expect(modelsSettingsSearchTab(id, models, providers)).toBe(expected);
  });

  it("falls back to a disabled surviving route when search has no enabled surviving route", () => {
    const disabled = model("disabled", [
      ["deleted", true],
      ["local", false],
    ]);
    expect(
      modelsSettingsSearchTab("model:disabled", [disabled], providers),
    ).toBe("provider:local");
  });

  it("separates shared defaults from provider model lists", () => {
    const general = renderToStaticMarkup(<ModelsSettings {...props()} />);
    expect(general).toContain("Default model configuration");
    expect(general).toContain("Standalone Chat defaults");
    expect(general).toContain('aria-label="Unassigned language models"');
    expect(general).not.toContain('aria-label="Edit local-only"');
    const selected = renderToStaticMarkup(
      <ModelsSettings {...props({ activeTab: providerModelsTab("local") })} />,
    );
    expect(selected).toContain("Ollama usage and status");
    expect(selected).toContain('aria-label="Edit local-only"');
    expect(selected).toContain('aria-label="Edit failover"');
    expect(selected).not.toContain('aria-label="Edit remote-only"');
    expect(selected).not.toContain("Default model configuration");
  });

  it("offers setup guidance and provider-specific empty states", () => {
    expect(
      renderToStaticMarkup(
        <ModelsSettings {...props({ providers: [], models: [] })} />,
      ),
    ).toContain("Add a provider with +");
    const empty = renderToStaticMarkup(
      <ModelsSettings
        {...props({ activeTab: "provider:local", models: [] })}
      />,
    );
    for (const operation of ["language", "embedding", "decision"]) {
      expect(empty).toContain(`aria-label="Ollama ${operation} models"`);
      expect(empty).toContain(`No ${operation} models configured.`);
    }
  });

  it("preserves provider identity through rename and recovers after removal", async () => {
    const inputs = props({ activeTab: "provider:local" });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = createView(<ModelsSettings {...inputs} />);
    });
    await act(async () => {
      view.update(
        <ModelsSettings
          {...inputs}
          providers={[
            { ...providers[0]!, name: "Renamed local" },
            providers[1]!,
          ]}
        />,
      );
    });
    expect(
      view.root
        .findAllByProps({ role: "tab" })
        .find((tab) => tab.props["aria-selected"])?.props.title,
    ).toBe("Renamed local");
    expect(inputs.onTabChange).not.toHaveBeenCalled();
    await act(async () => {
      view.update(<ModelsSettings {...inputs} providers={[providers[1]!]} />);
    });
    expect(inputs.onTabChange).toHaveBeenCalledWith("general");
    await act(async () => view.unmount());
  });

  it("retains a saved provider tab while the provider list is still loading", async () => {
    const inputs = props({
      activeTab: "provider:local",
      providers: [],
      providersLoaded: false,
    });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = createView(<ModelsSettings {...inputs} />);
    });
    expect(inputs.onTabChange).not.toHaveBeenCalled();
    await act(async () => {
      view.update(
        <ModelsSettings {...inputs} providers={providers} providersLoaded />,
      );
    });
    expect(inputs.onTabChange).not.toHaveBeenCalled();
    expect(
      view.root
        .findAllByProps({ role: "tab" })
        .find((tab) => tab.props["aria-selected"])?.props.title,
    ).toBe(providers[0]!.name);
    await act(async () => view.unmount());
  });

  it("wires every add preset, per-tab Edit, and provider-scoped Add model", async () => {
    const inputs = props({ activeTab: "provider:local" });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = createView(<ModelsSettings {...inputs} />);
    });
    const buttons = view.root.findAllByType("button");
    for (const setup of providerSetupOptions) {
      await act(async () =>
        buttons
          .find((button) => button.props.children === setup.label)!
          .props.onClick(),
      );
      expect(inputs.onAddProvider).toHaveBeenLastCalledWith(setup.id);
    }
    const edits = buttons.filter(
      (button) =>
        Array.isArray(button.props.children) &&
        button.props.children.includes("Edit"),
    );
    await act(async () => edits[1]!.props.onClick());
    expect(inputs.onEditProvider).toHaveBeenCalledWith(providers[1]);
    for (const operation of ["language", "embedding", "decision"]) {
      await act(async () =>
        view.root
          .findByProps({ "aria-label": `Add ${operation} model` })
          .props.onClick(),
      );
      expect(inputs.onAddModel).toHaveBeenLastCalledWith("local", operation);
    }
    await act(async () => view.unmount());
  });

  it.each(["chatgpt", "grok"] as const)(
    "disables adding a second %s provider but permits other types and re-enables after removal",
    async (kind) => {
      const accountProvider = { ...providers[0]!, id: kind, kind, name: kind };
      const inputs = props({ providers: [...providers, accountProvider] });
      let view!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        view = createView(<ModelsSettings {...inputs} />);
      });
      const disabled = view.root
        .findAllByType("button")
        .filter((button) => button.props.disabled);
      expect(disabled).toHaveLength(1);
      expect(disabled[0]!.props.title).toContain(
        "Add sign-ins to that provider instead",
      );
      expect(
        disabled[0]!
          .findAllByType("span")
          .some(
            (span) =>
              typeof span.props.children === "string" &&
              span.props.children.includes("Already added"),
          ),
      ).toBe(true);
      // Even a direct callback invocation must not bypass the disabled primitive.
      await act(async () => disabled[0]!.props.onClick());
      expect(inputs.onAddProvider).not.toHaveBeenCalled();
      for (const setup of providerSetupOptions.filter(
        (setup) => setup.kind !== kind,
      )) {
        const item = view.root
          .findAllByType("button")
          .find((button) => button.props.children === setup.label)!;
        expect(item.props.disabled).toBe(false);
        await act(async () => item.props.onClick());
        expect(inputs.onAddProvider).toHaveBeenLastCalledWith(setup.id);
      }
      await act(async () =>
        view.update(<ModelsSettings {...inputs} providers={providers} />),
      );
      const item = view.root
        .findAllByType("button")
        .find(
          (button) =>
            button.props.children === providerSetupDefaults(kind).label,
        )!;
      expect(item.props.disabled).toBe(false);
      await act(async () => item.props.onClick());
      expect(inputs.onAddProvider).toHaveBeenLastCalledWith(kind);
      await act(async () => view.unmount());
    },
  );

  it("supports arrow/Home/End tab navigation with activation and prevents page scrolling", async () => {
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = createView(<ModelsSettings {...props()} />);
    });
    const tabs = [0, 1, 2].map(() => ({ focus: vi.fn(), click: vi.fn() }));
    const handler = view.root.findByProps({ role: "tablist" }).props.onKeyDown;
    for (const [key, start, end] of [
      ["ArrowRight", 2, 0],
      ["ArrowLeft", 0, 2],
      ["Home", 2, 0],
      ["End", 0, 2],
    ] as const) {
      const event = {
        key,
        target: tabs[start],
        currentTarget: { querySelectorAll: () => tabs },
        preventDefault: vi.fn(),
      };
      handler(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(tabs[end]!.focus).toHaveBeenCalled();
      expect(tabs[end]!.click).toHaveBeenCalled();
    }
    await act(async () => view.unmount());
  });

  it("keeps mutation failures visible", () => {
    expect(
      renderToStaticMarkup(
        <ModelsSettings
          {...props({
            preferencesError: "Preference failed",
            providerError: "Provider failed",
          })}
        />,
      ),
    ).toContain("Preference failed");
    const selected = renderToStaticMarkup(
      <ModelsSettings
        {...props({
          activeTab: "provider:local",
          modelError: "Model failed",
          providerError: "Provider failed",
        })}
      />,
    );
    expect(selected).toContain("Model failed");
    expect(selected).toContain("Provider failed");
  });
});

describe("provider setup presets", () => {
  it("chooses a distinct editable instance name without renaming existing providers", () => {
    const existing = [
      { name: "ollama" },
      { name: "Ollama 2" },
      { name: "Ollama — GPU Server" },
    ];
    expect(providerInstanceName("Ollama", existing)).toBe("Ollama 3");
    expect(providerInstanceName("LM Studio", existing)).toBe("LM Studio");
    expect(existing.map(({ name }) => name)).toEqual([
      "ollama",
      "Ollama 2",
      "Ollama — GPU Server",
    ]);
  });
  it("offers every supported provider setup with distinct IDs and matching dialog defaults", () => {
    expect(providerSetupOptions.map(({ id }) => id)).toEqual([
      "ollama",
      "lm-studio",
      "llama-cpp",
      "vllm",
      "unsloth",
      "litellm",
      "mlx-lm",
      "openrouter",
      "zai",
      "xai",
      "openai",
      "openai-compatible",
      "chatgpt",
      "grok",
    ]);
    for (const preset of providerSetupOptions) {
      expect(providerSetupDefaults(preset.id)).toBe(preset);
      if (preset.id === "openai-compatible") continue;
      expect(providerSetupFor({ ...providers[0]!, ...preset })).toBe(preset.id);
    }
    expect(providerSetupDefaults("ollama")).toMatchObject({
      name: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(
      providerSetupFor({
        ...providers[1]!,
        baseUrl: "https://custom.example/v1",
      }),
    ).toBe("openai-compatible");
  });
});
