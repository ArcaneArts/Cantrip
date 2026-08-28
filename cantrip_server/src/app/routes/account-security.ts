import {
  accountAdminSummarySchema,
  accountLicenseWhitelistCreateSchema,
  accountLicenseWhitelistEntrySchema,
  accountSessionListSchema,
  auditEventListSchema,
  auditEventQuerySchema,
} from "@cantrip/protocol";
import {
  accountEncryptionProfileInitializeResultSchema,
  accountEncryptionProfileInitializeSchema,
  accountEncryptionProfileSchema,
  accountEncryptionProfileStateSchema,
  accountPasswordEncryptionChangeSchema,
  encryptionKeyGrantCreateSchema,
  encryptionKeyGrantListSchema,
  encryptionKeyGrantSchema,
  encryptionPrincipalApprovalSchema,
  encryptionPrincipalCreateSchema,
  encryptionPrincipalListSchema,
  encryptionPrincipalSchema,
  encryptionProfileMigrationUpdateSchema,
  encryptionRevocationSchema,
} from "@cantrip/protocol/encryption";
import {
  accountResourceUsageHistoryQuerySchema,
  accountResourceUsageHistorySchema,
  accountResourceUsageSchema,
} from "@cantrip/protocol/resource-usage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedPrincipal,
  principalOwnerId,
} from "../../auth/principal.js";
import {
  hashPassword,
  normalizeAccountEmail,
  verifyPassword,
} from "../../auth/service.js";
import type { CodeTunnelBroker } from "../../code/tunnel.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import {
  accountBandwidthPeriod,
  buildAccountResourceUsage,
  buildBandwidthUsageHistory,
  buildStorageUsageHistory,
} from "../../account-usage/resource-usage-response.js";
import type { AppendAudit } from "../http/audit.js";

export interface AccountSecurityRouteDependencies {
  appendAudit: AppendAudit;
  codeTunnel: Pick<CodeTunnelBroker, "revokeSharedWorkerSecurity">;
  config: ServerConfig;
  consumeAuthAttempt: (
    request: FastifyRequest,
    scope: string,
    identity: string,
    reply: FastifyReply,
  ) => unknown | null;
  licenseWhitelistEnabled: boolean;
  normalizedAdminEmail: string | null;
  repository: Pick<
    ServerRepository,
    | "accountResourceUsage"
    | "countAccountUsers"
    | "createAccountLicenseWhitelistEntry"
    | "deleteAccountLicenseWhitelistEntry"
    | "encryptionRegistry"
    | "findAccountCredentialById"
    | "listAccountLicenseWhitelist"
    | "listAuditEvents"
    | "listUserSessions"
  >;
  sessionSockets: ReadonlyMap<string, unknown>;
}

/** Registers account encryption, resource, audit, and administration routes. */
export function installAccountSecurityRoutes(
  app: FastifyInstance,
  {
    appendAudit,
    codeTunnel,
    config,
    consumeAuthAttempt,
    licenseWhitelistEnabled,
    normalizedAdminEmail,
    repository,
    sessionSockets,
  }: AccountSecurityRouteDependencies,
): void {
  app.get("/api/encryption/profile", async (request, reply) => {
    const profile = await repository.encryptionRegistry.getProfile(
      principalOwnerId(request),
    );
    return reply
      .header("cache-control", "no-store")
      .send(
        accountEncryptionProfileStateSchema.parse(
          profile
            ? { status: "initialized", profile }
            : { status: "uninitialized", profile: null },
        ),
      );
  });

  app.post("/api/encryption/profile/initialize", async (request, reply) => {
    const input = accountEncryptionProfileInitializeSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    if (
      config.authMode !== "none" &&
      input.data.profile.passwordWrappedMasterKey === null
    ) {
      return reply.code(400).send({
        error: "Password-authenticated profiles require a password wrapper.",
      });
    }
    const result = accountEncryptionProfileInitializeResultSchema.parse(
      await repository.encryptionRegistry.initializeProfile(
        principalOwnerId(request),
        input.data,
      ),
    );
    return reply
      .header("cache-control", "no-store")
      .code(result.created ? 201 : 409)
      .send(result);
  });

  app.patch("/api/encryption/profile/migration", async (request, reply) => {
    const input = encryptionProfileMigrationUpdateSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const profile = await repository.encryptionRegistry.updateMigrationStatus(
      principalOwnerId(request),
      input.data,
    );
    return profile
      ? reply
          .header("cache-control", "no-store")
          .send(accountEncryptionProfileSchema.parse(profile))
      : reply.code(409).send({
          error: "Encryption profile revision changed or was not found.",
        });
  });

  app.post("/api/account/password", async (request, reply) => {
    if (config.authMode !== "accounts") {
      return reply
        .code(404)
        .send({ error: "Account passwords are unavailable." });
    }
    const input = accountPasswordEncryptionChangeSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const principal = authenticatedPrincipal(request);
    const ownerId = principalOwnerId(request);
    const limited = consumeAuthAttempt(
      request,
      "password-change",
      ownerId,
      reply,
    );
    if (limited) return limited;
    const credential = await repository.findAccountCredentialById(ownerId);
    if (
      !credential ||
      !(await verifyPassword(
        credential.passwordHash,
        input.data.currentPassword,
      ))
    ) {
      await appendAudit(request, {
        action: "auth.password-change-failed",
        ownerId,
        resourceId: ownerId,
        resourceType: "account",
        result: "denied",
      });
      return reply.code(403).send({ error: "Current password is incorrect." });
    }
    const profile = await repository.encryptionRegistry.changeAccountPassword(
      ownerId,
      {
        expectedProfileRevision: input.data.expectedProfileRevision,
        passwordKdf: input.data.passwordKdf,
        passwordWrappedMasterKey: input.data.passwordWrappedMasterKey,
      },
      await hashPassword(input.data.newPassword),
    );
    if (!profile) {
      return reply.code(409).send({
        error: "Encryption profile revision changed or was not found.",
      });
    }
    await appendAudit(request, {
      action: "auth.password-changed",
      actorUserId: principal.user.id,
      ownerId,
      resourceId: ownerId,
      resourceType: "account",
      result: "succeeded",
    });
    return reply
      .header("cache-control", "no-store")
      .send(accountEncryptionProfileSchema.parse(profile));
  });

  app.get("/api/encryption/principals", async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .send(
        encryptionPrincipalListSchema.parse(
          await repository.encryptionRegistry.listPrincipals(
            principalOwnerId(request),
          ),
        ),
      ),
  );

  app.post("/api/encryption/principals", async (request, reply) => {
    const input = encryptionPrincipalCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const principal = await repository.encryptionRegistry.createPrincipal(
      principalOwnerId(request),
      input.data,
    );
    return principal
      ? reply
          .header("cache-control", "no-store")
          .code(201)
          .send(encryptionPrincipalSchema.parse(principal))
      : reply.code(409).send({
          error:
            "Encryption principal already exists or its worker is unavailable.",
        });
  });

  app.post<{ Params: { principalId: string } }>(
    "/api/encryption/principals/:principalId/approve",
    async (request, reply) => {
      const input = encryptionPrincipalApprovalSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = await repository.encryptionRegistry.approvePrincipal(
        principalOwnerId(request),
        request.params.principalId,
        input.data.expectedRevision,
      );
      return principal
        ? reply
            .header("cache-control", "no-store")
            .send(encryptionPrincipalSchema.parse(principal))
        : reply.code(409).send({
            error: "Encryption principal revision or state changed.",
          });
    },
  );

  app.post<{ Params: { principalId: string } }>(
    "/api/encryption/principals/:principalId/revoke",
    async (request, reply) => {
      const input = encryptionRevocationSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = await repository.encryptionRegistry.revokePrincipal(
        principalOwnerId(request),
        request.params.principalId,
        input.data,
      );
      if (principal?.kind === "worker" && principal.workerId) {
        await codeTunnel.revokeSharedWorkerSecurity(
          principal.ownerId,
          principal.workerId,
        );
      }
      return principal
        ? reply
            .header("cache-control", "no-store")
            .send(encryptionPrincipalSchema.parse(principal))
        : reply.code(409).send({
            error: "Encryption principal revision or state changed.",
          });
    },
  );

  app.get<{ Params: { principalId: string } }>(
    "/api/encryption/principals/:principalId/grants",
    async (request, reply) => {
      const result = await repository.encryptionRegistry.listActiveGrants(
        principalOwnerId(request),
        request.params.principalId,
      );
      if (result.status === "missing") {
        return reply
          .code(404)
          .send({ error: "Encryption principal not found." });
      }
      if (result.status === "unavailable") {
        return reply.code(409).send({
          error: "Encryption principal is not approved or was revoked.",
        });
      }
      return reply
        .header("cache-control", "no-store")
        .send(encryptionKeyGrantListSchema.parse(result.grants));
    },
  );

  app.post<{ Params: { principalId: string } }>(
    "/api/encryption/principals/:principalId/grants",
    async (request, reply) => {
      const input = encryptionKeyGrantCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = principalOwnerId(request);
      const tunnelGrantWorkerId =
        input.data.component === "tunnel-content"
          ? (await repository.encryptionRegistry.listPrincipals(ownerId)).find(
              (candidate) =>
                candidate.id === request.params.principalId &&
                candidate.kind === "worker" &&
                candidate.workerId,
            )?.workerId
          : null;
      const result = await repository.encryptionRegistry.createGrant(
        ownerId,
        request.params.principalId,
        input.data,
      );
      if (result.status === "created") {
        if (
          result.grant.component === "tunnel-content" &&
          tunnelGrantWorkerId
        ) {
          await codeTunnel.revokeSharedWorkerSecurity(
            ownerId,
            tunnelGrantWorkerId,
          );
        }
        return reply
          .header("cache-control", "no-store")
          .code(201)
          .send(encryptionKeyGrantSchema.parse(result.grant));
      }
      if (result.status === "missing") {
        return reply
          .code(404)
          .send({ error: "Encryption principal not found." });
      }
      if (result.status === "wrapper-mismatch") {
        return reply
          .code(400)
          .send({ error: "Wrapped key does not match the target principal." });
      }
      return reply.code(409).send({
        error:
          result.status === "unavailable"
            ? "Encryption principal is not approved or was revoked."
            : "A grant for this component revision already exists.",
      });
    },
  );

  app.post<{ Params: { grantId: string } }>(
    "/api/encryption/grants/:grantId/revoke",
    async (request, reply) => {
      const input = encryptionRevocationSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const grant = await repository.encryptionRegistry.revokeGrant(
        principalOwnerId(request),
        request.params.grantId,
        input.data,
      );
      if (grant?.component === "tunnel-content") {
        const principals = await repository.encryptionRegistry.listPrincipals(
          grant.ownerId,
        );
        const workerPrincipal = principals.find(
          (candidate) =>
            candidate.id === grant.principalId &&
            candidate.kind === "worker" &&
            candidate.workerId,
        );
        if (workerPrincipal?.workerId) {
          await codeTunnel.revokeSharedWorkerSecurity(
            grant.ownerId,
            workerPrincipal.workerId,
            grant.keyRevision,
          );
        }
      }
      return grant
        ? reply
            .header("cache-control", "no-store")
            .send(encryptionKeyGrantSchema.parse(grant))
        : reply.code(409).send({
            error: "Encryption grant revision or state changed.",
          });
    },
  );

  app.get("/api/account/sessions", async (request, reply) => {
    const principal = authenticatedPrincipal(request);
    const sessions = await repository.listUserSessions(
      principal.user.id,
      principal.sessionId,
    );
    return reply.send(
      accountSessionListSchema.parse(
        sessions.map((session) => ({
          ...session,
          connected: session.current || sessionSockets.has(session.id),
        })),
      ),
    );
  });

  app.get("/api/account/resource-usage", async (request, reply) => {
    const ownerId = principalOwnerId(request);
    const now = new Date();
    const period = accountBandwidthPeriod(now);
    const [rows, bandwidthRows] = await Promise.all([
      repository.accountResourceUsage.listCurrentStorage(ownerId),
      repository.accountResourceUsage.listBandwidthHistory(
        ownerId,
        period.start,
        period.end,
        "day",
      ),
    ]);
    return reply
      .header("cache-control", "private, no-store")
      .send(
        accountResourceUsageSchema.parse(
          buildAccountResourceUsage(rows, bandwidthRows, now),
        ),
      );
  });

  app.get("/api/account/resource-usage/history", async (request, reply) => {
    const query = accountResourceUsageHistoryQuerySchema.safeParse(
      request.query,
    );
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    const history =
      query.data.metric === "storage"
        ? buildStorageUsageHistory(
            query.data,
            await repository.accountResourceUsage.listStorageHistory(
              principalOwnerId(request),
              new Date(query.data.from),
              new Date(query.data.to),
              query.data.resolution,
            ),
          )
        : buildBandwidthUsageHistory(
            query.data,
            await repository.accountResourceUsage.listBandwidthHistory(
              principalOwnerId(request),
              new Date(query.data.from),
              new Date(query.data.to),
              query.data.resolution,
            ),
          );
    return reply
      .header("cache-control", "private, no-store")
      .send(accountResourceUsageHistorySchema.parse(history));
  });

  app.get("/api/account/audit-events", async (request, reply) => {
    const query = auditEventQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    const events = await repository.listAuditEvents(
      query.data,
      principalOwnerId(request),
    );
    return reply.send(auditEventListSchema.parse(events));
  });

  app.get("/api/admin/audit-events", async (request, reply) => {
    const principal = authenticatedPrincipal(request);
    if (principal.user.role !== "owner" && principal.user.role !== "admin") {
      return reply
        .code(403)
        .send({ error: "Administrator access is required." });
    }
    const query = auditEventQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    return reply.send(
      auditEventListSchema.parse(await repository.listAuditEvents(query.data)),
    );
  });

  app.get("/api/admin/accounts", async (request, reply) => {
    const principal = authenticatedPrincipal(request);
    if (principal.user.role !== "owner" && principal.user.role !== "admin") {
      return reply
        .code(403)
        .send({ error: "Administrator access is required." });
    }
    return reply.header("cache-control", "no-store").send(
      accountAdminSummarySchema.parse({
        userCount: await repository.countAccountUsers(),
        licenseWhitelist: {
          enabled: licenseWhitelistEnabled,
          adminEmail: config.adminEmail ?? null,
          entries: await repository.listAccountLicenseWhitelist(),
        },
      }),
    );
  });

  app.post("/api/admin/license-whitelist", async (request, reply) => {
    const principal = authenticatedPrincipal(request);
    if (principal.user.role !== "owner" && principal.user.role !== "admin") {
      return reply
        .code(403)
        .send({ error: "Administrator access is required." });
    }
    const input = accountLicenseWhitelistCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const normalizedEmail = normalizeAccountEmail(input.data.email);
    if (normalizedEmail === normalizedAdminEmail) {
      return reply.code(409).send({
        error: "The configured administrator is licensed automatically.",
      });
    }
    const entry = await repository.createAccountLicenseWhitelistEntry({
      addedByUserId: principal.user.id,
      email: input.data.email.trim(),
      normalizedEmail,
    });
    return entry
      ? reply.code(201).send(accountLicenseWhitelistEntrySchema.parse(entry))
      : reply.code(409).send({ error: "That email is already whitelisted." });
  });

  app.delete<{ Params: { entryId: string } }>(
    "/api/admin/license-whitelist/:entryId",
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      if (principal.user.role !== "owner" && principal.user.role !== "admin") {
        return reply
          .code(403)
          .send({ error: "Administrator access is required." });
      }
      return (await repository.deleteAccountLicenseWhitelistEntry(
        request.params.entryId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Whitelist entry not found." });
    },
  );
}
