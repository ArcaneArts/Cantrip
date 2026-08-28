import {
  accountRegistrationSchema,
  authLoginSchema,
  authLogoutAllResultSchema,
  authReauthenticationResultSchema,
  authReauthenticationSchema,
  authSessionSchema,
  authSessionStateSchema,
  mobileSignInGrantCreateResultSchema,
  mobileSignInGrantExchangeSchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import {
  createMobileSignInCode,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashSecret,
  normalizeAccountEmail,
  safeSecretMatch,
  type UserSessionService,
  verifyPassword,
} from "../../auth/service.js";
import type { CodeTunnelBroker } from "../../code/tunnel.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import { invalidBody } from "../../http/request-helpers.js";
import type { AppLiveHub } from "../../live/hub.js";
import { serverLogger } from "../../logger.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { AppendAudit } from "../http/audit.js";

export interface AuthSessionRouteDependencies {
  appendAudit: AppendAudit;
  closeSessionSockets: (
    matches: (sessionId: string, ownerId: string) => boolean,
    reason: string,
  ) => void;
  codeTunnel: Pick<CodeTunnelBroker, "revokeAuthSession" | "revokeOwner">;
  config: ServerConfig;
  consumeAuthAttempt: (
    request: FastifyRequest,
    scope: string,
    identity: string,
    reply: FastifyReply,
  ) => unknown | null;
  directAttachments: Pick<
    DirectAttachmentCoordinator,
    "revokeOwner" | "revokeSession"
  >;
  licenseWhitelistConfigured: boolean;
  licenseWhitelistEnabled: boolean;
  liveHub: Pick<AppLiveHub, "revokeOwner" | "revokeSession">;
  localUser: Parameters<UserSessionService["create"]>[2] | null;
  normalizedAdminEmail: string | null;
  rejectUnapprovedAuthOrigin: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => unknown | null;
  repository: Pick<
    ServerRepository,
    | "accountEmailIsWhitelisted"
    | "consumeMobileSignInGrant"
    | "countAccountUsers"
    | "createAccount"
    | "createMobileSignInGrant"
    | "ensureAccountConfiguration"
    | "findAccountCredential"
    | "findAccountCredentialById"
    | "pruneMobileSignInGrants"
    | "revokeAllUserSessions"
    | "revokeUserSession"
  >;
  sessionService: UserSessionService;
  withRegistrationLock: <T>(operation: () => Promise<T>) => Promise<T>;
  workerLinks: Pick<WorkerLinkService, "revokeAccountSession" | "revokeOwner">;
}

/** Registers account registration, sign-in, session, and sign-out routes. */
export function installAuthSessionRoutes(
  app: FastifyInstance,
  {
    appendAudit,
    closeSessionSockets,
    codeTunnel,
    config,
    consumeAuthAttempt,
    directAttachments,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    liveHub,
    localUser,
    normalizedAdminEmail,
    rejectUnapprovedAuthOrigin,
    repository,
    sessionService,
    withRegistrationLock,
    workerLinks,
  }: AuthSessionRouteDependencies,
): void {
  app.post<{
    Headers: { "x-cantrip-bootstrap-token"?: string };
  }>("/api/auth/register", async (request, reply) => {
    const originRejection = rejectUnapprovedAuthOrigin(request, reply);
    if (originRejection) return originRejection;
    if (config.authMode !== "accounts") {
      return reply.code(404).send({ error: "Registration is unavailable." });
    }
    const input = accountRegistrationSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const normalizedEmail = normalizeAccountEmail(input.data.email);
    const limited = consumeAuthAttempt(
      request,
      "register",
      normalizedEmail,
      reply,
    );
    if (limited) {
      await appendAudit(request, {
        action: "auth.registration-rate-limited",
        ownerId: null,
        resourceType: "account",
        result: "denied",
      });
      return limited;
    }

    return withRegistrationLock(async () => {
      const accountCount = await repository.countAccountUsers();
      const firstAccount = accountCount === 0;
      const configuredAdministrator = normalizedAdminEmail === normalizedEmail;
      if (licenseWhitelistEnabled && firstAccount && !configuredAdministrator) {
        await appendAudit(request, {
          action: "auth.registration-denied",
          ownerId: null,
          resourceType: "account",
          result: "denied",
        });
        return reply.code(403).send({
          error:
            "The configured administrator must create the first account on this server.",
        });
      }
      if (
        licenseWhitelistEnabled &&
        !configuredAdministrator &&
        !(await repository.accountEmailIsWhitelisted(normalizedEmail))
      ) {
        await appendAudit(request, {
          action: "auth.registration-denied",
          ownerId: null,
          resourceType: "account",
          result: "denied",
        });
        return reply.code(403).send({
          error:
            "This email is not licensed to create an account on this server.",
        });
      }
      if (
        !licenseWhitelistConfigured &&
        !firstAccount &&
        !config.publicRegistration
      ) {
        await appendAudit(request, {
          action: "auth.registration-denied",
          ownerId: null,
          resourceType: "account",
          result: "denied",
        });
        return reply.code(403).send({ error: "Registration is disabled." });
      }
      if (
        !licenseWhitelistConfigured &&
        !config.publicRegistration &&
        firstAccount
      ) {
        const candidate = request.headers["x-cantrip-bootstrap-token"];
        if (
          !config.adminBootstrapToken ||
          typeof candidate !== "string" ||
          !safeSecretMatch(candidate, config.adminBootstrapToken)
        ) {
          await appendAudit(request, {
            action: "auth.registration-denied",
            ownerId: null,
            resourceType: "account",
            result: "denied",
          });
          return reply.code(403).send({
            error: "A valid first-admin bootstrap token is required.",
          });
        }
      }

      try {
        const user = await repository.createAccount({
          displayName: input.data.displayName,
          email: input.data.email.trim(),
          normalizedEmail,
          passwordHash: await hashPassword(input.data.password),
          role: configuredAdministrator
            ? firstAccount
              ? "owner"
              : "admin"
            : firstAccount
              ? "owner"
              : "member",
        });
        await repository.ensureAccountConfiguration(user.id);
        await appendAudit(request, {
          action: "auth.registration-succeeded",
          actorUserId: user.id,
          ownerId: user.id,
          resourceId: user.id,
          resourceType: "account",
          result: "succeeded",
        });
        return reply
          .header("cache-control", "no-store")
          .code(201)
          .send(
            authSessionSchema.parse(
              await sessionService.create(
                request,
                reply,
                user,
                "account-password",
              ),
            ),
          );
      } catch {
        await appendAudit(request, {
          action: "auth.registration-failed",
          ownerId: null,
          resourceType: "account",
          result: "failed",
        });
        return reply.code(409).send({ error: "Account could not be created." });
      }
    });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const originRejection = rejectUnapprovedAuthOrigin(request, reply);
    if (originRejection) return originRejection;
    if (config.authMode === "none") {
      return reply.code(404).send({ error: "Sign-in is unavailable." });
    }
    const input = authLoginSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const identity = input.data.email
      ? normalizeAccountEmail(input.data.email)
      : "single-user";
    const limited = consumeAuthAttempt(request, "login", identity, reply);
    if (limited) {
      await appendAudit(request, {
        action: "auth.login-rate-limited",
        ownerId: null,
        resourceType: "session",
        result: "denied",
      });
      return limited;
    }

    let user = localUser;
    let passwordHash = config.passwordHash ?? DUMMY_PASSWORD_HASH;
    let authMethod: "password" | "account-password" = "password";
    if (config.authMode === "accounts") {
      const credential = input.data.email
        ? await repository.findAccountCredential(identity)
        : null;
      user = credential?.user ?? null;
      passwordHash = credential?.passwordHash ?? DUMMY_PASSWORD_HASH;
      authMethod = "account-password";
    }
    const valid = await verifyPassword(passwordHash, input.data.password);
    if (!valid || !user) {
      await appendAudit(request, {
        action: "auth.login-failed",
        ownerId: user?.id ?? null,
        resourceType: "session",
        result: "denied",
      });
      return reply.code(401).send({ error: "Email or password is incorrect." });
    }
    await repository.ensureAccountConfiguration(user.id);
    await appendAudit(request, {
      action: "auth.login-succeeded",
      actorUserId: user.id,
      ownerId: user.id,
      resourceId: user.id,
      resourceType: "session",
      result: "succeeded",
    });
    return reply
      .header("cache-control", "no-store")
      .send(
        authSessionSchema.parse(
          await sessionService.create(request, reply, user, authMethod),
        ),
      );
  });

  app.post("/api/auth/reauthenticate", async (request, reply) => {
    if (config.authMode === "none") {
      return reply
        .code(404)
        .send({ error: "Reauthentication is unavailable." });
    }
    const input = authReauthenticationSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const principal = authenticatedPrincipal(request);
    const limited = consumeAuthAttempt(
      request,
      "reauthenticate",
      principal.user.id,
      reply,
    );
    if (limited) return limited;
    const credential =
      config.authMode === "accounts"
        ? await repository.findAccountCredentialById(principal.user.id)
        : null;
    const passwordHash =
      config.authMode === "accounts"
        ? (credential?.passwordHash ?? DUMMY_PASSWORD_HASH)
        : (config.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!(await verifyPassword(passwordHash, input.data.password))) {
      await appendAudit(request, {
        action: "auth.reauthentication-failed",
        ownerId: principal.user.id,
        resourceId: principal.user.id,
        resourceType: "account",
        result: "denied",
      });
      return reply.code(403).send({ error: "Password is incorrect." });
    }
    await appendAudit(request, {
      action: "auth.reauthentication-succeeded",
      actorUserId: principal.user.id,
      ownerId: principal.user.id,
      resourceId: principal.user.id,
      resourceType: "account",
      result: "succeeded",
    });
    return reply
      .header("cache-control", "no-store")
      .send(authReauthenticationResultSchema.parse({ verified: true }));
  });

  app.post("/api/auth/mobile-sign-in/grants", async (request, reply) => {
    if (config.authMode === "none") {
      return reply.code(404).send({ error: "Mobile sign-in is unavailable." });
    }
    const principal = authenticatedPrincipal(request);
    if (!principal.sessionId) {
      return reply.code(401).send({ error: "Authentication is required." });
    }
    const generated = createMobileSignInCode();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1_000);
    const id = await repository.createMobileSignInGrant({
      codeHash: generated.codeHash,
      createdBySessionId: principal.sessionId,
      expiresAt,
      ownerId: principal.user.id,
    });
    void repository
      .pruneMobileSignInGrants(new Date(Date.now() - 24 * 60 * 60 * 1_000))
      .catch((error) =>
        request.log.warn(
          { err: error },
          "Could not prune expired mobile sign-in grants",
        ),
      );
    await appendAudit(request, {
      action: "auth.mobile-sign-in-grant-created",
      ownerId: principal.user.id,
      resourceId: id,
      resourceType: "session-grant",
      result: "succeeded",
    });
    return reply
      .header("cache-control", "no-store")
      .code(201)
      .send(
        mobileSignInGrantCreateResultSchema.parse({
          code: generated.code,
          expiresAt: expiresAt.toISOString(),
        }),
      );
  });

  app.post("/api/auth/mobile-sign-in/exchange", async (request, reply) => {
    const originRejection = rejectUnapprovedAuthOrigin(request, reply);
    if (originRejection) return originRejection;
    if (config.authMode === "none") {
      return reply.code(404).send({ error: "Mobile sign-in is unavailable." });
    }
    const input = mobileSignInGrantExchangeSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const codeHash = hashSecret(input.data.code);
    const limited = consumeAuthAttempt(request, "mobile-qr", "exchange", reply);
    if (limited) return limited;

    const user = await repository.consumeMobileSignInGrant(codeHash);
    if (!user) {
      await appendAudit(request, {
        action: "auth.mobile-sign-in-failed",
        ownerId: null,
        resourceType: "session-grant",
        result: "denied",
      });
      return reply.code(401).send({
        error: "This mobile sign-in code is invalid, expired, or already used.",
      });
    }
    await repository.ensureAccountConfiguration(user.id);
    await appendAudit(request, {
      action: "auth.mobile-sign-in-succeeded",
      actorUserId: user.id,
      ownerId: user.id,
      resourceId: user.id,
      resourceType: "session",
      result: "succeeded",
    });
    return reply
      .header("cache-control", "no-store")
      .send(
        authSessionSchema.parse(
          await sessionService.create(request, reply, user, "mobile-qr"),
        ),
      );
  });

  app.get("/api/auth/session", async (request, reply) => {
    const originRejection = rejectUnapprovedAuthOrigin(request, reply);
    if (originRejection) return originRejection;
    const session = await sessionService.resolve(request);
    if (!session) {
      return reply.header("cache-control", "no-store").send(
        authSessionStateSchema.parse({
          currentUser: null,
          csrfToken: null,
          expiresAt: null,
        }),
      );
    }
    return reply
      .header("cache-control", "no-store")
      .send(authSessionStateSchema.parse(sessionService.sessionState(session)));
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const principal = authenticatedPrincipal(request);
    await repository.revokeUserSession(principal.sessionId!, "signed-out");
    liveHub.revokeSession(principal.sessionId!);
    await codeTunnel.revokeAuthSession(principal.sessionId!);
    await directAttachments.revokeSession(principal.sessionId!);
    await workerLinks.revokeAccountSession(principal.sessionId!);
    closeSessionSockets(
      (sessionId) => sessionId === principal.sessionId,
      "Session was revoked",
    );
    sessionService.clear(reply);
    await appendAudit(request, {
      action: "auth.session-revoked",
      resourceId: principal.sessionId,
      resourceType: "session",
      result: "succeeded",
    });
    serverLogger.info("Application session revoked", {
      event: "security.session.revoked",
      subsystem: "security",
      operation: "logout",
      status: "completed",
      requestId: request.id,
      sessionId: principal.sessionId,
    });
    return reply.code(204).send();
  });

  app.post("/api/auth/logout-all", async (request, reply) => {
    const principal = authenticatedPrincipal(request);
    const revokedSessions = await repository.revokeAllUserSessions(
      principal.user.id,
      "signed-out-all",
    );
    liveHub.revokeOwner(principal.user.id);
    await codeTunnel.revokeOwner(principal.user.id);
    await directAttachments.revokeOwner(principal.user.id);
    await workerLinks.revokeOwner(principal.user.id);
    closeSessionSockets(
      (_sessionId, ownerId) => ownerId === principal.user.id,
      "Account sessions were revoked",
    );
    sessionService.clear(reply);
    await appendAudit(request, {
      action: "auth.all-sessions-revoked",
      resourceId: principal.user.id,
      resourceType: "account",
      result: "succeeded",
    });
    serverLogger.info("All application sessions revoked", {
      event: "security.sessions.revoked",
      subsystem: "security",
      operation: "logout-all",
      status: "completed",
      requestId: request.id,
      counts: { sessions: revokedSessions },
    });
    return reply.send(authLogoutAllResultSchema.parse({ revokedSessions }));
  });
}
