// Expected results execute the current protocol, independently of native graphs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorCases, outcome } from "./security-oracle.mjs";
import {
  remoteSurfaceHttpContractRoots,
  sourceContractSchema,
} from "./contracts.mjs";
import { label, state, stamp } from "./project-target-state.mjs";

export const desktopId = "914edb2a-4e0e-47df-9701-e81b055e784a";
export const surfaceId = "d807156d-c53e-47d1-87fd-d07572802a12";
export const desktopGeneration = "a".repeat(64);
export const osSource = {
  bindingId: desktopId,
  worktreeId: "worktree",
  bindingGeneration: desktopId,
  attachmentGeneration: surfaceId,
  runtimeGeneration: desktopId,
  desktopGeneration,
};
export const surfaceCreate = {
  id: surfaceId,
  workerId: "alpha",
  titleProtection: label("remote-surface"),
  configuration: { kind: "browser" },
  stateProtection: state("browser-state"),
};
export const desktopCreate = {
  id: desktopId,
  titleProtection: label("project-view"),
  stateProtection: state("remote-desktop-state"),
};
export const desktopWire = {
  ...desktopCreate,
  projectId: "github",
  position: 0,
  workerId: "alpha",
  stateRevision: 1,
  status: "idle",
  lastError: null,
  createdAt: stamp,
  updatedAt: stamp,
};
export const surfaceWire = {
  ...surfaceCreate,
  projectId: "github",
  kind: "browser",
  configuration: { kind: "browser", profileId: null },
  stateRevision: 1,
  status: "idle",
  preferredTransport: "webrtc",
  lastError: null,
  lastConnectedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
};
export const inventory = {
  operationId: surfaceId,
  stateProtection: state("remote-desktop-inventory"),
  monitorCount: 1,
  windowCount: 2,
  truncated: false,
};
const fleetWorker = {
  workerId: "alpha",
  workerName: "Worker",
  platform: "linux",
  architecture: "x64",
  status: "ok",
  inventoryOperationId: surfaceId,
  inventoryProtection: inventory.stateProtection,
  monitorCount: 1,
  windowCount: 2,
  desktops: [desktopWire],
  error: null,
  truncated: false,
};
const fleet = {
  projectId: "github",
  observedAt: stamp,
  partial: false,
  truncated: false,
  workers: [fleetWorker],
};
const samples = {
  encryptedRemoteSurfaceCreateSchema: [
    surfaceCreate,
    {
      ...surfaceCreate,
      configuration: { kind: "desktop" },
      stateProtection: state("remote-desktop-state"),
    },
  ],
  encryptedRemoteSurfaceUpdateSchema: [
    { expectedStateRevision: 1, stateProtection: state("browser-state") },
    { titleProtection: label("remote-surface") },
    { preferredTransport: "websocket" },
    { configuration: { kind: "desktop", osSource } },
  ],
  remoteSurfaceWireSummarySchema: [
    surfaceWire,
    { ...surfaceWire, titleProtection: label("browser") },
    {
      ...surfaceWire,
      kind: "desktop",
      configuration: { kind: "desktop" },
      stateProtection: state("remote-desktop-state"),
      titleProtection: label("project-view"),
    },
  ],
  remoteSurfaceWireListSchema: [[surfaceWire], []],
  encryptedRemoteDesktopCreateSchema: [
    desktopCreate,
    {
      ...desktopCreate,
      cantripOsBindingId: desktopId,
      cantripOsRuntimeGeneration: surfaceId,
    },
    {
      ...desktopCreate,
      target: { kind: "worker", projectId: "github", workerId: "alpha" },
    },
  ],
  encryptedRemoteDesktopUpdateSchema: [
    {
      expectedStateRevision: 1,
      stateProtection: state("remote-desktop-state"),
    },
  ],
  remoteDesktopWireSummarySchema: [desktopWire, { ...desktopWire, osSource }],
  remoteDesktopWireListSchema: [[desktopWire], []],
  remoteDesktopFleetWireSchema: [
    fleet,
    { ...fleet, workers: [] },
    {
      ...fleet,
      partial: true,
      workers: [
        {
          ...fleetWorker,
          status: "offline",
          inventoryOperationId: null,
          inventoryProtection: null,
          error: { code: "worker-offline", message: "Offline" },
        },
      ],
    },
  ],
  remoteDesktopProtectedInventorySchema: [inventory],
  remoteDesktopProbeResultSchema: [
    { available: true, message: null },
    { available: false, message: "" },
  ],
  remoteDesktopOsSourceSchema: [
    osSource,
    { ...osSource, desktopGeneration: undefined },
  ],
  remoteDesktopPreparedGenerationSchema: [{ desktopGeneration }],
  remoteSurfaceViewportSchema: [
    { width: 1280, height: 720, devicePixelRatio: 1 },
    { width: 16384, height: 1, devicePixelRatio: 8 },
  ],
  remoteSurfaceWebRtcConfigurationSchema: [
    { iceServers: [], iceTransportPolicy: "relay", negotiationTimeoutMs: 1000 },
    {
      iceServers: [
        { urls: ["turn:localhost"], username: "owner", credential: "key" },
      ],
      iceTransportPolicy: "all",
      negotiationTimeoutMs: 30000,
    },
  ],
  remoteSurfaceConnectionMessageSchema: [
    {
      type: "ready",
      surfaceId,
      attachmentId: desktopId,
      transport: "websocket",
    },
    { type: "error", message: "Offline", recoverable: true },
  ],
};
const extra = {
  encryptedRemoteSurfaceCreateSchema: [
    {
      ...surfaceCreate,
      titleProtection: label("browser"),
      stateProtection: state("remote-desktop-state"),
    },
  ],
  encryptedRemoteSurfaceUpdateSchema: [
    {},
    { expectedStateRevision: 1 },
    { stateProtection: state("browser-state") },
    { titleProtection: label("project-view") },
  ],
  remoteSurfaceWireSummarySchema: [
    {
      ...surfaceWire,
      titleProtection: label("project-view"),
      stateRevision: null,
      stateProtection: null,
    },
  ],
  encryptedRemoteDesktopCreateSchema: [
    { ...desktopCreate, cantripOsBindingId: desktopId },
    { ...desktopCreate, cantripOsRuntimeGeneration: surfaceId },
    {
      ...desktopCreate,
      cantripOsBindingId: desktopId,
      cantripOsRuntimeGeneration: surfaceId,
      target: { kind: "project", projectId: "github" },
    },
    {
      ...desktopCreate,
      paneId: "pane",
      tabGroupId: "group",
      titleProtection: label("browser"),
    },
  ],
  remoteDesktopFleetWireSchema: [
    { ...fleet, workers: [{ ...fleetWorker, inventoryProtection: null }] },
    { ...fleet, workers: [{ ...fleetWorker, status: "offline" }] },
  ],
  remoteDesktopProtectedInventorySchema: [
    { ...inventory, stateProtection: state("remote-desktop-state") },
  ],
  remoteDesktopPreparedGenerationSchema: [
    {},
    { desktopGeneration: null },
    { desktopGeneration: "A".repeat(64) },
    { desktopGeneration, extra: true },
  ],
};
const name =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    ? process.argv[2]
    : undefined;
if (name) {
  if (!remoteSurfaceHttpContractRoots.includes(name))
    throw new Error("Unknown surface contract: " + name);
  for (const sample of samples[name]) {
    const result = sourceContractSchema(name).safeParse(
      JSON.parse(JSON.stringify(sample)),
    );
    if (!result.success)
      throw new Error(
        "Invalid positive fixture " + name + ": " + result.error.message,
      );
  }
  console.log(
    JSON.stringify({
      cases: [
        ...vectorCases(name, samples[name]),
        ...(extra[name] ?? []).map((input) => ({
          input,
          outcome: outcome(sourceContractSchema(name), input),
        })),
      ],
    }),
  );
}
