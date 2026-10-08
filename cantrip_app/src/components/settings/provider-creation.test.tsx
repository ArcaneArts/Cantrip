import { settingsBundleSchema, type SettingsBundle } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { createModelProvider, updateModelProvider } from "@/lib/api";
import type { ModelsSettings } from "./models-settings";
import { SettingsPage } from "./settings-page";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getWorkers: vi.fn().mockResolvedValue([]),
  createModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? children : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogClose: Pass,
  };
});
// Keep this test focused on the real provider dialog/mutation. Menu availability
// and callbacks are exercised separately in models-settings.test.tsx.
vi.mock("./models-settings", () => ({
  ModelsSettings: ({
    onAddProvider,
    onEditProvider,
    providers,
  }: ComponentProps<typeof ModelsSettings>) => (
    <div>
      <button onClick={() => onAddProvider("ollama")}>Add Ollama</button>
      <button onClick={() => onAddProvider("chatgpt")}>Add ChatGPT</button>
      {providers.map((provider) => (
        <button key={provider.id} onClick={() => onEditProvider(provider)}>
          Edit {provider.kind}
        </button>
      ))}
    </div>
  ),
}));

const now = "2026-10-07T12:00:00.000Z";
function bundle(kinds: Array<"chatgpt" | "grok" | "ollama">): SettingsBundle {
  return settingsBundleSchema.parse({
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
    providers: kinds.map((kind) => ({
      id: kind,
      name: kind,
      kind,
      baseUrl: "https://example.test/v1",
      hasApiKey: false,
      createdAt: now,
      updatedAt: now,
    })),
    models: [],
  });
}

async function mount(settings: SettingsBundle) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["settings"], settings);
  // SettingsPage refreshes on initial auth-state synchronization.
  vi.spyOn(await import("@/lib/api"), "getSettings").mockImplementation(
    async () => queryClient.getQueryData<SettingsBundle>(["settings"])!,
  );
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <SettingsPage appearance="dark" initialSection="models" />
      </QueryClientProvider>,
    );
  });
  return {
    queryClient,
    view,
    close: async () => {
      await act(async () => view.unmount());
      queryClient.clear();
      vi.restoreAllMocks();
    },
  };
}
function click(view: TestRenderer.ReactTestRenderer, text: string) {
  return act(async () => {
    view.root
      .findAllByType("button")
      .find((button) =>
        Array.isArray(button.props.children)
          ? button.props.children.join("") === text
          : button.props.children === text,
      )!
      .props.onClick();
  });
}
function typeSelect(view: TestRenderer.ReactTestRenderer) {
  return view.root
    .findAllByType("select")
    .find((select) =>
      select
        .findAllByType("option")
        .some((option) => option.props.value === "chatgpt"),
    )!;
}

describe("provider dialog singleton protection", () => {
  it("disables occupied account types and rejects their selection in another provider's dialog", async () => {
    const mounted = await mount(bundle(["chatgpt", "grok", "ollama"]));
    try {
      await click(mounted.view, "Add Ollama");
      const select = typeSelect(mounted.view);
      for (const kind of ["chatgpt", "grok"]) {
        expect(
          select
            .findAllByType("option")
            .find((option) => option.props.value === kind)!.props.disabled,
        ).toBe(true);
        await act(async () =>
          select.props.onChange({ target: { value: kind } }),
        );
        expect(typeSelect(mounted.view).props.value).toBe("ollama");
      }
      expect(
        select
          .findAllByType("option")
          .find((option) => option.props.value === "ollama")!.props.disabled,
      ).toBe(false);
    } finally {
      await mounted.close();
    }
  });

  it.each(["chatgpt", "grok"] as const)(
    "keeps editing the existing %s provider available",
    async (kind) => {
      const mounted = await mount(bundle(["chatgpt", "grok"]));
      try {
        await click(mounted.view, `Edit ${kind}`);
        const select = typeSelect(mounted.view);
        expect(select.props.value).toBe(kind);
        expect(
          select
            .findAllByType("option")
            .find((option) => option.props.value === kind)!.props.disabled,
        ).toBe(false);
        expect(
          mounted.view.root.findByProps({ type: "submit" }).props.disabled,
        ).toBe(false);
      } finally {
        await mounted.close();
      }
    },
  );

  it("blocks submitting a duplicate when settings change while the creation dialog is open", async () => {
    vi.mocked(createModelProvider).mockClear();
    vi.mocked(updateModelProvider).mockClear();
    const mounted = await mount(bundle([]));
    try {
      await click(mounted.view, "Add ChatGPT");
      expect(
        mounted.view.root.findByProps({ type: "submit" }).props.disabled,
      ).toBe(false);
      await act(async () => {
        mounted.queryClient.setQueryData(["settings"], bundle(["chatgpt"]));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(
        mounted.view.root.findByProps({ type: "submit" }).props.disabled,
      ).toBe(true);
      expect(
        mounted.view.root.findByProps({ role: "alert" }).props.children,
      ).toContain("Add sign-ins to that provider instead");
      await act(async () => {
        mounted.view.root
          .findByType("form")
          .props.onSubmit({ preventDefault: vi.fn() });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(createModelProvider).not.toHaveBeenCalled();
      expect(updateModelProvider).not.toHaveBeenCalled();
    } finally {
      await mounted.close();
    }
  });
});
