import { z } from "zod";

import {
  codeTransportSchema,
  remoteSurfaceTransportSchema,
} from "./runtime-capabilities.js";

export const protocolVersionSchema = z.literal(1);
export const cantripVersionSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    patch: z.number().int().nonnegative(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .superRefine((value, context) => {
    if (value.version === `${value.major}.${value.minor}.${value.patch}`)
      return;
    context.addIssue({
      code: "custom",
      message: "Version string does not match its numeric components.",
      path: ["version"],
    });
  });

export type CantripVersion = z.infer<typeof cantripVersionSchema>;

export const databaseEngineSchema = z.enum(["pglite", "postgres"]);

export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;
export const deploymentModeSchema = z.enum(["local", "hosted"]);

export type DeploymentMode = z.infer<typeof deploymentModeSchema>;
export const bootstrapModeSchema = z.enum([
  "pnpm-dev",
  "tauri",
  "standalone",
  "hosted",
]);

export type BootstrapMode = z.infer<typeof bootstrapModeSchema>;
export const authModeSchema = z.enum(["none", "password", "accounts"]);

export type AuthMode = z.infer<typeof authModeSchema>;
export const authenticationStateSchema = z.enum([
  "authenticated",
  "authentication-required",
]);

export type AuthenticationState = z.infer<typeof authenticationStateSchema>;
export const userRoleSchema = z.enum(["owner", "admin", "member"]);

export type UserRole = z.infer<typeof userRoleSchema>;

export const userSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["anonymous", "account"]),
  displayName: z.string().min(1),
  email: z.email().nullable(),
  role: userRoleSchema.default("member"),
});

export type UserSummary = z.infer<typeof userSummarySchema>;

const authPasswordSchema = z.string().min(12).max(1_024);

export const accountRegistrationSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  password: authPasswordSchema,
});

export type AccountRegistration = z.infer<typeof accountRegistrationSchema>;

export const accountLicenseWhitelistEntrySchema = z.object({
  id: z.string().min(1),
  email: z.email().max(320),
  registered: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type AccountLicenseWhitelistEntry = z.infer<
  typeof accountLicenseWhitelistEntrySchema
>;

export const accountLicenseWhitelistCreateSchema = z.object({
  email: z.email().max(320),
});

export type AccountLicenseWhitelistCreate = z.infer<
  typeof accountLicenseWhitelistCreateSchema
>;

export const accountAdminSummarySchema = z.object({
  userCount: z.number().int().nonnegative(),
  licenseWhitelist: z.object({
    enabled: z.boolean(),
    adminEmail: z.email().max(320).nullable(),
    entries: z.array(accountLicenseWhitelistEntrySchema).max(10_000),
  }),
});

export type AccountAdminSummary = z.infer<typeof accountAdminSummarySchema>;

export const authLoginSchema = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(1).max(1_024),
});

export type AuthLogin = z.infer<typeof authLoginSchema>;

export const authReauthenticationSchema = z
  .object({ password: z.string().min(1).max(1_024) })
  .strict();

export type AuthReauthentication = z.infer<typeof authReauthenticationSchema>;

export const authReauthenticationResultSchema = z
  .object({ verified: z.literal(true) })
  .strict();

export type AuthReauthenticationResult = z.infer<
  typeof authReauthenticationResultSchema
>;

export const authSessionSchema = z.object({
  currentUser: userSummarySchema,
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const authSessionStateSchema = z.object({
  currentUser: userSummarySchema.nullable(),
  csrfToken: z.string().min(32).nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

export type AuthSessionState = z.infer<typeof authSessionStateSchema>;

export const mobileSignInGrantCreateResultSchema = z.object({
  code: z.string().regex(/^ctms_[A-Za-z0-9_-]{32}$/u),
  expiresAt: z.iso.datetime(),
});

export type MobileSignInGrantCreateResult = z.infer<
  typeof mobileSignInGrantCreateResultSchema
>;

export const mobileSignInGrantExchangeSchema = z.object({
  code: z.string().regex(/^ctms_[A-Za-z0-9_-]{32}$/u),
});

export type MobileSignInGrantExchange = z.infer<
  typeof mobileSignInGrantExchangeSchema
>;

export const mobileSignInQrPayloadSchema = z.object({
  type: z.literal("cantrip.mobile-sign-in"),
  version: z.literal(1),
  serverId: z.string().min(1),
  serverName: z.string().trim().min(1).max(120),
  serverUrl: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Server URL must use HTTP or HTTPS."),
  code: mobileSignInGrantExchangeSchema.shape.code,
  expiresAt: z.iso.datetime(),
});

export type MobileSignInQrPayload = z.infer<typeof mobileSignInQrPayloadSchema>;

export const authLogoutAllResultSchema = z.object({
  revokedSessions: z.number().int().nonnegative(),
});

export type AuthLogoutAllResult = z.infer<typeof authLogoutAllResultSchema>;

export const accountSessionSummarySchema = z.object({
  id: z.string().min(1),
  authMethod: z.enum(["password", "account-password", "mobile-qr"]),
  label: z.string().max(200).nullable(),
  current: z.boolean(),
  connected: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type AccountSessionSummary = z.infer<typeof accountSessionSummarySchema>;

export const accountSessionListSchema = z
  .array(accountSessionSummarySchema)
  .max(1_000);

export const auditEventSchema = z
  .object({
    id: z.number().int().positive(),
    ownerId: z.string().min(1).nullable(),
    actor: z.object({
      userId: z.string().min(1).nullable(),
      sessionId: z.string().min(1).nullable(),
    }),
    action: z
      .string()
      .min(3)
      .max(160)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u),
    result: z.enum(["succeeded", "failed", "denied"]),
    resource: z.object({
      type: z.string().min(1).max(80),
      id: z.string().min(1).max(500).nullable(),
    }),
    requestId: z.string().min(1).max(200).nullable(),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditEventListSchema = z.object({
  items: z.array(auditEventSchema).max(200),
  nextCursor: z.number().int().positive().nullable(),
});

export type AuditEventList = z.infer<typeof auditEventListSchema>;

export const auditEventQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;

export const serverBootstrapSchema = z.object({
  protocolVersion: protocolVersionSchema,
  server: z.object({
    id: z.string().min(1),
    version: cantripVersionSchema,
    deploymentMode: deploymentModeSchema,
    bootstrapMode: bootstrapModeSchema,
  }),
  auth: z.object({
    mode: authModeSchema,
    state: authenticationStateSchema.default("authenticated"),
    currentUser: userSummarySchema.nullable(),
    registration: z
      .object({
        enabled: z.boolean(),
        bootstrapRequired: z.boolean().default(false),
        licenseRequired: z.boolean().default(false),
      })
      .default({
        enabled: false,
        bootstrapRequired: false,
        licenseRequired: false,
      }),
  }),
  routing: z.object({
    workerConnection: z.literal("server-only"),
    directWorkerConnections: z.literal(false),
  }),
  storage: z.object({
    conversations: z.literal("server"),
    files: z.literal("worker"),
  }),
  agent: z.object({
    model: z.string().min(1),
    modelProvider: z.string().min(1),
  }),
  capabilities: z.object({
    accounts: z.boolean(),
    passwordProtection: z.boolean(),
    linkCodes: z.boolean(),
    multipleWorkers: z.boolean(),
    projectReplicas: z.boolean().default(false),
    replicaProvisioning: z.boolean().default(false),
    browserFleetDiscovery: z.boolean().default(false),
    crossWorkerExecutionTargets: z.boolean().default(false),
    remoteDesktopFleet: z.boolean().default(false),
    workerSwitching: z.boolean(),
    gitSync: z.boolean(),
    worktrees: z.boolean(),
    standaloneChat: z
      .object({
        available: z.boolean(),
        protocolVersion: z.number().int().positive(),
        reason: z.string().min(1).nullable(),
      })
      .strict()
      .default({
        available: false,
        protocolVersion: 1,
        reason: "Standalone Chat is not enabled by this server.",
      }),
    remoteSurfaces: z.object({
      enabled: z.boolean(),
      transports: z.array(remoteSurfaceTransportSchema).min(1),
      relayOnly: z.boolean(),
    }),
    code: z.object({
      enabled: z.boolean(),
      transport: codeTransportSchema,
      isolatedOrigin: z.literal(true),
    }),
  }),
});

export type ServerBootstrap = z.infer<typeof serverBootstrapSchema>;

export const desktopUpdateActiveWorkSummarySchema = z.object({
  activeChats: z.number().int().nonnegative().max(4_294_967_295),
  queuedPrompts: z.number().int().nonnegative().max(4_294_967_295),
  terminalServices: z.number().int().nonnegative().max(4_294_967_295),
  backgroundJobs: z.number().int().nonnegative().max(4_294_967_295),
});

export type DesktopUpdateActiveWorkSummary = z.infer<
  typeof desktopUpdateActiveWorkSummarySchema
>;
