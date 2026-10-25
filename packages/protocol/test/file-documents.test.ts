import { describe, expect, it } from "vitest";
import { fileDocumentCreateSchema } from "../src/file-documents.js";
import { fileDocumentPrivateStateProtectedContentSchema } from "../src/surface-private-state.js";

const input = {
  id: "71747e71-fb0a-463c-b00a-c16db1f2f314",
  worktreeId: "worktree",
  stateProtection: {
    classification: { recordKind: "file-document-state" },
    protectedState: {
      formatVersion: 1,
      keyRevision: 2,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 2,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  },
};
describe("file document contracts", () => {
  it("accepts opaque location without placement or view state", () => {
    expect(fileDocumentCreateSchema.parse(input)).toEqual(input);
  });
  it.each(["path", "fileMode", "paneId", "selectedPath"])(
    "rejects leaked or view-only field %s",
    (key) => {
      expect(
        fileDocumentCreateSchema.safeParse({ ...input, [key]: "private" })
          .success,
      ).toBe(false);
    },
  );
  it("rejects an Explorer envelope", () => {
    expect(
      fileDocumentCreateSchema.safeParse({
        ...input,
        stateProtection: {
          ...input.stateProtection,
          classification: { recordKind: "explorer-state" },
        },
      }).success,
    ).toBe(false);
  });
  it("requires a nonempty protected path and complete checkout binding", () => {
    const content = {
      version: 1,
      classification: { recordKind: "file-document-state" },
      projectId: "project",
      workerId: "worker",
      worktreeId: "worktree",
      path: "src/main.rs",
    };
    expect(
      fileDocumentPrivateStateProtectedContentSchema.parse(content),
    ).toEqual(content);
    for (const path of ["", "bad\0path", "x".repeat(8193)])
      expect(
        fileDocumentPrivateStateProtectedContentSchema.safeParse({
          ...content,
          path,
        }).success,
      ).toBe(false);
    for (const key of ["projectId", "workerId", "worktreeId"])
      expect(
        fileDocumentPrivateStateProtectedContentSchema.safeParse({
          ...content,
          [key]: "",
        }).success,
      ).toBe(false);
  });
});
