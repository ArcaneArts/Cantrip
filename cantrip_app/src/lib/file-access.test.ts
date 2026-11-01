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
  await expect(access.preview!("other.rs", 0)).rejects.toThrow(
    "different file document",
  );
  await expect(access.media("other.png")).rejects.toThrow(
    "different file document",
  );
  await expect(access.tail!("other.log")).rejects.toThrow(
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

it("requests versioned preview pages through the same protected document", async () => {
  const value = {
    path: document.path,
    content: "next",
    offset: 4,
    nextOffset: 8,
    size: 8,
    eof: true,
    version: "a".repeat(64),
  };
  operation.mockResolvedValue({ type: "explorer.file.preview", value });
  expect(
    await documentFileAccess(document).preview!(
      document.path,
      4,
      value.version,
    ),
  ).toEqual(value);
  expect(operation).toHaveBeenCalledExactlyOnceWith(document.id, {
    type: "explorer.file.preview",
    path: document.path,
    offset: 4,
    version: value.version,
  });
});

it("pins incremental log reads to the file document identity", async () => {
  const cursor = {
    offset: 12,
    identity: "a".repeat(64),
    anchor: "b".repeat(64),
  };
  const value = {
    path: document.path,
    content: "next",
    startOffset: 12,
    size: 16,
    reset: false,
    cursor: { ...cursor, offset: 16 },
  };
  operation.mockResolvedValue({ type: "explorer.file.tail", value });
  expect(
    await documentFileAccess(document).tail!(document.path, cursor),
  ).toEqual(value);
  expect(operation).toHaveBeenCalledExactlyOnceWith(document.id, {
    type: "explorer.file.tail",
    path: document.path,
    cursor,
  });
});
