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

const files = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../explorer.js", () => ({
  readExplorerFile: files.read,
  writeExplorerFile: files.write,
}));
const service = {
  ownerId: () => "owner",
  status: () => ({}),
  componentKey: () => ({ key: new Uint8Array(32).fill(17), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;
beforeEach(() => {
  files.read.mockReset();
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
  },
);

it.each([
  { type: "explorer.file.read", path: "another.rs" },
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
