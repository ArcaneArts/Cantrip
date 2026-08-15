import {
  providerLegacyCredentialCaptureResultSchema,
  providerLegacyCredentialPurgeResultSchema,
} from "@cantrip/protocol";

import {
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRevisionConflictError,
  type ProviderAccountCredentialMigrationRecord,
  type ProviderAccountCredentialRecord,
  type ServerRepository,
} from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  parseProviderCredential,
  providerCredentialSubject,
  type ProviderCredentialKind,
} from "./provider-credentials.js";

export interface ProviderCredentialMigrationSummary {
  alreadyCaptured: number;
  captured: number;
  checked: number;
  conflicts: number;
  failed: number;
  malformed: number;
  missing: number;
  purged: number;
}

export interface ProviderCredentialMigrationOptions {
  purgeEnabledKinds?: ReadonlySet<ProviderCredentialKind>;
}

function emptySummary(): ProviderCredentialMigrationSummary {
  return {
    alreadyCaptured: 0,
    captured: 0,
    checked: 0,
    conflicts: 0,
    failed: 0,
    malformed: 0,
    missing: 0,
    purged: 0,
  };
}

export class ProviderCredentialMigrationCoordinator {
  readonly #purgeEnabledKinds: ReadonlySet<ProviderCredentialKind>;

  constructor(
    private readonly repository: ServerRepository,
    private readonly workers: WorkerCommandBus,
    options: ProviderCredentialMigrationOptions = {},
  ) {
    this.#purgeEnabledKinds = options.purgeEnabledKinds ?? new Set();
  }

  async migrateWorker(
    ownerId: string,
    workerId: string,
  ): Promise<ProviderCredentialMigrationSummary> {
    const summary = emptySummary();
    const candidates =
      await this.repository.listModelProviderAccountCredentialMigrations(
        ownerId,
      );
    for (const candidate of candidates) {
      summary.checked += 1;
      try {
        await this.#migrateCandidate(ownerId, workerId, candidate, summary);
      } catch {
        // The summary is intentionally the only outward-facing failure detail;
        // worker responses can contain OAuth secrets and must never be logged.
        summary.failed += 1;
      }
    }
    return summary;
  }

  async #migrateCandidate(
    ownerId: string,
    workerId: string,
    candidate: ProviderAccountCredentialMigrationRecord,
    summary: ProviderCredentialMigrationSummary,
  ): Promise<void> {
    const captured = providerLegacyCredentialCaptureResultSchema.parse(
      await this.workers.request(
        workerId,
        {
          type: "provider.auth.legacy.capture",
          providerId: candidate.providerId,
          providerKind: candidate.providerKind,
          providerAccountId: candidate.accountId,
          credentialHomeKey: candidate.credentialHomeKey,
        },
        { ownerId, timeoutMs: 15_000 },
      ),
    );
    if (captured.status === "missing") {
      summary.missing += 1;
      return;
    }
    if (captured.status === "malformed") {
      summary.malformed += 1;
      return;
    }

    const credential = parseProviderCredential(
      captured.credential,
      candidate.providerKind,
    );
    const subject = providerCredentialSubject(credential);
    let stored: ProviderAccountCredentialRecord | null = null;
    if (candidate.state === "signed-in") {
      stored = await this.repository.getModelProviderAccountCredential(
        ownerId,
        candidate.providerId,
        candidate.accountId,
      );
      if (!stored) {
        throw new Error("Provider account migration target vanished.");
      }
      if (stored.metadata.subject !== subject) {
        await this.#markConflict(ownerId, candidate, stored?.revision);
        summary.conflicts += 1;
        return;
      }
      if (stored.state !== "signed-in") {
        throw new Error("Provider account migration state changed.");
      }
      summary.alreadyCaptured += 1;
    } else {
      try {
        stored = await this.repository.storeModelProviderAccountCredential(
          ownerId,
          candidate.providerId,
          candidate.accountId,
          credential,
          candidate.revision,
        );
      } catch (error) {
        if (
          !(error instanceof ProviderCredentialRevisionConflictError) &&
          !(error instanceof ProviderCredentialIdentityConflictError)
        ) {
          throw error;
        }
        stored = await this.repository.getModelProviderAccountCredential(
          ownerId,
          candidate.providerId,
          candidate.accountId,
        );
        if (!stored) {
          throw new Error("Provider account migration target vanished.");
        }
        if (stored.metadata.subject !== subject) {
          await this.#markConflict(ownerId, candidate, stored?.revision);
          summary.conflicts += 1;
          return;
        }
        if (stored.state !== "signed-in") {
          throw new Error("Provider account migration state changed.");
        }
      }
      if (!stored)
        throw new Error("Provider account migration target vanished.");
      summary.captured += 1;
    }

    if (!this.#purgeEnabledKinds.has(candidate.providerKind)) return;
    const purged = providerLegacyCredentialPurgeResultSchema.parse(
      await this.workers.request(
        workerId,
        {
          type: "provider.auth.legacy.purge",
          providerId: candidate.providerId,
          providerKind: candidate.providerKind,
          providerAccountId: candidate.accountId,
          credentialHomeKey: candidate.credentialHomeKey,
          expectedSubject: subject,
          serverCredentialRevision: stored.revision,
        },
        { ownerId, timeoutMs: 15_000 },
      ),
    );
    if (
      purged.subject !== subject ||
      purged.serverCredentialRevision !== stored.revision
    ) {
      throw new Error(
        "Worker returned an invalid credential purge acknowledgement.",
      );
    }
    if (purged.purged) summary.purged += 1;
  }

  async #markConflict(
    ownerId: string,
    candidate: ProviderAccountCredentialMigrationRecord,
    currentRevision = candidate.revision,
  ): Promise<void> {
    const updated =
      await this.repository.updateModelProviderAccountCredentialState({
        accountId: candidate.accountId,
        expectedRevision: currentRevision,
        ownerId,
        providerId: candidate.providerId,
        state: "conflict",
      });
    if (updated) return;

    const latest = await this.repository.getModelProviderAccountCredential(
      ownerId,
      candidate.providerId,
      candidate.accountId,
    );
    if (!latest) throw new Error("Provider account migration target vanished.");
    if (latest.state === "conflict") return;
    const retried =
      await this.repository.updateModelProviderAccountCredentialState({
        accountId: candidate.accountId,
        expectedRevision: latest.revision,
        ownerId,
        providerId: candidate.providerId,
        state: "conflict",
      });
    if (!retried) throw new Error("Provider account migration state changed.");
  }
}
