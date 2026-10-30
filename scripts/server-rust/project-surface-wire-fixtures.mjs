import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
export function projectSurfaceWireFixtures(baseLabel) {
  const label = (recordKind) => ({
    ...baseLabel,
    classification: { recordKind },
  });
  const state = (recordKind) => ({
    classification: { recordKind },
    protectedState: baseLabel.protectedLabel,
  });
  const stamp = "2026-10-25T00:00:00.123Z";
  const id = "11111111-1111-4111-8111-111111111111";
  const base = {
    id,
    projectId: "project",
    position: 0,
    worktreeId: "tree",
    createdAt: stamp,
    updatedAt: stamp,
  };
  const explorer = {
    ...base,
    activeWorkerId: "worker",
    fileMode: "preview",
    titleProtection: label("explorer"),
    stateProtection: state("explorer-state"),
  };
  const code = {
    ...base,
    activeWorkerId: "worker",
    titleProtection: label("code-tab"),
  };
  const view = {
    ...base,
    kind: "history",
    titleProtection: label("project-view"),
  };
  const create = {
    id,
    titleProtection: explorer.titleProtection,
    stateProtection: explorer.stateProtection,
  };
  return {
    encryptedExplorerCreateSchema: [
      create,
      { ...create, attachToTabLayout: false, fileMode: "edit" },
      {
        ...create,
        target: { kind: "worktree", projectId: "project", worktreeId: "tree" },
      },
    ],
    encryptedExplorerUpdateSchema: [
      { titleProtection: explorer.titleProtection },
    ],
    encryptedExplorerPinSchema: [
      {
        titleProtection: explorer.titleProtection,
        stateProtection: explorer.stateProtection,
        fileMode: "edit",
      },
    ],
    encryptedExplorerViewStateUpdateSchema: [
      { stateProtection: explorer.stateProtection, fileMode: "visual" },
    ],
    encryptedExplorerWorktreeUpdateSchema: [
      { stateProtection: explorer.stateProtection, worktreeId: "tree" },
    ],
    explorerWireSummarySchema: [explorer],
    explorerWireListSchema: [[], [explorer]],
    explorerOperationWireRequestSchema:
      fileDocumentWireFixtures().surfaceStreamWireRequestSchema.map((v) => ({
        ...v,
        binding: { workerId: "worker", projectId: id, worktreeId: id },
      })),
    encryptedCodeTabCreateSchema: [
      { id, titleProtection: code.titleProtection },
    ],
    encryptedCodeTabUpdateSchema: [{ titleProtection: code.titleProtection }],
    codeTabWireSummarySchema: [code],
    codeTabWireListSchema: [[], [code]],
    encryptedProjectViewCreateSchema: [
      { id, kind: "history", titleProtection: view.titleProtection },
    ],
    encryptedProjectViewUpdateSchema: [
      { titleProtection: view.titleProtection },
    ],
    projectViewWireSummarySchema: [
      view,
      { ...view, kind: "remote-desktop", worktreeId: null },
    ],
    projectViewWireListSchema: [[], [view]],
  };
}
