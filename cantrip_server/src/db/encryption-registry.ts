import { randomUUID } from "node:crypto";

import type {
  AccountPasswordEncryptionChange,
  AccountEncryptionProfile,
  AccountEncryptionProfileInitialize,
  AccountEncryptionProfileInitializeResult,
  EncryptionKeyGrant,
  EncryptionKeyGrantCreate,
  EncryptionPrincipal,
  EncryptionPrincipalCreate,
  EncryptionProfileMigrationUpdate,
  EncryptionRevocation,
} from "@cantrip/protocol/encryption";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";

import * as schema from "./schema.js";
import type { RepositoryDatabase } from "./repository.js";

type PrincipalAccessResult =
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "ok"; grants: EncryptionKeyGrant[] };

type GrantCreateResult =
  | { status: "created"; grant: EncryptionKeyGrant }
  | { status: "conflict" | "missing" | "unavailable" | "wrapper-mismatch" };

function toProfile(
  row: typeof schema.accountEncryptionProfiles.$inferSelect,
): AccountEncryptionProfile {
  return {
    ownerId: row.ownerId,
    formatVersion: 1,
    activeMasterKeyRevision: row.activeMasterKeyRevision,
    passwordKdf: row.passwordKdf,
    passwordWrappedMasterKey: row.passwordWrappedMasterKey,
    initializationStatus: "initialized",
    payloadMigrationStatus:
      row.payloadMigrationStatus as AccountEncryptionProfile["payloadMigrationStatus"],
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPrincipal(
  row: typeof schema.encryptionPrincipals.$inferSelect,
): EncryptionPrincipal {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind as EncryptionPrincipal["kind"],
    workerId: row.workerId,
    label: row.label,
    publicKey: row.publicKey,
    state: row.state as EncryptionPrincipal["state"],
    revision: row.revision,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toGrant(
  row: typeof schema.encryptionKeyGrants.$inferSelect,
): EncryptionKeyGrant {
  return {
    id: row.id,
    ownerId: row.ownerId,
    principalId: row.principalId,
    component: row.component,
    keyRevision: row.keyRevision,
    wrappedKey: row.wrappedKey,
    state: row.state as EncryptionKeyGrant["state"],
    revision: row.revision,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function wrapperMatchesPrincipal(
  principal: typeof schema.encryptionPrincipals.$inferSelect,
  input: EncryptionKeyGrantCreate,
  activeMasterKeyRevision: number | null,
): boolean {
  if (
    principal.kind === "client" &&
    input.wrappedKey.purpose === "client-account-master-key"
  ) {
    return (
      input.component === "account-master-key" &&
      input.wrappedKey.clientId === principal.id &&
      input.wrappedKey.masterKeyRevision === input.keyRevision &&
      input.keyRevision === activeMasterKeyRevision
    );
  }
  if (
    principal.kind === "worker" &&
    principal.workerId &&
    input.wrappedKey.purpose === "worker-component-key"
  ) {
    return (
      input.component !== "account-master-key" &&
      input.wrappedKey.workerId === principal.workerId &&
      input.wrappedKey.component === input.component &&
      input.wrappedKey.keyRevision === input.keyRevision
    );
  }
  return false;
}

export class EncryptionRegistryRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async getProfile(ownerId: string): Promise<AccountEncryptionProfile | null> {
    const rows = await this.database
      .select()
      .from(schema.accountEncryptionProfiles)
      .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
      .limit(1);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async initializeProfile(
    ownerId: string,
    input: AccountEncryptionProfileInitialize,
  ): Promise<AccountEncryptionProfileInitializeResult> {
    const now = new Date();
    const created = await this.database.transaction(async (transaction) => {
      const profiles = await transaction
        .insert(schema.accountEncryptionProfiles)
        .values({
          ownerId,
          formatVersion: input.profile.formatVersion,
          activeMasterKeyRevision: input.profile.activeMasterKeyRevision,
          passwordKdf: input.profile.passwordKdf,
          passwordWrappedMasterKey: input.profile.passwordWrappedMasterKey,
          initializationStatus: "initialized",
          payloadMigrationStatus: input.profile.payloadMigrationStatus,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: schema.accountEncryptionProfiles.ownerId,
        })
        .returning();
      const profile = profiles[0];
      if (!profile) return null;

      const principals = await transaction
        .insert(schema.encryptionPrincipals)
        .values({
          id: input.initialClient.id,
          ownerId,
          kind: "client",
          workerId: null,
          label: input.initialClient.label,
          publicKey: input.initialClient.publicKey,
          state: "approved",
          revision: 1,
          approvedAt: now,
          revokedAt: null,
          revokedReason: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const principal = principals[0];
      if (!principal)
        throw new Error("Initial encryption principal was not created.");

      const grants = await transaction
        .insert(schema.encryptionKeyGrants)
        .values({
          id: randomUUID(),
          ownerId,
          principalId: principal.id,
          component: "account-master-key",
          keyRevision: input.profile.activeMasterKeyRevision,
          wrappedKey: input.initialClient.wrappedMasterKey,
          state: "active",
          revision: 1,
          revokedAt: null,
          revokedReason: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const grant = grants[0];
      if (!grant) throw new Error("Initial encryption grant was not created.");

      return {
        profile: toProfile(profile),
        principal: toPrincipal(principal),
        grant: toGrant(grant),
      };
    });

    if (created) return { created: true, ...created };
    const existing = await this.getProfile(ownerId);
    if (!existing) {
      throw new Error(
        "Encryption profile initialization did not become visible.",
      );
    }
    return { created: false, profile: existing };
  }

  async updateMigrationStatus(
    ownerId: string,
    input: EncryptionProfileMigrationUpdate,
  ): Promise<AccountEncryptionProfile | null> {
    const rows = await this.database
      .update(schema.accountEncryptionProfiles)
      .set({
        payloadMigrationStatus: input.payloadMigrationStatus,
        revision: sql`${schema.accountEncryptionProfiles.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.accountEncryptionProfiles.ownerId, ownerId),
          eq(schema.accountEncryptionProfiles.revision, input.expectedRevision),
        ),
      )
      .returning();
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async changeAccountPassword(
    ownerId: string,
    input: Pick<
      AccountPasswordEncryptionChange,
      "expectedProfileRevision" | "passwordKdf" | "passwordWrappedMasterKey"
    >,
    passwordHash: string,
  ): Promise<AccountEncryptionProfile | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const profiles = await transaction
        .select()
        .from(schema.accountEncryptionProfiles)
        .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
        .for("update")
        .limit(1);
      const profile = profiles[0];
      if (
        !profile ||
        profile.revision !== input.expectedProfileRevision ||
        input.passwordWrappedMasterKey.masterKeyRevision !==
          profile.activeMasterKeyRevision
      ) {
        return null;
      }

      const users = await transaction
        .update(schema.users)
        .set({
          passwordHash,
          passwordChangedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.users.id, ownerId),
            eq(schema.users.kind, "account"),
            eq(schema.users.status, "active"),
          ),
        )
        .returning({ id: schema.users.id });
      if (!users[0]) return null;

      const updated = await transaction
        .update(schema.accountEncryptionProfiles)
        .set({
          passwordKdf: input.passwordKdf,
          passwordWrappedMasterKey: input.passwordWrappedMasterKey,
          revision: sql`${schema.accountEncryptionProfiles.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.accountEncryptionProfiles.ownerId, ownerId),
            eq(
              schema.accountEncryptionProfiles.revision,
              input.expectedProfileRevision,
            ),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new Error("Atomic password-wrapper update did not complete.");
      }
      return toProfile(updated[0]);
    });
  }

  async listPrincipals(ownerId: string): Promise<EncryptionPrincipal[]> {
    const rows = await this.database
      .select()
      .from(schema.encryptionPrincipals)
      .where(eq(schema.encryptionPrincipals.ownerId, ownerId))
      .orderBy(
        asc(schema.encryptionPrincipals.createdAt),
        asc(schema.encryptionPrincipals.id),
      );
    return rows.map(toPrincipal);
  }

  async createPrincipal(
    ownerId: string,
    input: EncryptionPrincipalCreate,
  ): Promise<EncryptionPrincipal | null> {
    const profiles = await this.database
      .select({ ownerId: schema.accountEncryptionProfiles.ownerId })
      .from(schema.accountEncryptionProfiles)
      .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
      .limit(1);
    if (!profiles[0]) return null;
    if (input.kind === "worker") {
      const now = new Date();
      const workers = await this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .innerJoin(
          schema.workerCredentials,
          and(
            eq(schema.workerCredentials.workerId, schema.workers.id),
            eq(schema.workerCredentials.ownerId, schema.workers.ownerId),
          ),
        )
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
            isNull(schema.workerCredentials.revokedAt),
            or(
              isNull(schema.workerCredentials.expiresAt),
              gt(schema.workerCredentials.expiresAt, now),
            ),
          ),
        )
        .limit(1);
      if (!workers[0]) return null;
    }
    const rows = await this.database
      .insert(schema.encryptionPrincipals)
      .values({
        id: input.id,
        ownerId,
        kind: input.kind,
        workerId: input.kind === "worker" ? input.workerId : null,
        label: input.label,
        publicKey: input.publicKey,
        state: "pending",
        revision: 1,
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async approvePrincipal(
    ownerId: string,
    principalId: string,
    expectedRevision: number,
  ): Promise<EncryptionPrincipal | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.encryptionPrincipals)
      .set({
        state: "approved",
        approvedAt: now,
        revision: sql`${schema.encryptionPrincipals.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.encryptionPrincipals.id, principalId),
          eq(schema.encryptionPrincipals.ownerId, ownerId),
          eq(schema.encryptionPrincipals.state, "pending"),
          eq(schema.encryptionPrincipals.revision, expectedRevision),
        ),
      )
      .returning();
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async revokePrincipal(
    ownerId: string,
    principalId: string,
    input: EncryptionRevocation,
  ): Promise<EncryptionPrincipal | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const principals = await transaction
        .update(schema.encryptionPrincipals)
        .set({
          state: "revoked",
          revokedAt: now,
          revokedReason: input.reason,
          revision: sql`${schema.encryptionPrincipals.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.encryptionPrincipals.id, principalId),
            eq(schema.encryptionPrincipals.ownerId, ownerId),
            eq(schema.encryptionPrincipals.revision, input.expectedRevision),
            sql`${schema.encryptionPrincipals.state} <> 'revoked'`,
          ),
        )
        .returning();
      const principal = principals[0];
      if (!principal) return null;
      await transaction
        .update(schema.encryptionKeyGrants)
        .set({
          state: "revoked",
          revokedAt: now,
          revokedReason: "principal revoked",
          revision: sql`${schema.encryptionKeyGrants.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.encryptionKeyGrants.ownerId, ownerId),
            eq(schema.encryptionKeyGrants.principalId, principalId),
            eq(schema.encryptionKeyGrants.state, "active"),
          ),
        );
      return toPrincipal(principal);
    });
  }

  async listActiveGrants(
    ownerId: string,
    principalId: string,
  ): Promise<PrincipalAccessResult> {
    const principals = await this.database
      .select({ state: schema.encryptionPrincipals.state })
      .from(schema.encryptionPrincipals)
      .where(
        and(
          eq(schema.encryptionPrincipals.id, principalId),
          eq(schema.encryptionPrincipals.ownerId, ownerId),
        ),
      )
      .limit(1);
    const principal = principals[0];
    if (!principal) return { status: "missing" };
    if (principal.state !== "approved") return { status: "unavailable" };
    const rows = await this.database
      .select()
      .from(schema.encryptionKeyGrants)
      .where(
        and(
          eq(schema.encryptionKeyGrants.ownerId, ownerId),
          eq(schema.encryptionKeyGrants.principalId, principalId),
          eq(schema.encryptionKeyGrants.state, "active"),
        ),
      )
      .orderBy(
        asc(schema.encryptionKeyGrants.component),
        asc(schema.encryptionKeyGrants.keyRevision),
      );
    return { status: "ok", grants: rows.map(toGrant) };
  }

  async createGrant(
    ownerId: string,
    principalId: string,
    input: EncryptionKeyGrantCreate,
  ): Promise<GrantCreateResult> {
    return this.database.transaction(async (transaction) => {
      const principals = await transaction
        .select()
        .from(schema.encryptionPrincipals)
        .where(
          and(
            eq(schema.encryptionPrincipals.id, principalId),
            eq(schema.encryptionPrincipals.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const principal = principals[0];
      if (!principal) return { status: "missing" };
      if (principal.state !== "approved") return { status: "unavailable" };
      const profiles = await transaction
        .select({
          activeMasterKeyRevision:
            schema.accountEncryptionProfiles.activeMasterKeyRevision,
        })
        .from(schema.accountEncryptionProfiles)
        .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
        .limit(1);
      const profile = profiles[0];
      if (!profile) return { status: "missing" };
      if (
        !wrapperMatchesPrincipal(
          principal,
          input,
          profile.activeMasterKeyRevision,
        )
      ) {
        return { status: "wrapper-mismatch" };
      }
      const rows = await transaction
        .insert(schema.encryptionKeyGrants)
        .values({
          id: randomUUID(),
          ownerId,
          principalId,
          component: input.component,
          keyRevision: input.keyRevision,
          wrappedKey: input.wrappedKey,
          state: "active",
          revision: 1,
        })
        .onConflictDoNothing()
        .returning();
      return rows[0]
        ? { status: "created", grant: toGrant(rows[0]) }
        : { status: "conflict" };
    });
  }

  async revokeGrant(
    ownerId: string,
    grantId: string,
    input: EncryptionRevocation,
  ): Promise<EncryptionKeyGrant | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.encryptionKeyGrants)
      .set({
        state: "revoked",
        revokedAt: now,
        revokedReason: input.reason,
        revision: sql`${schema.encryptionKeyGrants.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.encryptionKeyGrants.id, grantId),
          eq(schema.encryptionKeyGrants.ownerId, ownerId),
          eq(schema.encryptionKeyGrants.state, "active"),
          eq(schema.encryptionKeyGrants.revision, input.expectedRevision),
        ),
      )
      .returning();
    return rows[0] ? toGrant(rows[0]) : null;
  }
}
