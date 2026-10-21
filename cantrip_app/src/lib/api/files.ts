import {
  type StandaloneChatFileOperationIntent,
  type StandaloneChatFileBinding,
  type StandaloneChatFileOperationRequestContent,
  type StandaloneChatFileOperationResultContent,
  standaloneChatFileOperationRequestContentSchema,
  surfaceStreamWireResponseSchema,
  surfaceOperationOutcomeContentSchema,
  standaloneChatFileOperationResultContentSchema,
  chatFileReferencesRequestContentSchema,
  chatFileReferencesResultContentSchema,
  type StandaloneChatFileDownloadKind,
  type ExplorerOperationRequestContent,
  type ExplorerFileBinding,
  type ExplorerOperationResultContent,
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
} from "@cantrip/protocol/surface-stream";
import {
  protectSurfaceStreamContent,
  openSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";
import { request } from "@/lib/api-client";
import {
  explorerDirectorySchema,
  explorerFileSchema,
  explorerFileWriteSchema,
  explorerEntryMutationResultSchema,
  explorerFileSearchSchema,
  explorerDirectoryCommitsSchema,
  explorerDirectoryCreateSchema,
  explorerEntrySchema,
  explorerEntryRenameSchema,
  explorerEntryDeleteSchema,
} from "@cantrip/protocol";
import type {
  ExplorerFileWrite,
  ExplorerDirectoryCreate,
  ExplorerEntry,
  ExplorerEntryRename,
  ExplorerEntryMutationResult,
  ExplorerEntryDelete,
} from "@cantrip/protocol";

async function executeStandaloneChatFileOperation(
  chatId: string,
  intent: StandaloneChatFileOperationIntent,
  content: StandaloneChatFileOperationRequestContent,
  operationId = crypto.randomUUID(),
  sequence = 0,
  binding?: StandaloneChatFileBinding,
): Promise<StandaloneChatFileOperationResultContent> {
  const protectedRequest = await protectSurfaceStreamContent({
    context: {
      surfaceKind: "chat-files",
      surfaceId: chatId,
      operationId,
      direction: "request",
      sequence,
    },
    content: standaloneChatFileOperationRequestContentSchema.parse(content),
    schema: standaloneChatFileOperationRequestContentSchema,
  });
  const wire = surfaceStreamWireResponseSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/files/operation`, {
      method: "POST",
      body: JSON.stringify({
        intent,
        operationId,
        sequence,
        protectedRequest,
        ...(binding ? { binding } : {}),
      }),
    }),
  );
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("Chat files returned a stale protected operation.");
  }
  const outcome = await openSurfaceStreamContent({
    context: {
      surfaceKind: "chat-files",
      surfaceId: chatId,
      operationId,
      direction: "response",
      sequence,
    },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return standaloneChatFileOperationResultContentSchema.parse(outcome.result);
}

export async function getChatFileReferences(
  chatId: string,
  references: string[],
) {
  const operationId = crypto.randomUUID();
  const context = {
    surfaceKind: "chat-files" as const,
    surfaceId: chatId,
    operationId,
    direction: "request" as const,
    sequence: 0,
  };
  const protectedRequest = await protectSurfaceStreamContent({
    context,
    content: { type: "chat.files.references", references },
    schema: chatFileReferencesRequestContentSchema,
  });
  const wire = surfaceStreamWireResponseSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/file-references`, {
      method: "POST",
      body: JSON.stringify({ operationId, sequence: 0, protectedRequest }),
    }),
  );
  if (wire.operationId !== operationId || wire.sequence !== 0)
    throw new Error("Chat returned stale reference metadata.");
  const outcome = await openSurfaceStreamContent({
    context: { ...context, direction: "response" },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  if (outcome.result.type !== "chat.files.references")
    throw new Error("Chat returned unexpected reference metadata.");
  return chatFileReferencesResultContentSchema.parse(outcome.result.value);
}

export async function getStandaloneChatFileDirectory(
  chatId: string,
  path: string,
) {
  const result = await executeStandaloneChatFileOperation(chatId, "list", {
    type: "chat-files.directory.list",
    path,
  });
  if (result.type !== "chat-files.directory.list") {
    throw new Error("Chat files returned an unexpected directory result.");
  }
  return explorerDirectorySchema.parse(result.value);
}

export async function getStandaloneChatFile(
  chatId: string,
  path: string,
  binding?: StandaloneChatFileBinding,
) {
  const result = await executeStandaloneChatFileOperation(
    chatId,
    "read",
    {
      type: "chat-files.file.read",
      path,
    },
    undefined,
    undefined,
    binding,
  );
  if (result.type !== "chat-files.file") {
    throw new Error("Chat files returned an unexpected file result.");
  }
  return explorerFileSchema.parse(result.value);
}

export async function resolveStandaloneChatFilePath(
  chatId: string,
  reference: string,
) {
  const result = await executeStandaloneChatFileOperation(chatId, "read", {
    type: "chat-files.path.resolve",
    reference,
  });
  if (result.type !== "chat-files.path.resolved") {
    throw new Error("Chat files returned an unexpected path result.");
  }
  return result.path;
}

export async function loadStandaloneChatFileMedia(
  chatId: string,
  path: string,
): Promise<Blob> {
  const operationId = crypto.randomUUID();
  const parts: BlobPart[] = [];
  let offset = 0;
  let sequence = 0;
  let expected:
    | { kind: string; mimeType: string; modifiedAt: string; size: number }
    | undefined;
  for (;;) {
    const result = await executeStandaloneChatFileOperation(
      chatId,
      "read",
      {
        type: "chat-files.media.read",
        path,
        offset,
        limit: 256 * 1_024,
      },
      operationId,
      sequence,
    );
    if (result.type !== "chat-files.media") {
      throw new Error("Chat files returned an unexpected media result.");
    }
    const chunk = result.value;
    if (chunk.path !== path || chunk.offset !== offset) {
      throw new Error("Chat files returned stale protected media content.");
    }
    const metadata = {
      kind: chunk.kind,
      mimeType: chunk.mimeType,
      modifiedAt: chunk.modifiedAt,
      size: chunk.size,
    };
    if (expected && JSON.stringify(expected) !== JSON.stringify(metadata)) {
      throw new Error("Chat media changed while it was loading.");
    }
    expected ??= metadata;
    const bytes = decodeExplorerMediaBytes(chunk.data);
    if (offset + bytes.byteLength > chunk.size) {
      throw new Error("Chat files returned oversized protected media content.");
    }
    parts.push(new Uint8Array(bytes).buffer as ArrayBuffer);
    offset += bytes.byteLength;
    sequence += 1;
    if (chunk.eof) {
      if (offset !== chunk.size) {
        throw new Error(
          "Chat files returned incomplete protected media content.",
        );
      }
      return new Blob(parts, { type: chunk.mimeType });
    }
    if (bytes.byteLength === 0) {
      throw new Error("Chat media stream stopped progressing.");
    }
  }
}

export async function saveStandaloneChatFile(
  chatId: string,
  input: { path: string; content: string; version: string },
  binding?: StandaloneChatFileBinding,
) {
  const result = await executeStandaloneChatFileOperation(
    chatId,
    "write",
    {
      type: "chat-files.file.write",
      ...explorerFileWriteSchema.parse(input),
    },
    undefined,
    undefined,
    binding,
  );
  if (result.type !== "chat-files.file") {
    throw new Error("Chat files returned an unexpected saved file result.");
  }
  return explorerFileSchema.parse(result.value);
}

export async function deleteStandaloneChatFileEntry(
  chatId: string,
  input: { path: string; recursive: boolean },
) {
  const result = await executeStandaloneChatFileOperation(chatId, "remove", {
    type: "chat-files.entry.delete",
    ...input,
  });
  if (result.type !== "chat-files.entry.mutated") {
    throw new Error("Chat files returned an unexpected delete result.");
  }
  return explorerEntryMutationResultSchema.parse(result.value);
}

export async function downloadStandaloneChatFiles(
  chatId: string,
  input: { kind: StandaloneChatFileDownloadKind; path: string },
): Promise<{ blob: Blob; fileName: string }> {
  const operationId = crypto.randomUUID();
  const intent = input.kind === "file" ? "download" : "archive";
  let sequence = 0;
  const preparedResult = await executeStandaloneChatFileOperation(
    chatId,
    intent,
    { type: "chat-files.download.prepare", ...input },
    operationId,
    sequence,
  );
  if (preparedResult.type !== "chat-files.download.prepared") {
    throw new Error("Chat files returned an unexpected download result.");
  }
  const prepared = preparedResult.value;
  const parts: BlobPart[] = [];
  let offset = 0;
  try {
    for (;;) {
      sequence += 1;
      const result = await executeStandaloneChatFileOperation(
        chatId,
        intent,
        {
          type: "chat-files.download.read",
          downloadId: prepared.downloadId,
          offset,
          limit: 256 * 1_024,
        },
        operationId,
        sequence,
      );
      if (result.type !== "chat-files.download.chunk") {
        throw new Error("Chat files returned an unexpected download chunk.");
      }
      const chunk = result.value;
      if (chunk.downloadId !== prepared.downloadId || chunk.offset !== offset) {
        throw new Error(
          "Chat files returned a stale protected download chunk.",
        );
      }
      const bytes = decodeExplorerMediaBytes(chunk.data);
      if (offset + bytes.byteLength > prepared.size) {
        throw new Error("Chat files returned an oversized protected download.");
      }
      parts.push(new Uint8Array(bytes).buffer as ArrayBuffer);
      offset += bytes.byteLength;
      if (chunk.eof) {
        if (offset !== prepared.size) {
          throw new Error(
            "Chat files returned an incomplete protected download.",
          );
        }
        return {
          blob: new Blob(parts, { type: prepared.mimeType }),
          fileName: prepared.fileName,
        };
      }
      if (bytes.byteLength === 0) {
        throw new Error("Chat file download stopped progressing.");
      }
    }
  } catch (error) {
    await executeStandaloneChatFileOperation(
      chatId,
      intent,
      {
        type: "chat-files.download.cancel",
        downloadId: prepared.downloadId,
      },
      operationId,
      sequence + 1,
    ).catch(() => undefined);
    throw error;
  }
}

async function executeExplorerOperation(
  explorerId: string,
  content: ExplorerOperationRequestContent,
  operationId = crypto.randomUUID(),
  sequence = 0,
  binding?: ExplorerFileBinding,
): Promise<ExplorerOperationResultContent> {
  const protectedRequest = await protectSurfaceStreamContent({
    context: {
      surfaceKind: "explorer",
      surfaceId: explorerId,
      operationId,
      direction: "request",
      sequence,
    },
    content,
    schema: explorerOperationRequestContentSchema,
  });
  const wire = surfaceStreamWireResponseSchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/operation`,
      {
        method: "POST",
        body: JSON.stringify({
          operationId,
          sequence,
          protectedRequest,
          ...(binding ? { binding } : {}),
        }),
      },
    ),
  );
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("Explorer returned a stale protected operation.");
  }
  const outcome = await openSurfaceStreamContent({
    context: {
      surfaceKind: "explorer",
      surfaceId: explorerId,
      operationId,
      direction: "response",
      sequence,
    },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return explorerOperationResultContentSchema.parse(outcome.result);
}

export async function getExplorerDirectory(explorerId: string, path: string) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.directory.list",
    path,
  });
  if (result.type !== "explorer.directory.list") {
    throw new Error("Explorer returned an unexpected directory result.");
  }
  return explorerDirectorySchema.parse(result.value);
}

export async function searchExplorerFiles(
  explorerId: string,
  query: string,
  limit = 50,
) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.files.search",
    query,
    limit,
  });
  if (result.type !== "explorer.files.search") {
    throw new Error("Explorer returned an unexpected file search result.");
  }
  return explorerFileSearchSchema.parse(result.value);
}

export async function getExplorerDirectoryCommits(
  explorerId: string,
  path: string,
) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.directory.commits",
    path,
  });
  if (result.type !== "explorer.directory.commits") {
    throw new Error("Explorer returned unexpected commit metadata.");
  }
  return explorerDirectoryCommitsSchema.parse(result.value);
}

export async function getExplorerFile(
  explorerId: string,
  path: string,
  binding?: ExplorerFileBinding,
) {
  const result = await executeExplorerOperation(
    explorerId,
    {
      type: "explorer.file.read",
      path,
    },
    undefined,
    undefined,
    binding,
  );
  if (result.type !== "explorer.file") {
    throw new Error("Explorer returned an unexpected file result.");
  }
  return explorerFileSchema.parse(result.value);
}

function decodeExplorerMediaBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function loadExplorerMedia(
  explorerId: string,
  path: string,
): Promise<Blob> {
  const operationId = crypto.randomUUID();
  const parts: BlobPart[] = [];
  let offset = 0;
  let sequence = 0;
  let expected:
    | { kind: string; mimeType: string; modifiedAt: string; size: number }
    | undefined;
  for (;;) {
    const result = await executeExplorerOperation(
      explorerId,
      {
        type: "explorer.media.read",
        path,
        offset,
        limit: 256 * 1_024,
      },
      operationId,
      sequence,
    );
    if (result.type !== "explorer.media") {
      throw new Error("Explorer returned an unexpected media result.");
    }
    const chunk = result.value;
    if (chunk.path !== path || chunk.offset !== offset) {
      throw new Error("Explorer returned stale protected media content.");
    }
    const metadata = {
      kind: chunk.kind,
      mimeType: chunk.mimeType,
      modifiedAt: chunk.modifiedAt,
      size: chunk.size,
    };
    if (expected && JSON.stringify(expected) !== JSON.stringify(metadata)) {
      throw new Error("Explorer media changed while it was loading.");
    }
    expected ??= metadata;
    const bytes = decodeExplorerMediaBytes(chunk.data);
    if (offset + bytes.byteLength > chunk.size) {
      throw new Error("Explorer returned oversized protected media content.");
    }
    parts.push(new Uint8Array(bytes).buffer as ArrayBuffer);
    offset += bytes.byteLength;
    sequence += 1;
    if (chunk.eof) {
      if (offset !== chunk.size) {
        throw new Error(
          "Explorer returned incomplete protected media content.",
        );
      }
      return new Blob(parts, { type: chunk.mimeType });
    }
    if (bytes.byteLength === 0) {
      throw new Error("Explorer protected media stream stopped progressing.");
    }
  }
}

export async function saveExplorerFile(
  explorerId: string,
  input: ExplorerFileWrite,
  binding?: ExplorerFileBinding,
) {
  const result = await executeExplorerOperation(
    explorerId,
    {
      type: "explorer.file.write",
      ...explorerFileWriteSchema.parse(input),
    },
    undefined,
    undefined,
    binding,
  );
  if (result.type !== "explorer.file") {
    throw new Error("Explorer returned an unexpected saved file result.");
  }
  return explorerFileSchema.parse(result.value);
}

export async function createExplorerDirectory(
  explorerId: string,
  input: ExplorerDirectoryCreate,
): Promise<ExplorerEntry> {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.directory.create",
    ...explorerDirectoryCreateSchema.parse(input),
  });
  if (result.type !== "explorer.directory.created") {
    throw new Error("Explorer returned an unexpected created folder result.");
  }
  return explorerEntrySchema.parse(result.value);
}

export async function renameExplorerEntry(
  explorerId: string,
  input: ExplorerEntryRename,
): Promise<ExplorerEntryMutationResult> {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.entry.rename",
    ...explorerEntryRenameSchema.parse(input),
  });
  if (result.type !== "explorer.entry.mutated") {
    throw new Error("Explorer returned an unexpected rename result.");
  }
  return explorerEntryMutationResultSchema.parse(result.value);
}

export async function deleteExplorerEntry(
  explorerId: string,
  input: ExplorerEntryDelete,
): Promise<ExplorerEntryMutationResult> {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.entry.delete",
    ...explorerEntryDeleteSchema.parse(input),
  });
  if (result.type !== "explorer.entry.mutated") {
    throw new Error("Explorer returned an unexpected delete result.");
  }
  return explorerEntryMutationResultSchema.parse(result.value);
}
