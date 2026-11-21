import { randomBytes, randomUUID } from "node:crypto";
import type { CantripOsSystemManifest } from "@cantrip/protocol/cantrip-os-system";
import type { BackupKeyAccess } from "./private-backup-file.js";

/** Shared test fixture only; no credentials or synthetic admissions in production. */
export function privateSystemFixture() {
  const context = {
    ownerId: "fixture-owner",
    serverId: "fixture-server",
    workerId: "fixture-worker",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    targetGeneration: randomUUID(),
    operationId: randomUUID(),
    checkpointId: randomUUID(),
    containerId: "a".repeat(64),
  };
  const revisions = new Map([
    [1, randomBytes(32)],
    [2, randomBytes(32)],
  ]);
  let current = 1,
    owner = context.ownerId,
    locked = false;
  const keys: BackupKeyAccess = {
    ownerId: () => owner,
    serverIdentity: () => context.serverId,
    componentKey: (component, revision = current) => {
      if (
        component !== "repository-content" ||
        locked ||
        !revisions.has(revision)
      )
        throw new Error("No active encryption grant.");
      return {
        key: new Uint8Array(revisions.get(revision)!),
        keyRevision: revision,
      };
    },
  };
  const manifest: CantripOsSystemManifest = {
    version: 1,
    snapshot: {
      format: "cantrip-os-private-system-image",
      version: 1,
      imageId: `sha256:${"b".repeat(64)}`,
      requestSha256: "c".repeat(64),
      instanceId: context.instanceId,
      sourceContainerId: context.containerId,
      sourceBaseImageId: `sha256:${"d".repeat(64)}`,
      architecture: "amd64",
      os: "linux",
      createdAt: new Date().toISOString(),
      size: 3000,
      evidence: "acknowledged-and-verified",
      consistency: "stopped-container-filesystem",
      containsPrivateIdentity: true,
      identityPolicy: "same-instance-only",
      runtimeHandlesRestored: false,
      mounts: [
        {
          type: "bind",
          source: "/private/host/雪",
          destination: "/project",
          readOnly: false,
          included: false,
        },
      ],
      regeneratedPaths: ["/etc/hostname"],
    },
  };
  return {
    context,
    manifest,
    keys,
    revisions,
    rotate: () => {
      current = 2;
    },
    changeOwner: () => {
      owner = "another-owner";
    },
    lock: () => {
      locked = true;
    },
  };
}
