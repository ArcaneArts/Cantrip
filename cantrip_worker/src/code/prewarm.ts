import { createHash } from "node:crypto";

import type { WorkerEncryptionStatus } from "@cantrip/protocol";

export interface VerifiedCodePrewarmIdentity {
  ownerId: string;
  serverId: string;
}

export function ownerScopedCodeProfileId(
  ownerId: string,
  profileId: string,
): string {
  // This must remain byte-for-byte compatible with the server's
  // scopedCodeProfileId derivation.
  return createHash("sha256").update(`${ownerId}\0${profileId}`).digest("hex");
}

/**
 * Schedules the one bounded profile used by Explorer editors after any
 * successful encryption refresh. The supervisor owns launch deduplication and
 * lifecycle serialization; this boundary absorbs the background rejection so
 * refresh and shutdown paths cannot create an unhandled promise.
 */
export async function prewarmDefaultCodeProfileAfterEncryptionRefresh(input: {
  identity: VerifiedCodePrewarmIdentity;
  prewarmProfile: (profileId: string) => Promise<void>;
  status: WorkerEncryptionStatus;
}): Promise<void> {
  if (input.status.state !== "ready") return;
  if (!input.identity.ownerId || !input.identity.serverId) return;
  await input
    .prewarmProfile(ownerScopedCodeProfileId(input.identity.ownerId, "default"))
    .catch(() => undefined);
}
