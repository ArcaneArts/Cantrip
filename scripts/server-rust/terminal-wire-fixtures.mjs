import { surfacePrivateStateOpaqueSchema } from "../../packages/protocol/dist/surface-private-state.js";
export function terminalWireFixtures(label) {
  const titleProtection = {
    ...label,
    classification: { recordKind: "terminal" },
  };
  const stateProtection = surfacePrivateStateOpaqueSchema.parse({
    classification: { recordKind: "terminal-state" },
    protectedState: label.protectedLabel,
  });
  const input = {
    id: "55555555-5555-4555-8555-555555555555",
    titleProtection,
    stateProtection,
  };
  const terminal = {
    ...input,
    projectId: "project",
    kind: "interactive",
    position: 0,
    status: "idle",
    activeWorkerId: "worker",
    worktreeId: "worktree",
    linkedChatId: null,
    runConfigurationId: null,
    runConfigurationRuntimeId: null,
    serviceEnabled: false,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
  const variants = [
    terminal,
    { ...terminal, kind: "chat-console", linkedChatId: "chat" },
    {
      ...terminal,
      kind: "run-configuration",
      runConfigurationId: "66666666-6666-4666-8666-666666666666",
      runConfigurationRuntimeId: "77777777-7777-4777-8777-777777777777",
      titleProtection: null,
      stateProtection: null,
    },
  ];
  return {
    encryptedTerminalCreateSchema: [
      input,
      ...["center", "bottom", "right", "left"].map((targetRegion) => ({
        ...input,
        targetRegion,
      })),
      { ...input, paneId: "pane" },
      { ...input, tabGroupId: "legacy-pane" },
      { ...input, worktreeId: "worktree" },
      { ...input, target: { kind: "project", projectId: "project" } },
    ],
    encryptedTerminalUpdateSchema: [{ titleProtection }],
    encryptedTerminalServiceConfigurationSchema: [
      { enabled: true, stateProtection },
      { enabled: false, stateProtection },
    ],
    terminalWireSummarySchema: variants,
    terminalWireListSchema: [[], variants],
  };
}
