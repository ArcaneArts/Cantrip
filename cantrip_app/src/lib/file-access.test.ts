import { beforeEach, expect, it, vi } from "vitest";
const operation = vi.hoisted(() => vi.fn());
vi.mock("./api/file-documents", () => ({
  executeFileDocumentOperation: operation,
}));
import { documentFileAccess } from "./file-access";

const document = {
  id: "document",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  path: "file.rs",
  createdAt: "2026-10-24T00:00:00.000Z",
};
beforeEach(() => operation.mockReset());

it("routes reads and versioned saves through document identity", async () => {
  const value = {
    path: document.path,
    content: "text",
    version: "a".repeat(64),
    size: 4,
    markdown: false,
  };
  operation.mockResolvedValue({ type: "explorer.file", value });
  const access = documentFileAccess(document);
  expect(await access.read(document.path)).toEqual(value);
  expect(operation).toHaveBeenLastCalledWith(document.id, {
    type: "explorer.file.read",
    path: document.path,
  });
  const write = {
    path: document.path,
    content: "edited",
    version: value.version,
  };
  await access.save(write);
  expect(operation).toHaveBeenLastCalledWith(document.id, {
    type: "explorer.file.write",
    ...write,
  });
});

it("rejects attempts to repurpose the document for another path", async () => {
  const access = documentFileAccess(document);
  await expect(access.read("other.rs")).rejects.toThrow(
    "different file document",
  );
  await expect(
    access.save({ path: "other.rs", content: "", version: "a".repeat(64) }),
  ).rejects.toThrow("different file document");
  await expect(access.media("other.png")).rejects.toThrow(
    "different file document",
  );
  expect(operation).not.toHaveBeenCalled();
});

it("loads protected media through document identity", async () => {
  operation.mockResolvedValue({
    type: "explorer.media",
    value: {
      path: document.path,
      kind: "image",
      mimeType: "image/png",
      modifiedAt: document.createdAt,
      size: 0,
      offset: 0,
      data: "",
      eof: true,
    },
  });
  const blob = await documentFileAccess(document).media(document.path);
  expect(blob.size).toBe(0);
  expect(blob.type).toBe("image/png");
  expect(operation).toHaveBeenCalledWith(
    document.id,
    {
      type: "explorer.media.read",
      path: document.path,
      offset: 0,
      limit: 256 * 1024,
    },
    expect.any(String),
    0,
  );
});
