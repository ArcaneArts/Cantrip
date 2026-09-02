import { describe, expect, it } from "vitest";

import {
  repositoryMetadataValuesSchema,
  repositoryOperationAccess,
  repositoryOperationOutcomeContentSchema,
  repositoryOperationTypeSchema,
  repositoryOperationWireRequestSchema,
  workspaceRootAttachmentErrorCodeSchema,
} from "../src/repository-operation.js";

describe("repository operation access", () => {
  it("classifies every protected operation for server coordination", () => {
    expect(
      repositoryOperationTypeSchema.options.map((type) => [
        type,
        repositoryOperationAccess(type),
      ]),
    ).toHaveLength(repositoryOperationTypeSchema.options.length);
    expect(repositoryOperationAccess("worktree.status")).toBe("read");
    expect(repositoryOperationAccess("git.history")).toBe("read");
    expect(repositoryOperationAccess("git.action")).toBe("write");
    expect(repositoryOperationAccess("git.patch.apply")).toBe("write");
  });

  it("defaults unknown legacy clients to serialized write coordination", () => {
    const request = repositoryOperationWireRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      protectedRequest: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    });

    expect(request.access).toBe("write");
  });

  it("allows only the declared private project placement path fields", () => {
    expect(
      repositoryMetadataValuesSchema.parse({
        canonicalPath: "/srv/repos/Cantrip",
        linkPath: "/workspace/Cantrip",
        placementPath: "/workspace/Cantrip",
        requestedPath: "/workspace/Cantrip",
      }),
    ).toMatchObject({ placementPath: "/workspace/Cantrip" });
    expect(
      repositoryMetadataValuesSchema.safeParse({
        arbitraryPlacementAlias: "/workspace/Cantrip",
      }).success,
    ).toBe(false);
  });

  it("carries bounded attached-root failure codes inside protected outcomes", () => {
    expect(workspaceRootAttachmentErrorCodeSchema.options).toEqual([
      "invalid-root",
      "root-unavailable",
    ]);
    expect(
      repositoryOperationOutcomeContentSchema.parse({
        ok: false,
        error: "Workspace root is unavailable.",
        code: "root-unavailable",
      }),
    ).toEqual({
      ok: false,
      error: "Workspace root is unavailable.",
      code: "root-unavailable",
    });
    expect(
      repositoryOperationOutcomeContentSchema.safeParse({
        ok: false,
        error: "Workspace root is unavailable.",
        code: "Root path: /private/example",
      }).success,
    ).toBe(false);
  });
});
