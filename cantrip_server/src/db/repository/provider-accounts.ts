import type {
  EncryptedModelProviderAccountCreate,
  EncryptedModelProviderAccountUpdate,
  ModelProviderAccountWireSummary,
  OrderedIds,
  ProviderModelAvailability,
} from "@cantrip/protocol";
import type {
  ProtectedProviderCredential,
  ProviderCredentialPublicMetadata,
} from "@cantrip/protocol/protected-secrets";
import { and, asc, desc, eq, exists, inArray } from "drizzle-orm";

import {
  accountProviderLabel,
  isAccountProviderKind,
} from "../../models/account-provider.js";
import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export interface ModelProviderAccountRuntime {
  accountId: string;
  credentialState: ModelProviderAccountWireSummary["credentialState"];
  credentialHomeKey: string;
  enabled: boolean;
  legacyWorkerAuthenticated: boolean;
  modelAvailability: ProviderModelAvailability["state"] | null;
  position: number;
  weeklyUsageUsedPercent: number | null;
}

export type ProviderAccountCredentialState =
  | "signed-out"
  | "migration-needed"
  | "signed-in"
  | "reauth-required"
  | "conflict";

export interface ProviderAccountCredentialRecord {
  accountId: string;
  credential: ProtectedProviderCredential;
  metadata: ProviderCredentialPublicMetadata;
  providerKind: "chatgpt" | "grok";
  providerId: string;
  revision: number;
  state: ProviderAccountCredentialState;
  updatedAt: string | null;
}

export interface ProviderAccountCredentialSignOutRecord {
  revision: number;
}

export interface ProviderAccountCredentialMigrationRecord {
  accountId: string;
  credentialHomeKey: string;
  providerId: string;
  providerKind: "chatgpt" | "grok";
  revision: number;
  state: ProviderAccountCredentialState;
  subjectBlindIndex: string | null;
}

export class ProviderCredentialIdentityConflictError extends Error {
  constructor() {
    super("The provider account identity does not match the stored identity.");
    this.name = "ProviderCredentialIdentityConflictError";
  }
}

export class ProviderCredentialRevisionConflictError extends Error {
  constructor() {
    super("The provider account credential changed before it could be saved.");
    this.name = "ProviderCredentialRevisionConflictError";
  }
}

export function toProviderAccountSummary(
  account: typeof schema.modelProviderAccounts.$inferSelect,
  workerBindings: Array<
    typeof schema.modelProviderAccountWorkers.$inferSelect
  > = [],
): ModelProviderAccountWireSummary {
  return {
    id: account.id,
    providerId: account.providerId,
    protectedLabel: account.protectedLabel,
    planType: account.planType,
    position: account.position,
    enabled: account.enabled,
    credentialState:
      account.credentialState as ModelProviderAccountWireSummary["credentialState"],
    weeklyUsageUsedPercent:
      account.weeklyUsageUsedBasisPoints === null
        ? null
        : account.weeklyUsageUsedBasisPoints / 100,
    weeklyUsageResetsAt: account.weeklyUsageResetsAt
      ? toISOString(account.weeklyUsageResetsAt)
      : null,
    authLastSyncedAt: account.authLastSyncedAt
      ? toISOString(account.authLastSyncedAt)
      : null,
    workerBindings: workerBindings.map((binding) => ({
      workerId: binding.workerId,
      authState:
        binding.authState as ModelProviderAccountWireSummary["workerBindings"][number]["authState"],
      weeklyUsageUsedPercent:
        binding.weeklyUsageUsedBasisPoints === null
          ? null
          : binding.weeklyUsageUsedBasisPoints / 100,
      weeklyUsageResetsAt: binding.weeklyUsageResetsAt
        ? toISOString(binding.weeklyUsageResetsAt)
        : null,
      lastSyncedAt: binding.lastSyncedAt
        ? toISOString(binding.lastSyncedAt)
        : null,
    })),
    createdAt: toISOString(account.createdAt),
    updatedAt: toISOString(account.updatedAt),
  };
}

export class ProviderAccountRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listModelProviderAccounts(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderAccountWireSummary[] | null> {
    const provider = await this.database
      .select({
        id: schema.modelProviders.id,
        kind: schema.modelProviders.kind,
      })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!provider[0] || !isAccountProviderKind(provider[0].kind)) return null;
    const [accounts, bindings] = await Promise.all([
      this.database
        .select()
        .from(schema.modelProviderAccounts)
        .where(eq(schema.modelProviderAccounts.providerId, providerId))
        .orderBy(asc(schema.modelProviderAccounts.position)),
      this.database
        .select({ binding: schema.modelProviderAccountWorkers })
        .from(schema.modelProviderAccountWorkers)
        .innerJoin(
          schema.modelProviderAccounts,
          and(
            eq(
              schema.modelProviderAccounts.id,
              schema.modelProviderAccountWorkers.accountId,
            ),
            eq(schema.modelProviderAccounts.providerId, providerId),
          ),
        ),
    ]);
    return accounts.map((account) =>
      toProviderAccountSummary(
        account,
        bindings
          .filter(({ binding }) => binding.accountId === account.id)
          .map(({ binding }) => binding),
      ),
    );
  }

  async getModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialRecord | null> {
    const rows = await this.database
      .select({
        account: schema.modelProviderAccounts,
        kind: schema.modelProviders.kind,
        ownerId: schema.modelProviders.ownerId,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(
        and(
          eq(schema.modelProviderAccounts.id, accountId),
          eq(schema.modelProviderAccounts.providerId, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
          inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.account.protectedCredential || !isAccountProviderKind(row.kind)) {
      return null;
    }
    return {
      accountId,
      credential: {
        subjectBlindIndex: row.account.credentialSubjectBlindIndex!,
        protectedCredential: row.account.protectedCredential,
      },
      metadata: {
        expiresAt: row.account.credentialExpiresAt?.toISOString() ?? null,
      },
      providerId,
      providerKind: row.kind,
      revision: row.account.credentialRevision,
      state: row.account.credentialState as ProviderAccountCredentialState,
      updatedAt: row.account.credentialUpdatedAt
        ? toISOString(row.account.credentialUpdatedAt)
        : null,
    };
  }

  async listModelProviderAccountCredentialMigrations(
    ownerId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord[]> {
    const rows = await this.database
      .select({
        accountId: schema.modelProviderAccounts.id,
        credentialHomeKey: schema.modelProviderAccounts.credentialHomeKey,
        providerId: schema.modelProviderAccounts.providerId,
        providerKind: schema.modelProviders.kind,
        revision: schema.modelProviderAccounts.credentialRevision,
        state: schema.modelProviderAccounts.credentialState,
        subjectBlindIndex:
          schema.modelProviderAccounts.credentialSubjectBlindIndex,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          inArray(schema.modelProviderAccounts.credentialState, [
            "migration-needed",
            "signed-in",
          ]),
        ),
      )
      .orderBy(
        asc(schema.modelProviders.createdAt),
        asc(schema.modelProviderAccounts.position),
      );
    return rows.flatMap((row) =>
      isAccountProviderKind(row.providerKind) &&
      (row.state === "migration-needed" || row.state === "signed-in")
        ? [
            {
              ...row,
              providerKind: row.providerKind,
              state: row.state,
            },
          ]
        : [],
    );
  }

  async getModelProviderAccountCredentialMigration(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord | null> {
    const rows = await this.database
      .select({
        accountId: schema.modelProviderAccounts.id,
        credentialHomeKey: schema.modelProviderAccounts.credentialHomeKey,
        providerId: schema.modelProviderAccounts.providerId,
        providerKind: schema.modelProviders.kind,
        revision: schema.modelProviderAccounts.credentialRevision,
        state: schema.modelProviderAccounts.credentialState,
        subjectBlindIndex:
          schema.modelProviderAccounts.credentialSubjectBlindIndex,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviderAccounts.id, accountId),
          inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !isAccountProviderKind(row.providerKind)) return null;
    return {
      ...row,
      providerKind: row.providerKind,
      state: row.state as ProviderAccountCredentialState,
    };
  }

  async storeModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: ProtectedProviderCredential,
    metadata: ProviderCredentialPublicMetadata,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          account: schema.modelProviderAccounts,
          kind: schema.modelProviders.kind,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
        )
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || !isAccountProviderKind(row.kind)) return null;
      if (
        row.account.credentialSubjectBlindIndex &&
        row.account.credentialSubjectBlindIndex !== input.subjectBlindIndex
      ) {
        throw new ProviderCredentialIdentityConflictError();
      }
      if (
        expectedRevision !== undefined &&
        row.account.credentialRevision !== expectedRevision
      ) {
        throw new ProviderCredentialRevisionConflictError();
      }

      const revision = row.account.credentialRevision + 1;
      const updatedAt = new Date();
      const updated = await transaction
        .update(schema.modelProviderAccounts)
        .set({
          protectedCredential: input.protectedCredential,
          credentialRevision: revision,
          credentialState: "signed-in",
          credentialSubjectBlindIndex: input.subjectBlindIndex,
          credentialExpiresAt: metadata.expiresAt
            ? new Date(metadata.expiresAt)
            : null,
          credentialUpdatedAt: updatedAt,
          credentialLastRefreshAt: updatedAt,
          credentialRefreshLeaseId: null,
          credentialRefreshLeaseExpiresAt: null,
          authLastSyncedAt: updatedAt,
          updatedAt,
        })
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(
              schema.modelProviderAccounts.credentialRevision,
              row.account.credentialRevision,
            ),
          ),
        )
        .returning({
          revision: schema.modelProviderAccounts.credentialRevision,
        });
      if (!updated[0]) throw new ProviderCredentialRevisionConflictError();
      return {
        accountId,
        credential: input,
        metadata,
        providerId,
        providerKind: row.kind,
        revision,
        state: "signed-in",
        updatedAt: toISOString(updatedAt),
      };
    });
  }

  async updateModelProviderAccountCredentialState(input: {
    accountId: string;
    expectedRevision: number;
    ownerId: string;
    providerId: string;
    state: Extract<
      ProviderAccountCredentialState,
      "reauth-required" | "conflict"
    >;
  }): Promise<boolean> {
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({ credentialState: input.state, updatedAt: new Date() })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.accountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
          eq(
            schema.modelProviderAccounts.credentialRevision,
            input.expectedRevision,
          ),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, input.providerId),
                  eq(schema.modelProviders.ownerId, input.ownerId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  async clearModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    return Boolean(
      await this.takeModelProviderAccountCredentialForSignOut(
        ownerId,
        providerId,
        accountId,
        expectedRevision,
      ),
    );
  }

  async takeModelProviderAccountCredentialForSignOut(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialSignOutRecord | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          account: schema.modelProviderAccounts,
          kind: schema.modelProviders.kind,
          ownerId: schema.modelProviders.ownerId,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
        )
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        )
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row || !isAccountProviderKind(row.kind)) return null;
      if (
        expectedRevision !== undefined &&
        row.account.credentialRevision !== expectedRevision
      ) {
        throw new ProviderCredentialRevisionConflictError();
      }
      const now = new Date();
      const updated = await transaction
        .update(schema.modelProviderAccounts)
        .set({
          protectedCredential: null,
          credentialRevision: row.account.credentialRevision + 1,
          credentialState: "signed-out",
          credentialSubjectBlindIndex: null,
          credentialExpiresAt: null,
          credentialUpdatedAt: now,
          credentialRefreshLeaseId: null,
          credentialRefreshLeaseExpiresAt: null,
          planType: null,
          weeklyUsageUsedBasisPoints: null,
          weeklyUsageResetsAt: null,
          authLastSyncedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(
              schema.modelProviderAccounts.credentialRevision,
              row.account.credentialRevision,
            ),
          ),
        )
        .returning({ id: schema.modelProviderAccounts.id });
      if (!updated[0]) throw new ProviderCredentialRevisionConflictError();
      await transaction
        .update(schema.modelProviderAccountWorkers)
        .set({
          authState: "signed-out",
          weeklyUsageUsedBasisPoints: null,
          weeklyUsageResetsAt: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.modelProviderAccountWorkers.accountId, accountId));
      return { revision: row.account.credentialRevision + 1 };
    });
  }

  async createModelProviderAccount(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderAccountCreate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.database.transaction(async (transaction) => {
      const provider = await transaction
        .select({ kind: schema.modelProviders.kind })
        .from(schema.modelProviders)
        .where(
          and(
            eq(schema.modelProviders.id, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!provider[0] || !isAccountProviderKind(provider[0].kind)) return null;
      const positions = await transaction
        .select({ position: schema.modelProviderAccounts.position })
        .from(schema.modelProviderAccounts)
        .where(eq(schema.modelProviderAccounts.providerId, providerId))
        .orderBy(desc(schema.modelProviderAccounts.position))
        .limit(1);
      const accountId = input.id;
      const rows = await transaction
        .insert(schema.modelProviderAccounts)
        .values({
          id: accountId,
          providerId,
          protectedLabel: input.protectedLabel,
          position: (positions[0]?.position ?? -1) + 1,
          credentialHomeKey: accountId,
        })
        .returning();
      return toProviderAccountSummary(
        firstOrThrow(
          rows,
          `creating a ${accountProviderLabel(provider[0].kind)} account`,
        ),
      );
    });
  }

  async updateModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: EncryptedModelProviderAccountUpdate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({
        ...(input.protectedLabel === undefined
          ? {}
          : { protectedLabel: input.protectedLabel }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, accountId),
          eq(schema.modelProviderAccounts.providerId, providerId),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, providerId),
                  eq(schema.modelProviders.ownerId, ownerId),
                  inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
                ),
              ),
          ),
        ),
      )
      .returning();
    return rows[0] ? toProviderAccountSummary(rows[0]) : null;
  }

  async reorderModelProviderAccounts(
    ownerId: string,
    providerId: string,
    input: OrderedIds,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const accounts = await transaction
        .select({
          id: schema.modelProviderAccounts.id,
          position: schema.modelProviderAccounts.position,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
        )
        .where(
          and(
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        );
      if (
        accounts.length !== input.ids.length ||
        accounts.some(({ id }) => !input.ids.includes(id))
      ) {
        return false;
      }
      const updatedAt = new Date();
      const temporaryOffset =
        Math.max(
          accounts.length - 1,
          ...accounts.map(({ position }) => position),
        ) + 1;
      // Vacate the unique provider/position range before assigning the final
      // order so swaps never collide midway through the transaction.
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.modelProviderAccounts)
          .set({ position: temporaryOffset + position, updatedAt })
          .where(
            and(
              eq(schema.modelProviderAccounts.id, id),
              eq(schema.modelProviderAccounts.providerId, providerId),
            ),
          );
      }
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.modelProviderAccounts)
          .set({ position, updatedAt })
          .where(
            and(
              eq(schema.modelProviderAccounts.id, id),
              eq(schema.modelProviderAccounts.providerId, providerId),
            ),
          );
      }
      return true;
    });
  }

  async deleteModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .delete(schema.modelProviderAccounts)
      .where(
        and(
          eq(schema.modelProviderAccounts.id, accountId),
          eq(schema.modelProviderAccounts.providerId, providerId),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, providerId),
                  eq(schema.modelProviders.ownerId, ownerId),
                  inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  async getModelProviderAccountRuntime(
    ownerId: string,
    providerId: string,
    accountId?: string,
  ): Promise<{
    accountId: string;
    credentialHomeKey: string;
  } | null> {
    const filters = [
      eq(schema.modelProviderAccounts.providerId, providerId),
      eq(schema.modelProviders.ownerId, ownerId),
      inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
      ...(accountId
        ? [eq(schema.modelProviderAccounts.id, accountId)]
        : [eq(schema.modelProviderAccounts.enabled, true)]),
    ];
    const rows = await this.database
      .select({
        accountId: schema.modelProviderAccounts.id,
        credentialHomeKey: schema.modelProviderAccounts.credentialHomeKey,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(and(...filters))
      .orderBy(asc(schema.modelProviderAccounts.position))
      .limit(1);
    return rows[0] ?? null;
  }

  async recordModelProviderAccountStatus(
    accountId: string,
    workerId: string,
    status: {
      authenticated: boolean;
      email: string | null;
      planType: string | null;
      weeklyUsage: { usedPercent: number; resetsAt: number | null } | null;
    },
  ): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.modelProviderAccounts)
        .set({
          ...(status.weeklyUsage
            ? {
                ...(status.planType ? { planType: status.planType } : {}),
                weeklyUsageUsedBasisPoints: Math.round(
                  status.weeklyUsage.usedPercent * 100,
                ),
                weeklyUsageResetsAt: status.weeklyUsage.resetsAt
                  ? new Date(status.weeklyUsage.resetsAt * 1_000)
                  : null,
                weeklyUsageObservedAt: now,
              }
            : {}),
          authLastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.modelProviderAccounts.id, accountId));
      await transaction
        .insert(schema.modelProviderAccountWorkers)
        .values({
          accountId,
          workerId,
          authState: status.authenticated ? "signed-in" : "signed-out",
          weeklyUsageUsedBasisPoints: status.weeklyUsage
            ? Math.round(status.weeklyUsage.usedPercent * 100)
            : null,
          weeklyUsageResetsAt: status.weeklyUsage?.resetsAt
            ? new Date(status.weeklyUsage.resetsAt * 1_000)
            : null,
          weeklyUsageObservedAt: status.weeklyUsage ? now : null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.modelProviderAccountWorkers.accountId,
            schema.modelProviderAccountWorkers.workerId,
          ],
          set: {
            authState: status.authenticated ? "signed-in" : "signed-out",
            weeklyUsageUsedBasisPoints: status.weeklyUsage
              ? Math.round(status.weeklyUsage.usedPercent * 100)
              : null,
            weeklyUsageResetsAt: status.weeklyUsage?.resetsAt
              ? new Date(status.weeklyUsage.resetsAt * 1_000)
              : null,
            ...(status.weeklyUsage ? { weeklyUsageObservedAt: now } : {}),
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
    });
  }

  async recordModelProviderAccountUsage(input: {
    accountId: string;
    ownerId: string;
    planType: string | null;
    providerId: string;
    resetsAt: number | null;
    usedPercent: number;
  }): Promise<boolean> {
    if (!Number.isFinite(input.usedPercent)) return false;
    const now = new Date();
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({
        ...(input.planType ? { planType: input.planType } : {}),
        weeklyUsageUsedBasisPoints: Math.round(
          Math.min(100, Math.max(0, input.usedPercent)) * 100,
        ),
        weeklyUsageResetsAt: input.resetsAt
          ? new Date(input.resetsAt * 1_000)
          : null,
        weeklyUsageObservedAt: now,
        authLastSyncedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.accountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, input.providerId),
                  eq(schema.modelProviders.ownerId, input.ownerId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  /**
   * Appends one immutable quota-window reading and, when requested, advances
   * the account's cached weekly projection. Re-delivery of the same event is
   * idempotent, while independent identical observations remain distinct.
   */
}
