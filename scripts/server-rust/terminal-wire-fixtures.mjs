import { surfacePrivateStateOpaqueSchema } from "../../packages/protocol/dist/surface-private-state.js";
import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
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
    terminalClientMessageSchema: [
      { type: "resize", cols: 1, rows: 1000 },
      { type: "resize", cols: 80, rows: 24, extra: true },
      {
        type: "input",
        operationId: "fixture",
        sequence: 0,
        protectedData: workerIngressFixtures.find(
          (v) => v.event?.type === "terminal.output",
        ).event.protectedData,
      },
    ],
    terminalServerMessageSchema: [
      { type: "ready" },
      { type: "error", message: "\ud800 error" },
      { type: "exit", exitCode: 2, signal: null },
      {
        type: "output",
        operationId: "fixture",
        sequence: 0,
        protectedData: workerIngressFixtures.find(
          (v) => v.event?.type === "terminal.output",
        ).event.protectedData,
      },
      {
        type: "output",
        operationId: "fixture",
        sequence: 0,
        protectedData: workerIngressFixtures.find(
          (v) => v.event?.type === "terminal.output",
        ).event.protectedData,
        hydration: {
          format: "legacy-raw",
          version: 1,
          generation: 0,
          truncated: false,
          snapshotCharacters: 0,
          snapshotChunks: 1,
          cols: 80,
          rows: 24,
        },
      },
    ],
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
    worktreeSelectionSchema: [
      { worktreeId: "worktree" },
      { worktreeId: "\ud800" },
      { worktreeId: "worktree", extra: true },
    ],
  };
}
