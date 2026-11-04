import { expect, it } from "vitest";
import { fileDocumentCreateSchema } from "./file-documents.js";
import { encryptedExplorerCreateSchema } from "./explorer-surfaces.js";
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
const binding = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
it("requires an explicit binding and runtime generation together for file resources", () => {
  for (const [schema, base] of [
    [
      fileDocumentCreateSchema,
      {
        id: binding,
        worktreeId: "tree",
        stateProtection: {
          classification: { recordKind: "file-document-state" },
          protectedState: opaque,
        },
      },
    ],
    [
      encryptedExplorerCreateSchema,
      {
        id: binding,
        worktreeId: "tree",
        titleProtection: {
          classification: { recordKind: "explorer" },
          protectedLabel: opaque,
        },
        stateProtection: {
          classification: { recordKind: "explorer-state" },
          protectedState: opaque,
        },
      },
    ],
  ] as const) {
    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({ ...base, cantripOsBindingId: binding }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, cantripOsRuntimeGeneration: generation })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        cantripOsBindingId: binding,
        cantripOsRuntimeGeneration: generation,
      }).success,
    ).toBe(true);
  }
});
