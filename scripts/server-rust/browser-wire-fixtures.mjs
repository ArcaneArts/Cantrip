import { surfacePrivateStateOpaqueSchema } from "../../packages/protocol/dist/surface-private-state.js";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
export function browserWireFixtures(label) {
  const titleProtection = {
      ...label,
      classification: { recordKind: "browser" },
    },
    stateProtection = surfacePrivateStateOpaqueSchema.parse({
      classification: { recordKind: "browser-state" },
      protectedState: label.protectedLabel,
    });
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    input = { id, titleProtection, stateProtection };
  const summary = {
    ...input,
    projectId: "project",
    position: 0,
    stateRevision: 1,
    workerId: "worker",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
  return {
    encryptedBrowserCreateSchema: [
      input,
      ...["center", "right", "bottom"].map((targetRegion) => ({
        ...input,
        targetRegion,
      })),
      { ...input, paneId: "pane" },
      { ...input, tabGroupId: "legacy" },
      { ...input, target: { kind: "project", projectId: "project" } },
    ],
    encryptedBrowserUpdateSchema: [
      { titleProtection },
      { expectedStateRevision: 1, stateProtection },
      { titleProtection, expectedStateRevision: 2, stateProtection },
    ],
    browserWireSummarySchema: [summary, { ...summary, workerId: null }],
    browserWireListSchema: [[], [summary]],
    browserTunnelWireRequestSchema: [
      {
        tunnelId: id,
        protocolHint: "http-websocket",
        workerId: "worker",
        protectedRecord: { ...tunnelRecord, operationId: id },
      },
      {
        tunnelId: id,
        protocolHint: "https-websocket",
        workerId: "\ud800",
        resetAttachments: true,
        protectedRecord: { ...tunnelRecord, operationId: id },
      },
    ],
  };
}
