import { z } from "zod";
import {
  workspaceLegacyFileImportSchema,
  workspaceOwnershipSchema,
  type WorkspaceOwnership,
  type WorkspaceTab,
} from "./workspace-ownership.js";
import { WorkspaceCommandError } from "./workspace-command-apply.js";

export type WorkspaceLegacyFileImport = z.infer<
  typeof workspaceLegacyFileImportSchema
>;
export const workspaceLegacyFileImportRequestSchema =
  workspaceLegacyFileImportSchema.extend({
    expectedRevision: z.int().nonnegative(),
  });
export type WorkspaceLegacyFileImportRequest = z.infer<
  typeof workspaceLegacyFileImportRequestSchema
>;
export const workspaceLegacyFileImportReceiptSchema = z
  .object({
    layout: workspaceOwnershipSchema,
    replayed: z.boolean(),
  })
  .strict();
export type WorkspaceLegacyFileImportReceipt = z.infer<
  typeof workspaceLegacyFileImportReceiptSchema
>;

/** Pure import transform. Server must authorize every supplied document and
 * provide its canonical encrypted title. Caller checkpoints drafts first. */
export function importWorkspaceLegacyFiles(
  initial: WorkspaceOwnership,
  input: WorkspaceLegacyFileImport,
  titles: ReadonlyMap<string, WorkspaceTab["titleProtection"]>,
): { layout: WorkspaceOwnership; replayed: boolean } {
  const layout = workspaceOwnershipSchema.parse(initial);
  const request = workspaceLegacyFileImportSchema.parse(input);
  const previous = layout.legacyFileImports?.find(
    ({ windowId }) => windowId === request.windowId,
  );
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(request))
      throw new WorkspaceCommandError(
        "invalid",
        "Legacy window import identity was already used for different views.",
      );
    return { layout, replayed: true };
  }
  if (layout.windows.some(({ id }) => id === request.windowId))
    throw new WorkspaceCommandError(
      "attachment",
      "Legacy window already belongs to this workspace.",
    );
  const documents = new Set<string>();
  for (const view of request.views) {
    if (!titles.has(view.documentId))
      throw new WorkspaceCommandError(
        "missing",
        "An imported document is unavailable in this project.",
      );
    if (documents.has(view.documentId))
      throw new WorkspaceCommandError(
        "invalid",
        "Legacy import repeats a document.",
      );
    documents.add(view.documentId);
  }
  for (const window of layout.windows)
    for (const pane of window.panes)
      for (const tab of pane.tabs)
        if (
          tab.resource.kind === "entity" &&
          tab.resource.definitionId === "project.file" &&
          documents.has(tab.resource.resourceId)
        )
          throw new WorkspaceCommandError(
            "attachment",
            "An imported document already has an owned view; retain both drafts for reconciliation.",
          );
  const tabs: WorkspaceTab[] = request.views.map((view) => ({
    id: view.tabId,
    resource: {
      kind: "entity",
      definitionId: "project.file",
      resourceId: view.documentId,
    },
    preview: false,
    fileMode: view.mode,
    titleProtection: titles.get(view.documentId)!,
    builtInState: null,
    dockPresentation: null,
  }));
  layout.windows.push({
    id: request.windowId,
    attachmentGeneration: 0,
    panes: [
      {
        id: request.paneId,
        region: "center",
        titleProtection: null,
        tabs,
        activeTabId: tabs[0]!.id,
      },
    ],
    centerRoot: { kind: "pane", paneId: request.paneId },
    focusedPaneId: request.paneId,
    recentPaneIds: [request.paneId],
    recentTabIds: [tabs[0]!.id],
  });
  layout.legacyFileImports = [...(layout.legacyFileImports ?? []), request];
  layout.revision++;
  return { layout: workspaceOwnershipSchema.parse(layout), replayed: false };
}
