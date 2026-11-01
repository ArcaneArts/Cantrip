import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { fileDocumentPrivateStateOpaqueSchema } from "@cantrip/protocol/surface-private-state";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  type ExplorerOperationRequestContent,
} from "@cantrip/protocol/surface-stream";
import { encodeSurfacePrivateStateForWorker } from "../surface-private-state-encryption.js";
import {
  protectWorkerSurfaceStreamContent,
  openWorkerSurfaceStreamContent,
  SurfaceStreamReplayGuard,
} from "../surface-stream-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { handleExplorerCommand } from "./explorer.js";
import { ExplorerFileImports } from "../explorer-file-imports.js";

const files = vi.hoisted(() => ({
  read: vi.fn(),
  binary: vi.fn(),
  write: vi.fn(),
  preview: vi.fn(),
  tail: vi.fn(),
}));
vi.mock("../explorer.js", () => ({
  readExplorerFile: files.read,
  readExplorerBinaryFile: files.binary,
  readExplorerTextPreview: files.preview,
  readExplorerLogTail: files.tail,
  writeExplorerFile: files.write,
}));
const service = {
  ownerId: () => "owner",
  status: () => ({}),
  componentKey: () => ({ key: new Uint8Array(32).fill(17), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;
beforeEach(() => {
  files.read.mockReset();
  files.binary.mockReset();
  files.preview.mockReset();
  files.tail.mockReset();
  files.write.mockReset();
});

async function fixture(
  request: ExplorerOperationRequestContent = {
    type: "explorer.file.read",
    path: "src/main.rs",
  },
) {
  const documentId = randomUUID();
  const context = {
    serverId: "server",
    surfaceKind: "file-document" as const,
    surfaceId: documentId,
    operationId: randomUUID(),
    sequence: 0,
    direction: "request" as const,
  };
  const stateProtection = fileDocumentPrivateStateOpaqueSchema.parse(
    await encodeSurfacePrivateStateForWorker({
      ownerId: "owner",
      service,
      context: {
        serverId: "server",
        resource: "file-document-row",
        resourceId: documentId,
        operationId: null,
        recordKind: "file-document-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "file-document-state" },
        projectId: "project",
        worktreeId: "worktree",
        workerId: "worker",
        path: "src/main.rs",
      },
    }),
  );
  const command = {
    type: "file-document.operation" as const,
    documentId,
    serverId: "server",
    projectId: "project",
    worktreeId: "worktree",
    workerId: "worker",
    root: "/repo",
    stateProtection,
    operationId: context.operationId,
    sequence: 0,
    protectedRequest: await protectWorkerSurfaceStreamContent({
      context,
      content: request,
      schema: explorerOperationRequestContentSchema,
      service,
    }),
  };
  const dependencies = {
    fileImports: new ExplorerFileImports(),
    workerEncryption: service,
    surfaceStreamReplay: new SurfaceStreamReplayGuard(),
  };
  return {
    command,
    context,
    dependencies,
    async run() {
      const response = surfaceStreamWireResponseSchema.parse(
        await handleExplorerCommand(command, dependencies),
      );
      return openWorkerSurfaceStreamContent({
        context: { ...context, direction: "response" },
        opaque: response.protectedResponse,
        schema: surfaceOperationOutcomeContentSchema,
        service,
      });
    },
  };
}

it("returns an authenticated file read without an Explorer entity", async () => {
  const value = {
    path: "src/main.rs",
    content: "fn main() {}",
    size: 12,
    markdown: false,
    version: "a".repeat(64),
  };
  files.read.mockResolvedValue(value);
  const f = await fixture();
  expect(await f.run()).toEqual({
    ok: true,
    result: { type: "explorer.file", value },
  });
  expect(files.read).toHaveBeenCalledExactlyOnceWith("/repo", "src/main.rs");
});

it("preserves version-checked writes through the document stream", async () => {
  const version = "a".repeat(64);
  const value = {
    path: "src/main.rs",
    content: "changed",
    size: 7,
    markdown: false,
    version: "b".repeat(64),
  };
  files.write.mockResolvedValue(value);
  const f = await fixture({
    type: "explorer.file.write",
    path: value.path,
    content: value.content,
    version,
  });
  expect(await f.run()).toEqual({
    ok: true,
    result: { type: "explorer.file", value },
  });
  expect(files.write).toHaveBeenCalledExactlyOnceWith(
    "/repo",
    value.path,
    value.content,
    version,
  );
});

it("authenticates document location before reading and protects filesystem errors", async () => {
  files.read.mockRejectedValue(new Error("read failed"));
  const f = await fixture();
  expect(await f.run()).toEqual({ ok: false, error: "read failed" });
  expect(files.read).toHaveBeenCalledExactlyOnceWith("/repo", "src/main.rs");
  await expect(f.run()).rejects.toThrow("already completed");
});

it.each(["projectId", "workerId", "worktreeId"] as const)(
  "rejects a changed %s before reading",
  async (field) => {
    const f = await fixture();
    f.command[field] = "another";
    expect(await f.run()).toEqual({
      ok: false,
      error: "File document checkout binding does not match.",
    });
    expect(files.read).not.toHaveBeenCalled();
    expect(files.tail).not.toHaveBeenCalled();
  },
);

it.each([
  { type: "explorer.binary.read", path: "another.nbt", offset: 0, limit: 1 },
  { type: "explorer.file.read", path: "another.rs" },
  { type: "explorer.file.preview", path: "another.rs", offset: 0 },
  { type: "explorer.file.tail", path: "another.log" },
  { type: "explorer.directory.list", path: "src/main.rs" },
  {
    type: "explorer.file.import",
    path: "src",
    name: "main.rs",
    size: 0,
    offset: 0,
    data: "",
    eof: true,
  },
  { type: "explorer.file.import.cancel" },
] as ExplorerOperationRequestContent[])(
  "rejects operations outside the immutable document",
  async (request) => {
    const f = await fixture(request);
    expect(await f.run()).toEqual({
      ok: false,
      error: "The operation does not target this file document.",
    });
    expect(files.read).not.toHaveBeenCalled();
    expect(files.tail).not.toHaveBeenCalled();
  },
);

it("rejects an Explorer stream replayed under a document identity", async () => {
  const f = await fixture();
  f.command.protectedRequest = await protectWorkerSurfaceStreamContent({
    context: { ...f.context, surfaceKind: "explorer" },
    content: { type: "explorer.file.read", path: "src/main.rs" },
    schema: explorerOperationRequestContentSchema,
    service,
  });
  await expect(f.run()).rejects.toThrow("could not be authenticated");
  expect(files.read).not.toHaveBeenCalled();
});

it("keeps large preview pages encrypted and bound to the document path", async () => {
  const value = {
    path: "src/main.rs",
    content: "private text",
    size: 12,
    offset: 0,
    nextOffset: 12,
    eof: true,
    version: "a".repeat(64),
  };
  files.preview.mockResolvedValue(value);
  const f = await fixture({
    type: "explorer.file.preview",
    path: value.path,
    offset: 0,
  });
  const response = await handleExplorerCommand(f.command, f.dependencies);
  expect(JSON.stringify(response)).not.toContain("private text");
  const wire = surfaceStreamWireResponseSchema.parse(response);
  const result = await openWorkerSurfaceStreamContent({
    context: { ...f.context, direction: "response" },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
    service,
  });
  expect(result).toEqual({
    ok: true,
    result: { type: "explorer.file.preview", value },
  });
  expect(files.preview).toHaveBeenCalledExactlyOnceWith(
    "/repo",
    value.path,
    0,
    undefined,
  );
});
it("returns a typed protected fallback instead of treating a large preview as a fatal read", async () => {
  const { TextPreviewRequiredError } =
    await import("../explorer-text-preview.js");
  files.read.mockRejectedValue(new TextPreviewRequiredError());
  const f = await fixture();
  expect(await f.run()).toMatchObject({
    ok: false,
    code: "text-preview-required",
  });
});

it("keeps log tails encrypted and pinned to the document path", async () => {
  const value = {
    path: "src/main.rs",
    content: "SENTINEL output",
    startOffset: 0,
    size: 15,
    reset: true,
    cursor: { offset: 15, identity: "a".repeat(64), anchor: "b".repeat(64) },
  };
  files.tail.mockResolvedValue(value);
  const f = await fixture({ type: "explorer.file.tail", path: value.path });
  const response = surfaceStreamWireResponseSchema.parse(
    await handleExplorerCommand(f.command, f.dependencies),
  );
  expect(JSON.stringify(response)).not.toContain("SENTINEL");
  expect(
    await openWorkerSurfaceStreamContent({
      context: { ...f.context, direction: "response" },
      opaque: response.protectedResponse,
      schema: surfaceOperationOutcomeContentSchema,
      service,
    }),
  ).toEqual({ ok: true, result: { type: "explorer.file.tail", value } });
  expect(files.tail).toHaveBeenCalledExactlyOnceWith(
    "/repo",
    value.path,
    undefined,
  );
});

it("decrypts scoped binary requests and encrypts their bounded reply", async () => {
  const value = {
    path: "src/main.rs",
    offset: 0,
    nextOffset: 1,
    size: 1,
    eof: true,
    version: "binary-v1:" + "a".repeat(64),
    data: "AA==",
  };
  files.binary.mockResolvedValue(value);
  const f = await fixture({
    type: "explorer.binary.read",
    path: value.path,
    offset: 0,
    limit: 1,
  });
  const result = await handleExplorerCommand(f.command, f.dependencies);
  const wire = surfaceStreamWireResponseSchema.parse(result);
  const outcome = await openWorkerSurfaceStreamContent({
    context: { ...f.context, direction: "response" },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
    service,
  });
  expect(outcome).toEqual({
    ok: true,
    result: { type: "explorer.binary", value },
  });
});
it.each([
  "explorer.binary.write.begin",
  "explorer.binary.write.chunk",
  "explorer.binary.write.commit",
  "explorer.binary.write.status",
  "explorer.binary.write.abort",
] as const)("authenticates exact document scope before %s", async (type) => {
  const uploadId = randomUUID(),
    path = "src/main.rs",
    base = { path, uploadId },
    request = (
      type === "explorer.binary.write.begin"
        ? { type, ...base, version: "binary-v1:" + "a".repeat(64) }
        : type === "explorer.binary.write.chunk"
          ? { type, ...base, offset: 0, data: "AA==", final: true }
          : type === "explorer.binary.write.commit"
            ? { type, ...base, size: 1, sha256: "b".repeat(64) }
            : { type, ...base }
    ) as ExplorerOperationRequestContent;
  const f = await fixture(request),
    value = {
      path,
      uploadId,
      state: "uploading",
      offset: 0,
      size: null,
      sha256: null,
      version: null,
      error: null,
    },
    execute = vi.fn(async () => value);
  Object.assign(f.dependencies, { binaryWrites: { execute } });
  expect(await f.run()).toEqual({
    ok: true,
    result: { type: "explorer.binary.write", value },
  });
  expect(execute).toHaveBeenCalledWith(
    {
      serverId: "server",
      surfaceKind: "file-document",
      surfaceId: f.command.documentId,
      root: "/repo",
    },
    request,
  );
  const other = await fixture({
      ...request,
      path: "other.nbt",
    } as ExplorerOperationRequestContent),
    denied = vi.fn();
  Object.assign(other.dependencies, { binaryWrites: { execute: denied } });
  expect(await other.run()).toMatchObject({
    ok: false,
    error: "The operation does not target this file document.",
  });
  expect(denied).not.toHaveBeenCalled();
});
