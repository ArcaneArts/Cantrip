import { createHash } from "node:crypto";

import {
  workerEncryptionMaterialFingerprint,
  type WorkerEncryptionStatus,
} from "@cantrip/protocol";

export interface VerifiedCodePrewarmIdentity {
  ownerId: string;
  serverId: string;
}

export function createCoalescingCodePrewarmScheduler<TTrigger>(input: {
  fingerprint?: (trigger: TTrigger) => string | null;
  onError: (error: unknown, trigger: TTrigger) => void;
  run: (trigger: TTrigger) => Promise<void>;
}): (trigger: TTrigger) => void {
  let active:
    { fingerprint: string | null; promise: Promise<void> } | undefined;
  let completedFingerprint: string | null = null;
  let queued: { fingerprint: string | null; trigger: TTrigger } | undefined;

  const schedule = (trigger: TTrigger) => {
    const fingerprint = input.fingerprint?.(trigger) ?? null;
    if (input.fingerprint && fingerprint === null) return;
    if (active) {
      if (fingerprint !== null && fingerprint === active.fingerprint) {
        queued = undefined;
        return;
      }
      queued = { fingerprint, trigger };
      return;
    }
    if (fingerprint !== null && fingerprint === completedFingerprint) return;

    const promise = input
      .run(trigger)
      .then(() => {
        if (fingerprint !== null) completedFingerprint = fingerprint;
      })
      .catch((error) => input.onError(error, trigger))
      .finally(() => {
        if (active?.promise !== promise) return;
        active = undefined;
        const next = queued;
        queued = undefined;
        if (next) schedule(next.trigger);
      });
    active = { fingerprint, promise };
  };

  return schedule;
}

export function codePrewarmEncryptionFingerprint(input: {
  identity: VerifiedCodePrewarmIdentity;
  status: WorkerEncryptionStatus;
}): string | null {
  if (input.status.state !== "ready") return null;
  if (!input.identity.ownerId || !input.identity.serverId) return null;
  return JSON.stringify([
    input.identity.ownerId,
    input.identity.serverId,
    workerEncryptionMaterialFingerprint(input.status),
  ]);
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
