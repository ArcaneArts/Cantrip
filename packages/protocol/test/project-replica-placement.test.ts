import { describe, expect, it } from "vitest";

import {
  encryptedGithubProjectCreateSchema,
  encryptedProjectReplicaPlacementRequestSchema,
  projectReplicaCapabilitiesSchema,
  projectReplicaPlacementRequestSchema,
  projectReplicaPlacementResultSchema,
  projectReplicaProvisionCreateSchema,
} from "../src/index.js";

const routingHandle = `ctrr_${"p".repeat(43)}`;

describe("project replica placement contracts", () => {
  it("keeps managed placement backward compatible and capabilities disabled", () => {
    expect(
      projectReplicaProvisionCreateSchema.parse({
        workerId: "worker-one",
        expectedRevision: null,
        idempotencyKey: "replica:worker-one",
      }).placement,
    ).toBeUndefined();
    expect(
      projectReplicaCapabilitiesSchema.parse({
        provision: true,
        synchronize: true,
        remove: true,
        exactRevision: true,
      }),
    ).toMatchObject({
      directPlacement: false,
      managedLinkPlacement: false,
      attachExisting: false,
      recursiveParentCreation: false,
    });
  });

  it("requires exact mode-specific paths and protected wire handles", () => {
    expect(
      projectReplicaPlacementRequestSchema.parse({
        mode: "direct",
        path: "  /srv/repos/Cantrip  ",
      }),
    ).toEqual({ mode: "direct", path: "/srv/repos/Cantrip" });
    expect(
      projectReplicaPlacementRequestSchema.safeParse({
        mode: "managed",
        path: "/unexpected",
      }).success,
    ).toBe(false);
    expect(
      encryptedProjectReplicaPlacementRequestSchema.safeParse({
        mode: "managed-link",
        path: "/srv/repos/Cantrip",
      }).success,
    ).toBe(false);
    expect(
      encryptedProjectReplicaPlacementRequestSchema.parse({
        mode: "managed-link",
        path: routingHandle,
      }),
    ).toEqual({ mode: "managed-link", path: routingHandle });
  });

  it("keeps placement results explicit and raw custom paths off create wires", () => {
    expect(
      projectReplicaPlacementResultSchema.parse({
        mode: "direct",
        materialization: "attached",
        ownership: "user",
        canonicalPath: "/srv/repos/Cantrip",
        requestedPath: "/srv/repos/Cantrip",
        linkPath: null,
      }),
    ).toMatchObject({ materialization: "attached", ownership: "user" });
    expect(
      encryptedGithubProjectCreateSchema.safeParse({
        id: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
        nameProtection: {
          classification: { recordKind: "project" },
          protectedLabel: {
            formatVersion: 1,
            keyRevision: 1,
            envelope: {
              version: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: "A".repeat(16),
              ciphertext: "A".repeat(22),
            },
          },
        },
        workerId: "worker-one",
        repositoryBlindIndex: "A".repeat(43),
        repositoryId: routingHandle,
        nameWithOwner: routingHandle,
        url: routingHandle,
        placement: { mode: "direct", path: "/srv/repos/Cantrip" },
      }).success,
    ).toBe(false);
  });
});
