import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ManagedSessionContext } from "@cantrip/protocol";
import type { NativeSuspensionStore } from "../native-suspension-store.js";
import { WorkerEncryptionError } from "../worker-encryption.js";

export class ManagedSuspensionSourceError extends Error {
  constructor(
    readonly code:
      "storage-unavailable" | "encryption-unavailable" | "authority-changed",
    message: string,
  ) {
    super(message);
    this.name = "ManagedSuspensionSourceError";
  }
}

/** Decrypt the exact server-selected source with the current grant. No native
 * process or fallback home may be selected before this actual operation. */
export async function openManagedSuspensionSource(input: {
  store: Pick<NativeSuspensionStore, "open">;
  session: ManagedSessionContext;
  threadId: string | null;
  modelRouteId: string | null;
  providerAccountId: string | null;
}) {
  const expected = input.session.heldSuspension;
  if (!expected) return null;
  let opened: Awaited<ReturnType<NativeSuspensionStore["open"]>>;
  try {
    opened = await input.store.open(expected.storageId, {
      chatId: input.session.chatId,
      threadId: input.threadId,
      contextKind: input.session.contextKind,
      projectId: input.session.projectId,
      placementId:
        input.session.contextKind === "project"
          ? input.session.worktreeId
          : input.session.scratchRootId,
      modelRouteId: input.modelRouteId,
      providerAccountId: input.providerAccountId,
    });
  } catch (error) {
    if (error instanceof WorkerEncryptionError)
      throw new ManagedSuspensionSourceError(
        "encryption-unavailable",
        "This suspended chat needs a current chat-content encryption grant.",
      );
    throw new ManagedSuspensionSourceError(
      "storage-unavailable",
      (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? "The saved suspension source is missing from this worker."
        : "The saved suspension source could not be opened for this chat.",
    );
  }
  if (
    // Version/fingerprint strings are diagnostic. Native restoration decides
    // compatibility; only the committed checkpoint identity correlates here.
    opened.evidence.storageId !== expected.storageId ||
    !isDeepStrictEqual(opened.evidence.suspension, expected.suspension) ||
    opened.source.threadId !== expected.suspension.threadId ||
    input.threadId !== expected.suspension.threadId
  )
    throw new ManagedSuspensionSourceError(
      "authority-changed",
      "The saved suspension source belongs to a different native attachment.",
    );
  return opened;
}

/** Private worker-only namespace. Its home is obtained from authenticated
 * ciphertext, never from a path transported by a client or server command. */
export function managedSuspensionNamespace(
  source: NonNullable<Awaited<ReturnType<typeof openManagedSuspensionSource>>>,
) {
  return {
    operationId: `suspension:${createHash("sha256")
      .update(
        JSON.stringify([
          source.home,
          source.source.chatId,
          source.source.threadId,
          source.evidence.suspension.checkpointId,
        ]),
      )
      .digest("hex")}`,
    home: source.home,
  };
}
