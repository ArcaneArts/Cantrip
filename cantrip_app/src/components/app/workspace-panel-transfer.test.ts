import {
  PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS,
  PROJECT_SURFACE_DEFINITIONS,
} from "@cantrip/protocol";
import { expect, it } from "vitest";
import {
  isWorkspacePanelResource,
  workspacePanelTransfer,
} from "./workspace-panel-transfer";
import {
  prepareWorkspaceViewTransferBatch,
  stageWorkspaceViewTransferBatch,
} from "./workspace-view-transfer-batch";

it.each(PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS)(
  "round-trips built-in panel %s with its saved worktree",
  async (definitionId) => {
    const panel = workspacePanelTransfer(
      {
        id: "panel-view",
        resource: { kind: "builtin", definitionId },
        builtInState: { definitionId, worktreeId: "selected-tree" },
      },
      "project",
    );
    expect(isWorkspacePanelResource(panel.resource)).toBe(true);
    const batch = prepareWorkspaceViewTransferBatch(
      [],
      [],
      [],
      [],
      [],
      [panel],
    );
    const bytes = await batch.captureBytes();
    expect(
      stageWorkspaceViewTransferBatch(bytes, [], [], [], [], [], [panel])
        .panels,
    ).toEqual([panel]);
    await batch.retire();
    batch.resume();
  },
);

it("accounts for every registered panel, with live runtime types retaining their existing adapters", () => {
  const live = new Set([
    "project.agent",
    "project.file",
    "project.explorer",
    "project.code",
    "project.terminal",
    "project.browser",
    "project.remote-desktop",
  ]);
  for (const definition of PROJECT_SURFACE_DEFINITIONS) {
    if (live.has(definition.id)) continue;
    expect(
      isWorkspacePanelResource(
        definition.cardinality === "singleton"
          ? { kind: "builtin", definitionId: definition.id as never }
          : {
              kind: "entity",
              definitionId: definition.id,
              resourceId: "entity",
            },
      ),
      definition.id,
    ).toBe(true);
  }
});

it("rejects missing, additional, duplicate, or mismatched panel payloads", async () => {
  const panel = workspacePanelTransfer(
    {
      id: "tasks",
      resource: { kind: "builtin", definitionId: "project.tasks" },
      builtInState: { definitionId: "project.tasks", worktreeId: null },
    },
    "project",
  );
  const payload = (panels: unknown[]) =>
    new TextEncoder().encode(
      JSON.stringify({ version: 1, editors: [], panels }),
    );
  const stage = (panels: unknown[]) =>
    stageWorkspaceViewTransferBatch(
      payload(panels),
      [],
      [],
      [],
      [],
      [],
      [panel],
    );
  expect(() => stage([])).toThrow("Invalid panel transfer batch");
  expect(() => stage([panel, panel])).toThrow("Invalid panel transfer batch");
  for (const patch of [
    { projectId: "other" },
    { tabId: "other" },
    { resource: { kind: "builtin", definitionId: "git.history" } },
    { builtInState: { definitionId: "project.tasks", worktreeId: "other" } },
  ]) {
    expect(() => stage([{ ...panel, ...patch }])).toThrow();
  }
  expect(() =>
    stageWorkspaceViewTransferBatch(payload([panel]), [], []),
  ).toThrow("Invalid panel transfer batch");
  expect(() =>
    prepareWorkspaceViewTransferBatch([], [], [], [], [], [panel, panel]),
  ).toThrow("Duplicate transfer tab identity");
});
