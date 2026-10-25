// @vitest-environment jsdom
import { settingsBundleSchema, type SettingsBundle } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { SettingsPage } from "./settings-page";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getSettings: vi.fn(),
  getWorkers: vi.fn(async () => []),
  updateSettings: vi.fn(),
}));
vi.mock("./encryption-recovery-settings", () => ({
  EncryptionRecoverySettings: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let settings: SettingsBundle;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  settings = settingsBundleSchema.parse({
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
  });
  vi.mocked(api.getSettings).mockImplementation(async () => settings);
  vi.mocked(api.updateSettings).mockImplementation(async (input) => {
    settings = {
      ...settings,
      preferences: { ...settings.preferences, ...input },
    };
    return settings;
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["settings"], settings);
  client.setQueryData(["workers"], []);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SettingsPage appearance="dark" />
      </QueryClientProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function search(
  value: string,
  input = container.querySelector<HTMLInputElement>('[role="searchbox"]')!,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("inline settings search", () => {
  it("edits Elite Mode directly under Appearance without leaving the search", async () => {
    await search("elite");
    const group = container.querySelector(
      '[data-settings-section="appearance"]',
    )!;
    expect(group).not.toBeNull();
    const inputs = group.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Elite Mode"]',
    );
    expect(inputs).toHaveLength(1);
    expect(group.querySelector('[aria-label="Brightness"]')).toBeNull();
    expect(group.textContent).not.toContain("Tab bar display");
    expect(inputs[0]!.checked).toBe(false);
    await act(async () => inputs[0]!.click());
    expect(api.updateSettings).toHaveBeenCalledOnce();
    expect(vi.mocked(api.updateSettings).mock.calls[0]![0]).toEqual({
      eliteMode: true,
    });
    await vi.waitFor(() => expect(inputs[0]!.checked).toBe(true));
    expect(
      container.querySelector<HTMLInputElement>('[role="searchbox"]')!.value,
    ).toBe("elite");
    expect(
      container.querySelector('[data-settings-section="appearance"]'),
    ).not.toBeNull();
  });

  it("keeps the mobile search field mounted and focused while results change", async () => {
    const input =
      container.querySelectorAll<HTMLInputElement>('[role="searchbox"]')[1]!;
    input.focus();
    await search("elit", input);
    expect(document.activeElement).toBe(input);
    await search("elite", input);
    expect(document.activeElement).toBe(input);
    expect(
      container.querySelectorAll('[aria-label="Elite Mode"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-slot="settings-search-results"]'),
    ).toHaveLength(1);
  });

  it("shows the real workspace profile option for a multi-word search", async () => {
    await search("hybrid panes");
    const group = container.querySelector('[data-settings-section="general"]')!;
    expect(
      group.querySelector('select[aria-label="Project workspace profile"]'),
    ).not.toBeNull();
    expect(group.textContent).not.toContain("Default agent permissions");
  });

  it("opens a matching provider's real options inside Models", async () => {
    settings = settingsBundleSchema.parse({
      ...settings,
      providers: [
        {
          id: "fixture-provider",
          name: "PrivateRoute",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          hasApiKey: false,
          createdAt: "2026-10-23T00:00:00.000Z",
          updatedAt: "2026-10-23T00:00:00.000Z",
        },
      ],
    });
    await act(async () => {
      client.setQueryData(["settings"], settings);
    });
    await search("PrivateRoute");
    const group = container.querySelector('[data-settings-section="models"]')!;
    expect(
      group.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
    ).toContain("PrivateRoute");
    expect(group.querySelector('[data-slot="models-settings"]')).not.toBeNull();
  });

  it("finds the current prompt control and restores the active section after clearing", async () => {
    await search("current prompt");
    expect(
      container.querySelector(
        '[data-settings-section="general"] [aria-label="Show current prompt header"]',
      ),
    ).not.toBeNull();
    await search("");
    expect(
      container.querySelector('[data-slot="settings-search-results"]'),
    ).toBeNull();
    expect(
      container.querySelector('select[aria-label="Project workspace profile"]'),
    ).not.toBeNull();
  });

  it("shows an empty result without mounting unrelated controls", async () => {
    await search("no-such-option-zzzz");
    expect(container.textContent).toContain("No settings match");
    expect(
      container.querySelectorAll('[data-slot="settings-search-section"]'),
    ).toHaveLength(0);
    expect(container.querySelector('[aria-label="Elite Mode"]')).toBeNull();
  });
});
