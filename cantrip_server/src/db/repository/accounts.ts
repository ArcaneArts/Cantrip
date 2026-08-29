import { randomUUID } from "node:crypto";

import type {
  AccountLicenseWhitelistEntry,
  AccountSessionSummary,
  AuditEvent,
  AuditEventList,
  AuditEventQuery,
  UserSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";

type UserRow = typeof schema.users.$inferSelect;
export type UserSessionRow = typeof schema.userSessions.$inferSelect;
type AuditEventRow = typeof schema.auditEvents.$inferSelect;
type AccountLicenseWhitelistRow =
  typeof schema.accountLicenseWhitelist.$inferSelect;

export interface AccountCredentialRecord {
  passwordHash: string;
  user: UserSummary;
}

export interface ActiveUserSession {
  authMethod: "password" | "account-password" | "mobile-qr";
  csrfTokenHash: string;
  expiresAt: Date;
  id: string;
  user: UserSummary;
}

export interface AuditEventCreate {
  action: string;
  actorSessionId: string | null;
  actorUserId: string | null;
  ownerId: string | null;
  requestId: string | null;
  resourceId: string | null;
  resourceType: string;
  result: AuditEvent["result"];
}

export interface AccountProvisioning {
  ensureDefaultProjectWorkspace(ownerId: string): Promise<unknown>;
  ensureOwnerPolicyState(ownerId: string): Promise<void>;
}

function toUserSummary(user: UserRow): UserSummary {
  return {
    id: user.id,
    kind: user.kind as UserSummary["kind"],
    displayName: user.displayName,
    email: user.email,
    role: user.role as UserSummary["role"],
  };
}

function toAccountLicenseWhitelistEntry(
  entry: AccountLicenseWhitelistRow,
  registered: boolean,
): AccountLicenseWhitelistEntry {
  return {
    id: entry.id,
    email: entry.email,
    registered,
    createdAt: toISOString(entry.createdAt),
  };
}

function toAuditEvent(event: AuditEventRow): AuditEvent {
  return {
    id: event.id,
    ownerId: event.ownerId,
    actor: {
      userId: event.actorUserId,
      sessionId: event.actorSessionId,
    },
    action: event.action,
    result: event.result as AuditEvent["result"],
    resource: {
      type: event.resourceType,
      id: event.resourceId,
    },
    requestId: event.requestId,
    occurredAt: toISOString(event.occurredAt),
  };
}

export class AccountRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly provisioning: AccountProvisioning,
  ) {}

  async ensureLocalIdentity(): Promise<UserSummary> {
    const now = new Date();
    const result = await this.database
      .insert(schema.users)
      .values({
        id: LOCAL_USER_ID,
        kind: "anonymous",
        role: "owner",
        status: "active",
        displayName: "Local User",
        email: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: { role: "owner", status: "active", updatedAt: now },
      })
      .returning();
    const user = firstOrThrow(result, "ensuring the local user");
    await this.provisioning.ensureDefaultProjectWorkspace(user.id);

    return {
      id: user.id,
      kind: "anonymous",
      displayName: user.displayName,
      email: user.email,
      role: "owner",
    };
  }

  async countAccountUsers(): Promise<number> {
    const rows = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(eq(schema.users.kind, "account"));
    return rows[0]?.count ?? 0;
  }

  async accountEmailIsWhitelisted(normalizedEmail: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.accountLicenseWhitelist.id })
      .from(schema.accountLicenseWhitelist)
      .where(
        eq(schema.accountLicenseWhitelist.normalizedEmail, normalizedEmail),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  async listAccountLicenseWhitelist(): Promise<AccountLicenseWhitelistEntry[]> {
    const rows = await this.database
      .select({
        entry: schema.accountLicenseWhitelist,
        registeredUserId: schema.users.id,
      })
      .from(schema.accountLicenseWhitelist)
      .leftJoin(
        schema.users,
        and(
          eq(schema.users.kind, "account"),
          eq(
            schema.users.normalizedEmail,
            schema.accountLicenseWhitelist.normalizedEmail,
          ),
        ),
      )
      .orderBy(
        asc(schema.accountLicenseWhitelist.createdAt),
        asc(schema.accountLicenseWhitelist.email),
      );
    return rows.map(({ entry, registeredUserId }) =>
      toAccountLicenseWhitelistEntry(entry, Boolean(registeredUserId)),
    );
  }

  async createAccountLicenseWhitelistEntry(input: {
    addedByUserId: string;
    email: string;
    normalizedEmail: string;
  }): Promise<AccountLicenseWhitelistEntry | null> {
    const rows = await this.database
      .insert(schema.accountLicenseWhitelist)
      .values({
        id: randomUUID(),
        email: input.email,
        normalizedEmail: input.normalizedEmail,
        addedByUserId: input.addedByUserId,
      })
      .onConflictDoNothing({
        target: schema.accountLicenseWhitelist.normalizedEmail,
      })
      .returning();
    const entry = rows[0];
    return entry ? toAccountLicenseWhitelistEntry(entry, false) : null;
  }

  async deleteAccountLicenseWhitelistEntry(id: string): Promise<boolean> {
    const rows = await this.database
      .delete(schema.accountLicenseWhitelist)
      .where(eq(schema.accountLicenseWhitelist.id, id))
      .returning({ id: schema.accountLicenseWhitelist.id });
    return Boolean(rows[0]);
  }

  async createAccount(input: {
    displayName: string;
    email: string;
    normalizedEmail: string;
    passwordHash: string;
    role: UserSummary["role"];
  }): Promise<UserSummary> {
    const now = new Date();
    const rows = await this.database
      .insert(schema.users)
      .values({
        id: randomUUID(),
        kind: "account",
        role: input.role,
        status: "active",
        displayName: input.displayName,
        email: input.email,
        normalizedEmail: input.normalizedEmail,
        passwordHash: input.passwordHash,
        passwordChangedAt: now,
        updatedAt: now,
      })
      .returning();
    const user = firstOrThrow(rows, "creating an account");
    await this.provisioning.ensureDefaultProjectWorkspace(user.id);
    await this.provisioning.ensureOwnerPolicyState(user.id);
    return toUserSummary(user);
  }

  async findAccountCredential(
    normalizedEmail: string,
  ): Promise<AccountCredentialRecord | null> {
    const rows = await this.database
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.kind, "account"),
          eq(schema.users.normalizedEmail, normalizedEmail),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    const user = rows[0];
    if (!user?.passwordHash) return null;
    return { passwordHash: user.passwordHash, user: toUserSummary(user) };
  }

  async findAccountCredentialById(
    ownerId: string,
  ): Promise<AccountCredentialRecord | null> {
    const rows = await this.database
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, ownerId),
          eq(schema.users.kind, "account"),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    const user = rows[0];
    if (!user?.passwordHash) return null;
    return { passwordHash: user.passwordHash, user: toUserSummary(user) };
  }

  async createUserSession(input: {
    authMethod: ActiveUserSession["authMethod"];
    csrfTokenHash: string;
    expiresAt: Date;
    label: string | null;
    tokenHash: string;
    userId: string;
  }): Promise<UserSessionRow> {
    const rows = await this.database
      .insert(schema.userSessions)
      .values({ id: randomUUID(), ...input })
      .returning();
    return firstOrThrow(rows, "creating a user session");
  }

  async getActiveUserSession(
    tokenHash: string,
  ): Promise<ActiveUserSession | null> {
    const rows = await this.database
      .select({ session: schema.userSessions, user: schema.users })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.tokenHash, tokenHash),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, new Date()),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      authMethod: row.session.authMethod as ActiveUserSession["authMethod"],
      csrfTokenHash: row.session.csrfTokenHash,
      expiresAt: row.session.expiresAt,
      id: row.session.id,
      user: toUserSummary(row.user),
    };
  }

  async createMobileSignInGrant(input: {
    codeHash: string;
    createdBySessionId: string;
    expiresAt: Date;
    ownerId: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.insert(schema.mobileSignInGrants).values({
      id,
      ownerId: input.ownerId,
      createdBySessionId: input.createdBySessionId,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    });
    return id;
  }

  async consumeMobileSignInGrant(
    codeHash: string,
  ): Promise<UserSummary | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const grants = await transaction
        .select()
        .from(schema.mobileSignInGrants)
        .where(
          and(
            eq(schema.mobileSignInGrants.codeHash, codeHash),
            isNull(schema.mobileSignInGrants.consumedAt),
            gt(schema.mobileSignInGrants.expiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      const grant = grants[0];
      if (!grant) return null;

      const creatingSessions = grant.createdBySessionId
        ? await transaction
            .select({ id: schema.userSessions.id })
            .from(schema.userSessions)
            .where(
              and(
                eq(schema.userSessions.id, grant.createdBySessionId),
                eq(schema.userSessions.userId, grant.ownerId),
                isNull(schema.userSessions.revokedAt),
                gt(schema.userSessions.expiresAt, now),
              ),
            )
            .limit(1)
        : [];
      if (!creatingSessions[0]) return null;

      const consumed = await transaction
        .update(schema.mobileSignInGrants)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.mobileSignInGrants.id, grant.id),
            isNull(schema.mobileSignInGrants.consumedAt),
          ),
        )
        .returning({ id: schema.mobileSignInGrants.id });
      if (!consumed[0]) return null;

      const users = await transaction
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.id, grant.ownerId),
            eq(schema.users.status, "active"),
          ),
        )
        .limit(1);
      return users[0] ? toUserSummary(users[0]) : null;
    });
  }

  async pruneMobileSignInGrants(before: Date): Promise<void> {
    await this.database
      .delete(schema.mobileSignInGrants)
      .where(lt(schema.mobileSignInGrants.expiresAt, before));
  }

  async isUserSessionActive(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.userSessions.id })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, new Date()),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async rotateSessionCsrfToken(
    sessionId: string,
    csrfTokenHash: string,
  ): Promise<boolean> {
    const rows = await this.database
      .update(schema.userSessions)
      .set({ csrfTokenHash, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          isNull(schema.userSessions.revokedAt),
        ),
      )
      .returning({ id: schema.userSessions.id });
    return rows.length > 0;
  }

  async revokeUserSession(sessionId: string, reason: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(schema.userSessions)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          isNull(schema.userSessions.revokedAt),
        ),
      )
      .returning({ id: schema.userSessions.id });
    return rows.length > 0;
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.userSessions)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
        ),
      )
      .returning({ id: schema.userSessions.id });
    return rows.length;
  }

  async listUserSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<AccountSessionSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.userSessions)
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.userSessions.lastSeenAt))
      .limit(1_000);
    return rows.map((session) => ({
      id: session.id,
      authMethod: session.authMethod as AccountSessionSummary["authMethod"],
      label: session.label,
      current: session.id === currentSessionId,
      connected: false,
      createdAt: toISOString(session.createdAt),
      lastSeenAt: toISOString(session.lastSeenAt),
      expiresAt: toISOString(session.expiresAt),
    }));
  }

  async appendAuditEvent(input: AuditEventCreate): Promise<AuditEvent> {
    const rows = await this.database
      .insert(schema.auditEvents)
      .values(input)
      .returning();
    return toAuditEvent(firstOrThrow(rows, "appending an audit event"));
  }

  async listAuditEvents(
    query: AuditEventQuery,
    ownerId?: string,
  ): Promise<AuditEventList> {
    const filters = [
      ...(ownerId ? [eq(schema.auditEvents.ownerId, ownerId)] : []),
      ...(query.before ? [lt(schema.auditEvents.id, query.before)] : []),
    ];
    const rows = await this.database
      .select()
      .from(schema.auditEvents)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.auditEvents.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toAuditEvent);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }
}
