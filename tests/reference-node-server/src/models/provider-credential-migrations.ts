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
import type { AccountProviderKind } from "./account-provider.js";

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

export interface ProviderCredentialAccountCaptureSummary extends ProviderCredentialMigrationSummary {
  workerLogoutRequired: boolean;
}

export interface ProviderCredentialMigrationOptions {
  purgeEnabledKinds?: ReadonlySet<AccountProviderKind>;
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
  readonly #purgeEnabledKinds: ReadonlySet<AccountProviderKind>;

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

  /** Captures one explicitly selected account after a device-code login. */
  async captureAccount(
    ownerId: string,
    workerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderCredentialAccountCaptureSummary> {
    const summary = emptySummary();
    const candidate =
      await this.repository.getModelProviderAccountCredentialMigration(
        ownerId,
        providerId,
        accountId,
      );
    if (!candidate) {
      summary.failed = 1;
      return { ...summary, workerLogoutRequired: false };
    }
    summary.checked = 1;
    try {
      const portableAuth = await this.#migrateCandidate(
        ownerId,
        workerId,
        candidate,
        summary,
      );
      return {
        ...summary,
        workerLogoutRequired: portableAuth === false,
      };
    } catch {
      // Worker OAuth payloads remain deliberately absent from outward errors.
      summary.failed = 1;
      return { ...summary, workerLogoutRequired: false };
    }
  }

  async #migrateCandidate(
    ownerId: string,
    workerId: string,
    candidate: ProviderAccountCredentialMigrationRecord,
    summary: ProviderCredentialMigrationSummary,
  ): Promise<boolean | null> {
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
      return null;
    }
    if (captured.status === "malformed") {
      summary.malformed += 1;
      return null;
    }

    const subjectBlindIndex = captured.credential.subjectBlindIndex;
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
      if (stored.credential.subjectBlindIndex !== subjectBlindIndex) {
        await this.#markConflict(ownerId, candidate, stored?.revision);
        summary.conflicts += 1;
        return null;
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
          captured.credential,
          captured.metadata,
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
        if (stored.credential.subjectBlindIndex !== subjectBlindIndex) {
          await this.#markConflict(ownerId, candidate, stored?.revision);
          summary.conflicts += 1;
          return null;
        }
        if (stored.state !== "signed-in") {
          throw new Error("Provider account migration state changed.");
        }
      }
      if (!stored)
        throw new Error("Provider account migration target vanished.");
      summary.captured += 1;
    }

    if (
      !captured.portableAuth ||
      !this.#purgeEnabledKinds.has(candidate.providerKind)
    ) {
      return captured.portableAuth;
    }
    const purged = providerLegacyCredentialPurgeResultSchema.parse(
      await this.workers.request(
        workerId,
        {
          type: "provider.auth.legacy.purge",
          providerId: candidate.providerId,
          providerKind: candidate.providerKind,
          providerAccountId: candidate.accountId,
          credentialHomeKey: candidate.credentialHomeKey,
          expectedSubjectBlindIndex: subjectBlindIndex,
          serverCredentialRevision: stored.revision,
        },
        { ownerId, timeoutMs: 15_000 },
      ),
    );
    if (
      purged.subjectBlindIndex !== subjectBlindIndex ||
      purged.serverCredentialRevision !== stored.revision
    ) {
      throw new Error(
        "Worker returned an invalid credential purge acknowledgement.",
      );
    }
    if (purged.purged) summary.purged += 1;
    return captured.portableAuth;
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
