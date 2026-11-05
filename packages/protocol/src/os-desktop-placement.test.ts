import { expect, it } from "vitest";
import {
  remoteDesktopCreateSchema,
  encryptedRemoteDesktopCreateSchema,
} from "./remote-desktops.js";
import { workerCommandSchema } from "./worker-commands.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const opaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const source = {
  bindingId: uuid(1),
  worktreeId: uuid(2),
  bindingGeneration: uuid(3),
  attachmentGeneration: uuid(4),
  runtimeGeneration: uuid(5),
  desktopGeneration: "a".repeat(64),
};
const execution = {
  kind: "cantrip-os",
  transport: { kind: "docker", container: "disposable-guest" },
  scope: {
    bindingId: source.bindingId,
    worktreeId: source.worktreeId,
    bindingGeneration: source.bindingGeneration,
    attachmentGeneration: source.attachmentGeneration,
    runtimeGeneration: source.runtimeGeneration,
    ownerId: "owner",
    workerId: "worker",
    projectId: "project",
    instanceId: uuid(6),
    guestInstanceId: uuid(7),
    projectSourceId: uuid(8),
    workspaceId: uuid(9),
    guestWorkspaceId: "work",
    uid: 20000,
    gid: 20000,
    homeGuestPath: "/home/work",
    guestPath: "/home/work/source",
    sourceKind: "folder",
    mode: "linux-owned",
    linkedWorkerPath: null,
    dependencyOverlays: [],
  },
};
const attach = {
  type: "surface.attach",
  surfaceId: "surface",
  attachmentId: "viewer",
  projectId: "project",
  serverId: "server",
  configuration: { kind: "desktop", osSource: source },
  osExecution: execution,
  stateResource: "remote-desktop-row",
  stateRevision: 1,
  stateProtection: {
    classification: { recordKind: "remote-desktop-state" },
    protectedState: opaque,
  },
  preferredTransport: "websocket",
  webrtc: null,
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  desktopStream: null,
};

it("admits an explicit Linux source without requiring a Host execution target", () => {
  for (const [schema, base] of [
    [remoteDesktopCreateSchema, {}],
    [
      encryptedRemoteDesktopCreateSchema,
      {
        id: uuid(10),
        titleProtection: {
          classification: { recordKind: "project-view" },
          protectedLabel: opaque,
        },
        stateProtection: attach.stateProtection,
      },
    ],
  ] as const) {
    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({ ...base, cantripOsBindingId: source.bindingId })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        cantripOsRuntimeGeneration: source.runtimeGeneration,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        cantripOsBindingId: source.bindingId,
        cantripOsRuntimeGeneration: source.runtimeGeneration,
      }).success,
    ).toBe(true);
  }
});

it("binds Worker surface admission to the complete saved Linux source", () => {
  expect(workerCommandSchema.safeParse(attach).success).toBe(true);
  expect(
    workerCommandSchema.safeParse({
      ...attach,
      configuration: {
        kind: "desktop",
        osSource: { ...source, desktopGeneration: undefined },
      },
    }).success,
  ).toBe(false);
  expect(
    workerCommandSchema.safeParse({ ...attach, osExecution: undefined })
      .success,
  ).toBe(false);
  expect(
    workerCommandSchema.safeParse({
      ...attach,
      configuration: { kind: "desktop" },
    }).success,
  ).toBe(false);
  for (const field of [
    "projectId",
    "bindingId",
    "worktreeId",
    "bindingGeneration",
    "attachmentGeneration",
    "runtimeGeneration",
  ]) {
    expect(
      workerCommandSchema.safeParse({
        ...attach,
        osExecution: {
          ...execution,
          scope: {
            ...execution.scope,
            [field]: field === "projectId" ? "another-project" : uuid(99),
          },
        },
      }).success,
      field,
    ).toBe(false);
  }
  const host = {
    ...attach,
    configuration: { kind: "desktop" },
    osExecution: undefined,
  };
  expect(workerCommandSchema.safeParse(host).success).toBe(true);
});

it("prepares the actual desktop only for the canonical project execution", () => {
  const command = {
    type: "surface.desktop.os-prepare",
    serverId: "server",
    projectId: "project",
    osExecution: execution,
  };
  expect(workerCommandSchema.safeParse(command).success).toBe(true);
  expect(
    workerCommandSchema.safeParse({ ...command, projectId: "other" }).success,
  ).toBe(false);
  expect(
    workerCommandSchema.safeParse({ ...command, osExecution: undefined })
      .success,
  ).toBe(false);
});
