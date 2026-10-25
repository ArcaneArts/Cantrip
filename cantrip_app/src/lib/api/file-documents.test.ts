import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  protect: vi.fn(),
  open: vi.fn(),
  matches: vi.fn(),
  snapshot: vi.fn(),
  protectStream: vi.fn(),
  openStream: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  request: mocks.request,
  CantripApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/client-session", () => ({
  clientSessionIdentityMatches: mocks.matches,
  getClientSessionIdentitySnapshot: mocks.snapshot,
}));
vi.mock("@/lib/surface-title-encryption", () => ({
  surfaceTitleEncryption: {
    protectFileDocumentState: mocks.protect,
    openFileDocument: mocks.open,
  },
}));
vi.mock("@/lib/surface-stream-encryption", () => ({
  protectSurfaceStreamContent: mocks.protectStream,
  openSurfaceStreamContent: mocks.openStream,
}));
import {
  createFileDocument,
  getFileDocuments,
  executeFileDocumentOperation,
} from "./file-documents";
import { CantripApiError } from "@/lib/api-client";

const identity = { ownerId: "owner", serverId: "server", generation: 1 };
const input = {
  id: "00000000-0000-4000-8000-000000000108",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  path: "private.rs",
};
const stateProtection = {
  classification: { recordKind: "file-document-state" },
  protectedState: {
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
};
const wire = {
  id: input.id,
  projectId: input.projectId,
  workerId: input.workerId,
  worktreeId: input.worktreeId,
  createdAt: "2026-10-24T00:00:00.000Z",
  stateProtection,
};
const operationId = "00000000-0000-4000-8000-000000000109";
const readOperation = { type: "explorer.file.read" as const, path: input.path };
const fileResult = {
  type: "explorer.file",
  value: {
    path: input.path,
    content: "private file",
    size: 12,
    markdown: false,
    version: "a".repeat(64),
  },
};
const operationWire = {
  operationId,
  sequence: 0,
  protectedResponse: stateProtection.protectedState,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.snapshot.mockReturnValue(identity);
  mocks.matches.mockReturnValue(true);
  mocks.protect.mockResolvedValue(stateProtection);
  mocks.request.mockResolvedValue(wire);
  mocks.open.mockResolvedValue(input);
  mocks.protectStream.mockResolvedValue(stateProtection.protectedState);
  mocks.openStream.mockResolvedValue({ ok: true, result: fileResult });
});

it("binds protected file operations to document, sequence, direction and identity", async () => {
  mocks.request.mockResolvedValue(operationWire);
  expect(
    await executeFileDocumentOperation(input.id, readOperation, operationId),
  ).toEqual(fileResult);
  const context = {
    surfaceKind: "file-document",
    surfaceId: input.id,
    operationId,
    sequence: 0,
  };
  expect(mocks.protectStream).toHaveBeenCalledWith(
    expect.objectContaining({
      context: { ...context, direction: "request" },
      content: readOperation,
    }),
  );
  expect(mocks.openStream).toHaveBeenCalledWith(
    expect.objectContaining({
      context: { ...context, direction: "response" },
      opaque: operationWire.protectedResponse,
    }),
  );
  const [url, init, options] = mocks.request.mock.calls[0]!;
  expect(url).toBe(`/api/file-documents/${input.id}/operation`);
  expect(JSON.parse(init.body)).toEqual({
    operationId,
    sequence: 0,
    protectedRequest: stateProtection.protectedState,
  });
  expect(init.body).not.toContain(input.path);
  expect(options).toEqual({ expectedIdentity: identity });
});

it.each([{ operationId: input.id }, { sequence: 1 }])(
  "rejects stale operation metadata %j before decrypting",
  async (override) => {
    mocks.request.mockResolvedValue({ ...operationWire, ...override });
    await expect(
      executeFileDocumentOperation(input.id, readOperation, operationId),
    ).rejects.toThrow("stale protected operation");
    expect(mocks.openStream).not.toHaveBeenCalled();
  },
);

it("rejects a different file in an otherwise valid protected result", async () => {
  mocks.request.mockResolvedValue(operationWire);
  mocks.openStream.mockResolvedValue({
    ok: true,
    result: { ...fileResult, value: { ...fileResult.value, path: "other.rs" } },
  });
  await expect(
    executeFileDocumentOperation(input.id, readOperation, operationId),
  ).rejects.toThrow("different file result");
});

it("reports worker failure without treating it as file content", async () => {
  mocks.request.mockResolvedValue(operationWire);
  mocks.openStream.mockResolvedValue({
    ok: false,
    error: "File changed on disk",
  });
  await expect(
    executeFileDocumentOperation(input.id, readOperation, operationId),
  ).rejects.toThrow("File changed on disk");
});

it.each(["encrypt", "request", "decrypt"])(
  "rejects an account change during %s",
  async (phase) => {
    mocks.request.mockResolvedValue(operationWire);
    const target =
      phase === "encrypt"
        ? mocks.protectStream
        : phase === "request"
          ? mocks.request
          : mocks.openStream;
    target.mockImplementationOnce(async () => {
      mocks.matches.mockReturnValue(false);
      return phase === "encrypt"
        ? stateProtection.protectedState
        : phase === "request"
          ? operationWire
          : { ok: true, result: fileResult };
    });
    await expect(
      executeFileDocumentOperation(input.id, readOperation, operationId),
    ).rejects.toThrow("account or server changed");
    if (phase === "encrypt") expect(mocks.request).not.toHaveBeenCalled();
    if (phase !== "decrypt") expect(mocks.openStream).not.toHaveBeenCalled();
  },
);

it("sends only protected location with the captured request identity", async () => {
  expect(await createFileDocument(input)).toEqual(input);
  const [url, init, behavior] = mocks.request.mock.calls[0]!;
  expect(url).toBe("/api/projects/project/file-documents");
  expect(JSON.parse(init.body)).toEqual({
    id: input.id,
    worktreeId: input.worktreeId,
    stateProtection,
  });
  expect(init.body).not.toContain(input.path);
  expect(behavior).toEqual({ expectedIdentity: identity });
});

it("does not submit when logout occurs during encryption", async () => {
  mocks.protect.mockImplementation(async () => {
    mocks.matches.mockReturnValue(false);
    return stateProtection;
  });
  await expect(createFileDocument(input)).rejects.toThrow(
    "account or server changed",
  );
  expect(mocks.request).not.toHaveBeenCalled();
});

it("discards decrypted catalog results after an account switch", async () => {
  mocks.request.mockResolvedValue([wire]);
  mocks.open.mockImplementation(async () => {
    mocks.matches.mockReturnValue(false);
    return input;
  });
  await expect(getFileDocuments(input.projectId)).rejects.toThrow(
    "account or server changed",
  );
});

it("resolves an encrypted create retry by verifying the stored location", async () => {
  mocks.request.mockRejectedValueOnce(new CantripApiError("Conflict", 409));
  expect(await createFileDocument(input)).toEqual(input);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.request).toHaveBeenLastCalledWith(
    `/api/file-documents/${input.id}`,
    {},
    { expectedIdentity: identity },
  );
});

it.each(["id", "projectId", "workerId", "worktreeId", "path"] as const)(
  "rejects a create retry when the stored %s differs",
  async (field) => {
    mocks.request.mockRejectedValueOnce(new CantripApiError("Conflict", 409));
    mocks.open.mockResolvedValue({ ...input, [field]: "different" });
    await expect(createFileDocument(input)).rejects.toThrow(
      "different location",
    );
    expect(mocks.request).toHaveBeenCalledTimes(2);
  },
);

it("also verifies the location returned by a successful create", async () => {
  mocks.open.mockResolvedValue({ ...input, path: "another.rs" });
  await expect(createFileDocument(input)).rejects.toThrow("different location");
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("propagates a real create failure without a conflict lookup", async () => {
  const error = new CantripApiError("Unavailable", 503);
  mocks.request.mockRejectedValueOnce(error);
  await expect(createFileDocument(input)).rejects.toBe(error);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("does not look up a conflicted document after the account changes", async () => {
  mocks.request.mockImplementationOnce(async () => {
    mocks.matches.mockReturnValue(false);
    throw new CantripApiError("Conflict", 409);
  });
  await expect(createFileDocument(input)).rejects.toThrow(
    "account or server changed",
  );
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("rejects a retry lookup result when the account changes during the read", async () => {
  mocks.request
    .mockRejectedValueOnce(new CantripApiError("Conflict", 409))
    .mockImplementationOnce(async () => {
      mocks.matches.mockReturnValue(false);
      return wire;
    });
  await expect(createFileDocument(input)).rejects.toThrow(
    "account or server changed",
  );
  expect(mocks.open).not.toHaveBeenCalled();
});

it("propagates a failed conflict lookup without creating another document", async () => {
  const error = new CantripApiError("Not found", 404);
  mocks.request
    .mockRejectedValueOnce(new CantripApiError("Conflict", 409))
    .mockRejectedValueOnce(error);
  await expect(createFileDocument(input)).rejects.toBe(error);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.open).not.toHaveBeenCalled();
});
