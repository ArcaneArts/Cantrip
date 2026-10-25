import {
  fileDocumentWireListSchema,
  fileDocumentWireSummarySchema,
} from "@cantrip/protocol";
import { CantripApiError, request } from "@/lib/api-client";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import {
  protectSurfaceStreamContent,
  openSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";
import {
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  surfaceStreamWireResponseSchema,
  surfaceOperationOutcomeContentSchema,
  type ExplorerOperationRequestContent,
} from "@cantrip/protocol/surface-stream";

export type FileDocument = Awaited<
  ReturnType<typeof surfaceTitleEncryption.openFileDocument>
>;

type DocumentOperation = Extract<
  ExplorerOperationRequestContent,
  { type: "explorer.file.read" | "explorer.file.write" | "explorer.media.read" }
>;

export async function executeFileDocumentOperation(
  documentId: string,
  content: DocumentOperation,
  operationId = crypto.randomUUID(),
  sequence = 0,
) {
  const captured = identity();
  const context = {
    surfaceKind: "file-document" as const,
    surfaceId: documentId,
    operationId,
    direction: "request" as const,
    sequence,
  };
  const protectedRequest = await protectSurfaceStreamContent({
    context,
    content,
    schema: explorerOperationRequestContentSchema,
  });
  assertIdentity(captured);
  const wire = surfaceStreamWireResponseSchema.parse(
    await request(
      `/api/file-documents/${encodeURIComponent(documentId)}/operation`,
      {
        method: "POST",
        body: JSON.stringify({ operationId, sequence, protectedRequest }),
      },
      { expectedIdentity: captured },
    ),
  );
  assertIdentity(captured);
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("File document returned a stale protected operation.");
  }
  const outcome = await openSurfaceStreamContent({
    context: { ...context, direction: "response" },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
  });
  assertIdentity(captured);
  if (!outcome.ok) throw new Error(outcome.error);
  const result = explorerOperationResultContentSchema.parse(outcome.result);
  const expectedType =
    content.type === "explorer.media.read" ? "explorer.media" : "explorer.file";
  if (
    result.type !== expectedType ||
    !("path" in result.value) ||
    result.value.path !== content.path
  ) {
    throw new Error("File document returned a different file result.");
  }
  return result;
}

function identity() {
  const captured = getClientSessionIdentitySnapshot();
  if (!captured)
    throw new CantripApiError("An authenticated session is required.", 401);
  return captured;
}

function assertIdentity(captured: ClientSessionIdentitySnapshot) {
  if (!clientSessionIdentityMatches(captured)) {
    throw new CantripApiError(
      "The account or server changed while opening the document.",
      409,
      "client-identity-changed",
    );
  }
}

export async function getFileDocuments(
  projectId: string,
): Promise<FileDocument[]> {
  const captured = identity();
  const documents = fileDocumentWireListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/file-documents`,
      {},
      { expectedIdentity: captured },
    ),
  );
  assertIdentity(captured);
  const opened = await Promise.all(
    documents.map((document) =>
      surfaceTitleEncryption.openFileDocument(document),
    ),
  );
  assertIdentity(captured);
  return opened;
}

export async function createFileDocument(input: {
  id: string;
  projectId: string;
  workerId: string;
  worktreeId: string;
  path: string;
}): Promise<FileDocument> {
  const captured = identity();
  const stateProtection = await surfaceTitleEncryption.protectFileDocumentState(
    input.id,
    {
      projectId: input.projectId,
      workerId: input.workerId,
      worktreeId: input.worktreeId,
      path: input.path,
    },
  );
  assertIdentity(captured);
  let response: unknown;
  try {
    response = await request(
      `/api/projects/${encodeURIComponent(input.projectId)}/file-documents`,
      {
        method: "POST",
        body: JSON.stringify({
          id: input.id,
          worktreeId: input.worktreeId,
          stateProtection,
        }),
      },
      { expectedIdentity: captured },
    );
  } catch (error) {
    assertIdentity(captured);
    if (!(error instanceof CantripApiError) || error.status !== 409)
      throw error;
    // A fresh encryption nonce makes a retry differ from the stored envelope.
    // Only the client can verify whether the immutable protected location is
    // identical. Never overwrite the existing binding to resolve a conflict.
    response = await request(
      `/api/file-documents/${encodeURIComponent(input.id)}`,
      {},
      { expectedIdentity: captured },
    );
  }
  const document = fileDocumentWireSummarySchema.parse(response);
  assertIdentity(captured);
  const opened = await surfaceTitleEncryption.openFileDocument(document);
  assertIdentity(captured);
  if (
    opened.id !== input.id ||
    opened.projectId !== input.projectId ||
    opened.workerId !== input.workerId ||
    opened.worktreeId !== input.worktreeId ||
    opened.path !== input.path
  ) {
    throw new CantripApiError(
      "File document identity belongs to a different location.",
      409,
    );
  }
  return opened;
}
