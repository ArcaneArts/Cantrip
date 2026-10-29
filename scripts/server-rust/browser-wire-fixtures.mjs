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
  const service = {
    workerId: "worker",
    host: "127.0.0.1",
    port: 5173,
    protocol: "http",
    url: "http://127.0.0.1:5173/",
    title: "Development",
    processName: null,
    statusCode: 200,
  };
  const result = {
    workerId: "worker",
    workerName: "Development worker",
    status: "ok",
    services: [
      {
        ...service,
        workerName: "Development worker",
        placement: {
          projectId: "project",
          workerId: "worker",
          projectReplicaId: null,
          worktreeId: null,
          surface: null,
        },
      },
    ],
    error: null,
    truncated: false,
  };
  return {
    browserServiceSchema: [
      service,
      {
        ...service,
        url: " https://localhost/path#\ud800 ",
        title: null,
        processName: " Process ",
      },
    ],
    browserServiceListSchema: [[], [service]],
    browserServiceFleetDiscoverySchema: [
      {
        projectId: "project",
        observedAt: summary.createdAt,
        partial: false,
        workers: [result],
      },
      {
        projectId: "project",
        observedAt: summary.createdAt,
        partial: true,
        truncated: true,
        workers: [
          {
            ...result,
            workerName: "x".repeat(199) + "\ud83d",
            status: "offline",
            services: [],
            error: { code: "worker-offline", message: "Offline" },
          },
        ],
      },
    ],
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
