import { describe, expect, it } from "vitest";

import {
  repositoryOperationAccess,
  repositoryOperationTypeSchema,
  repositoryOperationWireRequestSchema,
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
});
