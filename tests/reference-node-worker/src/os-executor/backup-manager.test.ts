import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupMessage,
} from "@cantrip/crypto";
import { cantripOsBackupRequestEnvelopeSchema } from "@cantrip/protocol/cantrip-os-backup-operations";
import { CantripOsBackupManager } from "./backup-manager.js";
import { CantripOsController } from "./controller.js";

it("returns actual private failure details only inside an encrypted response", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-backup-error-"));
  const key = randomBytes(32),
    operationId = randomUUID(),
    workspaceId = randomUUID();
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
  };
  const keys = {
    ownerId: () => "owner",
    serverIdentity: () => "server",
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
  };
  const controller = new CantripOsController(directory, "worker");
  const assertion = vi
    .spyOn(controller, "assertAdministrativeScope")
    .mockRejectedValue(new Error("Cannot access /private/project-home"));
  try {
    const protectedRequest = cantripOsBackupRequestEnvelopeSchema.parse(
      await encryptCantripOsBackupMessage({
        ...scope,
        operationId,
        keyRevision: 1,
        componentKey: key,
        direction: "request",
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            action: "capture",
            workspaceId,
            label: "private",
            exclusions: [],
          }),
        ),
      }),
    );
    const result = await new CantripOsBackupManager(
      directory,
      "worker",
      controller,
      keys,
    ).handle({
      type: "cantrip-os.backup.capture",
      operationId,
      scope,
      transport: { kind: "docker", container: "unused" },
      workspace: {
        id: workspaceId,
        guestWorkspaceId: "example",
        uid: 20000,
        gid: 20000,
        homeGuestPath: "/home/example",
      },
      sources: [],
      protectedRequest,
    });
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("/private/project-home");
    const plaintext = await decryptCantripOsBackupMessage({
      ...scope,
      operationId,
      keyRevision: 1,
      componentKey: key,
      direction: "response",
      frame: result.protectedResult!,
    });
    try {
      expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
        action: "error",
        operationAction: "capture",
        message: "Cannot access /private/project-home",
      });
    } finally {
      plaintext.fill(0);
    }
  } finally {
    assertion.mockRestore();
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports a missing saved admission without dispatching or creating another operation", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-backup-observe-"),
  );
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
  };
  let calls = 0;
  const keys = {
    ownerId: () => "owner",
    serverIdentity: () => "server",
    componentKey: () => {
      throw new Error("No key read needed for missing admission");
    },
  };
  const ports = {
    control: async () => {
      calls++;
      throw new Error("Unexpected guest mutation");
    },
    exportArchive: async function* () {
      calls++;
      throw new Error("Unexpected export");
    },
  };
  try {
    const manager = new CantripOsBackupManager(
      directory,
      "worker",
      new CantripOsController(directory, "worker"),
      keys,
      ports,
    );
    expect(
      await manager.handle({
        type: "cantrip-os.backup.observe",
        scope,
        action: "restore",
        operationId: randomUUID(),
        mode: "recover",
      }),
    ).toMatchObject({
      state: "unknown",
      phase: "recovery-required",
      protectedResult: null,
      startedAt: null,
    });
    expect(calls).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects private intent for a different canonical workspace before admitting effects", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-backup-intent-"),
  );
  const key = randomBytes(32),
    operationId = randomUUID();
  const scope = {
    ownerId: "owner",
    serverId: "server",
    workerId: "worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
  };
  const keys = {
    ownerId: () => "owner",
    serverIdentity: () => "server",
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
  };
  try {
    const manager = new CantripOsBackupManager(
      directory,
      "worker",
      new CantripOsController(directory, "worker"),
      keys,
    );
    const protectedRequest = cantripOsBackupRequestEnvelopeSchema.parse(
      await encryptCantripOsBackupMessage({
        ...scope,
        operationId,
        componentKey: key,
        keyRevision: 1,
        direction: "request",
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            action: "capture",
            workspaceId: randomUUID(),
            label: "Private label",
            exclusions: [],
          }),
        ),
      }),
    );
    await expect(
      manager.handle({
        type: "cantrip-os.backup.capture",
        operationId,
        scope,
        transport: { kind: "docker", container: "not-a-test-target" },
        protectedRequest,
        sources: [],
        workspace: {
          id: randomUUID(),
          guestWorkspaceId: "example",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/home/example",
        },
      }),
    ).rejects.toThrow("canonical admission");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
