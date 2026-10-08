// @vitest-environment jsdom
import type { ProjectWorktreeSummary, WorkerSummary } from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  deleteRunConfiguration,
  operateRunConfigurationRuntime,
  type RunConfigurationListInventory,
} from "@/lib/run-configuration-api";
import { RunConfigurationControl } from "./run-configuration-control";

vi.mock("@/lib/run-configuration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/run-configuration-api")>()),
  operateRunConfigurationRuntime: vi.fn(
    () => new Promise<never>(() => undefined),
  ),
  deleteRunConfiguration: vi.fn(async () => ({ outcome: "deleted" })),
}));

const configurationId = "00000000-0000-4000-8000-000000000001";
const worktree = {
  id: "primary",
  projectSourceId: "source",
  projectId: "project",
  rootKind: "git-worktree",
  workerId: "worker",
  name: "Primary",
  path: "/project",
  displayPath: "/project",
  isPrimary: true,
  isDefault: true,
  origin: "cantrip",
  lifecycleState: "ready",
  branch: "main",
  head: "abc",
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies ProjectWorktreeSummary;
const inventory = {
  directory: ".cantrip/run-configurations",
  diagnostics: [],
  entries: [
    {
      relativePath: `.cantrip/run-configurations/${configurationId}.json`,
      revision: "a".repeat(64),
      id: configurationId,
      status: "ready",
      diagnostics: [],
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "Development server",
        provider: "shell",
        workingDirectory: ".",
        target: { kind: "command", command: "pnpm dev" },
        commandOverride: null,
        arguments: [],
        environment: {
          includeCodexEnvironment: true,
          files: [],
          variables: [],
          secrets: [],
        },
        beforeLaunch: [],
        platformOverrides: {},
        options: { shell: "automatic", login: true },
        stop: { gracePeriodMs: 3_000 },
      },
    },
  ],
  validations: [
    {
      configurationId,
      provider: "shell",
      platform: "linux",
      effectiveCommand: "pnpm dev",
      valid: true,
      diagnostics: [],
    },
  ],
} satisfies RunConfigurationListInventory;

const worker = { workerId: "worker", online: true } as WorkerSummary;
const secondary = {
  ...worktree,
  id: "secondary",
  isPrimary: false,
  isDefault: false,
  branch: "feature",
  name: "Feature",
  path: "/secondary",
  displayPath: "/secondary",
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let onEdit = vi.fn<(configurationId: string | null) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  onEdit = vi.fn<(configurationId: string | null) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function renderControl(active: boolean) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <RunConfigurationControl
            editorConfigurationId={null}
            renderEditor={false}
            inventory={inventory}
            loading={false}
            projectId="project"
            workers={[worker]}
            worktrees={[worktree, secondary]}
            runtimes={
              active
                ? [
                    {
                      id: "runtime",
                      configurationId,
                      worktreeId: worktree.id,
                      state: "running",
                      generation: 7,
                    } as RunConfigurationRuntime,
                  ]
                : []
            }
            onEditorConfigurationChange={onEdit}
            onFocusTerminal={vi.fn()}
          />
        </QueryClientProvider>
      </TooltipProvider>,
    ),
  );
}
function byRole(role: string, text: string) {
  const element = [
    ...document.querySelectorAll<HTMLElement>(`[role="${role}"]`),
  ].find((node) => node.textContent?.trim() === text);
  expect(element, `${role}: ${text}`).toBeTruthy();
  return element!;
}
function button(text: string) {
  const element = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (node) =>
      node.textContent?.trim() === text ||
      node.getAttribute("aria-label") === text,
  );
  expect(element, `button: ${text}`).toBeTruthy();
  return element!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function key(element: HTMLElement, value: string) {
  await act(async () => {
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}
async function openOptions(input: "pointer" | "keyboard") {
  await click(button("Development server"));
  const trigger = button("More options for Development server");
  if (input === "keyboard") await key(trigger, "Enter");
  else
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", {
          button: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  expect(document.querySelector('[role="menu"]')).toBeTruthy();
  expect(operateRunConfigurationRuntime).not.toHaveBeenCalled();
}
async function choose(text: string, input: "pointer" | "keyboard") {
  const item = byRole("menuitem", text);
  if (input === "keyboard") await key(item, "Enter");
  else await click(item);
}

describe("Run configuration portal interactions", () => {
  for (const active of [false, true])
    for (const input of ["pointer", "keyboard"] as const) {
      it(`${input} Edit does not ${active ? "restart" : "start"} Primary`, async () => {
        await renderControl(active);
        await openOptions(input);
        await choose("Edit", input);
        expect(onEdit).toHaveBeenCalledExactlyOnceWith(configurationId);
        expect(operateRunConfigurationRuntime).not.toHaveBeenCalled();
      });
      it(`${input} Delete then Cancel leaves ${active ? "running" : "stopped"} Primary unchanged`, async () => {
        await renderControl(active);
        await openOptions(input);
        await choose("Delete", input);
        expect(
          document.querySelector('[role="dialog"]')?.textContent,
        ).toContain("Delete Run configuration?");
        expect(operateRunConfigurationRuntime).not.toHaveBeenCalled();
        await click(button("Cancel"));
        expect(deleteRunConfiguration).not.toHaveBeenCalled();
        expect(operateRunConfigurationRuntime).not.toHaveBeenCalled();
      });
      it(`${input} Worktree review does not launch Primary and choosing a target launches only that target`, async () => {
        await renderControl(active);
        await openOptions(input);
        await choose("Run in Worktree…", input);
        expect(operateRunConfigurationRuntime).not.toHaveBeenCalled();
        const target = [
          ...document.querySelectorAll<HTMLElement>('[role="option"]'),
        ].find((node) => node.textContent?.includes("feature"));
        expect(target).toBeTruthy();
        await click(target!);
        expect(operateRunConfigurationRuntime).toHaveBeenCalledExactlyOnceWith({
          configurationId,
          operation: "start",
          projectId: "project",
          targetWorktreeId: "secondary",
        });
      });
    }
  it("confirmed Delete removes the definition without starting a generation", async () => {
    await renderControl(true);
    await openOptions("pointer");
    await choose("Delete", "pointer");
    await click(button("Stop instances and delete"));
    expect(deleteRunConfiguration).toHaveBeenCalledExactlyOnceWith(
      "project",
      configurationId,
      "a".repeat(64),
    );
    expect(operateRunConfigurationRuntime).not.toHaveBeenCalled();
  });
  for (const active of [false, true]) {
    it(`explicit row selection performs exactly one ${active ? "restart" : "start"}`, async () => {
      await renderControl(active);
      await click(button("Development server"));
      const row = document.querySelector<HTMLElement>('[role="option"]');
      await click(row!);
      expect(operateRunConfigurationRuntime).toHaveBeenCalledExactlyOnceWith({
        configurationId,
        operation: active ? "restart" : "start",
        projectId: "project",
        targetWorktreeId: null,
      });
    });
    it(`explicit lifecycle button performs exactly one ${active ? "restart" : "start"}`, async () => {
      await renderControl(active);
      await click(button("Development server"));
      const row = document.querySelector<HTMLElement>('[role="option"]');
      await click(
        row!.querySelector<HTMLButtonElement>(
          `button[aria-label="${active ? "Restart" : "Run"}"]`,
        )!,
      );
      expect(operateRunConfigurationRuntime).toHaveBeenCalledExactlyOnceWith({
        configurationId,
        operation: active ? "restart" : "start",
        projectId: "project",
        targetWorktreeId: null,
      });
    });
  }
});
