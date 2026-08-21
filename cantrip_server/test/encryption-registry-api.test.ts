import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  accountEncryptionProfileInitializeResultSchema,
  accountEncryptionProfileSchema,
  accountEncryptionProfileStateSchema,
  encryptionKeyGrantListSchema,
  encryptionKeyGrantSchema,
  encryptionPrincipalListSchema,
  encryptionPrincipalSchema,
  workerEncryptionBootstrapResultSchema,
  type AccountEncryptionProfileInitialize,
  type EncryptionPublicKey,
  type WorkerComponentKeyGrant,
} from "@cantrip/protocol/encryption";
import {
  unavailableCodeCapabilities,
  unprobedCodexRuntimeReport,
  type WorkerHeartbeat,
} from "@cantrip/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashPassword, hashSecret } from "../src/auth/service.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

const origin = "https://app.cantrip.test";
const bootstrapToken = "encryption-registry-bootstrap-token";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];
const zero32 = Buffer.alloc(32).toString("base64url");
const zero48 = Buffer.alloc(48).toString("base64url");
const zero65 = Buffer.alloc(65).toString("base64url");

const publicKey: EncryptionPublicKey = {
  version: 1,
  algorithm: "P-256",
  format: "raw",
  value: zero65,
};

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected session cookie.");
  return cookie.split(";", 1)[0]!;
}

function authHeaders(response: {
  headers: Record<string, unknown>;
  json(): unknown;
}) {
  const payload = response.json() as { csrfToken: string };
  return {
    cookie: sessionCookie(response),
    origin,
    "x-cantrip-csrf": payload.csrfToken,
  };
}

function initialProfile(clientId: string): AccountEncryptionProfileInitialize {
  const kdf = {
    algorithm: "Argon2id" as const,
    version: 19 as const,
    context: "cantrip:e2ee:password-kek:v1" as const,
    memoryKiB: 65_536,
    iterations: 3,
    parallelism: 1,
    outputBytes: 32 as const,
    salt: zero32,
  };
  return {
    profile: {
      formatVersion: 1,
      activeMasterKeyRevision: 1,
      passwordKdf: kdf,
      passwordWrappedMasterKey: {
        version: 1,
        purpose: "password-wrapped-account-master-key",
        masterKeyRevision: 1,
        kdf,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: zero48,
        },
      },
      payloadMigrationStatus: "pending",
    },
    initialClient: {
      id: clientId,
      label: "Primary browser",
      publicKey,
      wrappedMasterKey: {
        version: 1,
        purpose: "client-account-master-key",
        clientId,
        masterKeyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "HPKE-RFC9180",
          suite: {
            mode: "base",
            kem: "DHKEM(P-256,HKDF-SHA256)",
            kdf: "HKDF-SHA256",
            aead: "AES-256-GCM",
          },
          encapsulatedKey: zero65,
          ciphertext: zero48,
        },
      },
    },
  };
}

function localInitialProfile(
  clientId: string,
): AccountEncryptionProfileInitialize {
  const initialization = initialProfile(clientId);
  return {
    ...initialization,
    profile: {
      ...initialization.profile,
      passwordKdf: null,
      passwordWrappedMasterKey: null,
    },
  };
}

function workerHeartbeat(workerId: string): WorkerHeartbeat {
  return {
    workerId,
    name: "Encryption Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      iceTransportPolicies: ["relay"],
      maxSessions: 4,
    },
    code: unavailableCodeCapabilities,
    startedAt: new Date().toISOString(),
  };
}

function workerGrant(workerId: string): WorkerComponentKeyGrant {
  return {
    version: 1,
    purpose: "worker-component-key",
    workerId,
    component: "chat-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "HPKE-RFC9180",
      suite: {
        mode: "base",
        kem: "DHKEM(P-256,HKDF-SHA256)",
        kdf: "HKDF-SHA256",
        aead: "AES-256-GCM",
      },
      encapsulatedKey: zero65,
      ciphertext: zero48,
    },
  };
}

async function createConfig(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-encryption-registry-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: bootstrapToken,
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode: "accounts",
    authRateLimit: 20,
    bootstrapMode: "hosted",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "hosted",
    host: "0.0.0.0",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    publicRegistration: false,
    secretEncryption: {
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 8) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "encryption-registry-worker-token",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("opaque encryption registry", () => {
  it("registers an authenticated local bootstrap worker without a credential row", async () => {
    const hostedConfig = await createConfig();
    const config: ServerConfig = {
      ...hostedConfig,
      adminBootstrapToken: undefined,
      authMode: "none",
      bootstrapMode: "pnpm-dev",
      cookieSameSite: "lax",
      cookieSecure: false,
      deploymentMode: "local",
      host: "127.0.0.1",
      publicRegistration: false,
      workerToken: "local-development-token",
    };
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/encryption/profile/initialize",
            payload: localInitialProfile(
              "11111111-1111-4111-8111-111111111111",
            ),
          })
        ).statusCode,
      ).toBe(201);

      const workerId = "local-encryption-worker";
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/heartbeat",
            headers: {
              authorization: `Bearer ${config.workerToken}`,
            },
            payload: workerHeartbeat(workerId),
          })
        ).statusCode,
      ).toBe(202);

      const principalId = "33333333-3333-4333-8333-333333333333";
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/workers/encryption/bootstrap",
        headers: {
          authorization: `Bearer ${config.workerToken}`,
          "x-cantrip-worker-id": workerId,
        },
        payload: { principalId, publicKey },
      });

      expect(response.statusCode).toBe(200);
      const initialBootstrap = workerEncryptionBootstrapResultSchema.parse(
        response.json(),
      );
      expect(initialBootstrap).toMatchObject({
        principal: {
          id: principalId,
          state: "pending",
          workerId,
        },
        grants: [],
      });

      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/encryption/principals/${principalId}/approve`,
            payload: { expectedRevision: initialBootstrap.principal.revision },
          })
        ).statusCode,
      ).toBe(200);

      const replacementPrincipalId = "44444444-4444-4444-8444-444444444444";
      const replacementPublicKey: EncryptionPublicKey = {
        ...publicKey,
        value: Buffer.alloc(65, 1).toString("base64url"),
      };
      const replacementRequest = () =>
        app.inject({
          method: "POST",
          url: "/api/internal/workers/encryption/bootstrap",
          headers: {
            authorization: `Bearer ${config.workerToken}`,
            "x-cantrip-worker-id": workerId,
          },
          payload: {
            principalId: replacementPrincipalId,
            publicKey: replacementPublicKey,
          },
        });
      const replacementResponses = await Promise.all([
        replacementRequest(),
        replacementRequest(),
      ]);
      for (const replacementResponse of replacementResponses) {
        expect(replacementResponse.statusCode).toBe(200);
        expect(
          workerEncryptionBootstrapResultSchema.parse(
            replacementResponse.json(),
          ),
        ).toMatchObject({
          principal: {
            id: replacementPrincipalId,
            state: "pending",
            workerId,
          },
          grants: [],
        });
      }

      const principals = encryptionPrincipalListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/encryption/principals",
          })
        ).json(),
      );
      expect(principals.find(({ id }) => id === principalId)).toMatchObject({
        state: "revoked",
      });
      expect(
        principals.find(({ id }) => id === replacementPrincipalId),
      ).toMatchObject({ state: "pending", publicKey: replacementPublicKey });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("uses race-safe initialization and isolates opaque principals and grants", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      const ownerResponse = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin, "x-cantrip-bootstrap-token": bootstrapToken },
        payload: {
          displayName: "Encryption Owner",
          email: "owner@example.com",
          password,
        },
      });
      expect(ownerResponse.statusCode).toBe(201);
      const owner = ownerResponse.json().currentUser as { id: string };
      const ownerHeaders = authHeaders(ownerResponse);
      const clientId = "11111111-1111-4111-8111-111111111111";
      const initialization = initialProfile(clientId);

      const firstInitialization = await app.inject({
        method: "POST",
        url: "/api/encryption/profile/initialize",
        headers: ownerHeaders,
        payload: initialization,
      });
      expect(firstInitialization.statusCode).toBe(201);
      const initialized = accountEncryptionProfileInitializeResultSchema.parse(
        firstInitialization.json(),
      );
      expect(initialized.created).toBe(true);
      if (!initialized.created) throw new Error("Profile was not initialized.");
      expect(initialized.profile.passwordKdf).toEqual(
        initialization.profile.passwordKdf,
      );
      expect(initialized.profile.passwordWrappedMasterKey).toEqual(
        initialization.profile.passwordWrappedMasterKey,
      );
      expect(initialized.grant.wrappedKey).toEqual(
        initialization.initialClient.wrappedMasterKey,
      );

      const losingInitialization = await app.inject({
        method: "POST",
        url: "/api/encryption/profile/initialize",
        headers: ownerHeaders,
        payload: initialProfile("22222222-2222-4222-8222-222222222222"),
      });
      expect(losingInitialization.statusCode).toBe(409);
      expect(
        accountEncryptionProfileInitializeResultSchema.parse(
          losingInitialization.json(),
        ),
      ).toMatchObject({ created: false, profile: initialized.profile });

      const storedProfile = accountEncryptionProfileStateSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/encryption/profile",
            headers: ownerHeaders,
          })
        ).json(),
      );
      expect(storedProfile).toEqual({
        status: "initialized",
        profile: initialized.profile,
      });

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/reauthenticate",
            headers: ownerHeaders,
            payload: { password: "incorrect password" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/reauthenticate",
            headers: ownerHeaders,
            payload: { password },
          })
        ).statusCode,
      ).toBe(200);

      const replacementKdf = {
        ...initialization.profile.passwordKdf!,
        salt: Buffer.alloc(32, 7).toString("base64url"),
      };
      const replacementWrapper = {
        ...initialization.profile.passwordWrappedMasterKey!,
        kdf: replacementKdf,
        envelope: {
          ...initialization.profile.passwordWrappedMasterKey!.envelope,
          nonce: Buffer.alloc(12, 7).toString("base64url"),
          ciphertext: Buffer.alloc(48, 7).toString("base64url"),
        },
      };
      const changedPassword = "a different correct password";
      const passwordChange = {
        currentPassword: password,
        newPassword: changedPassword,
        expectedProfileRevision: initialized.profile.revision,
        passwordKdf: replacementKdf,
        passwordWrappedMasterKey: replacementWrapper,
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/account/password",
            headers: ownerHeaders,
            payload: {
              ...passwordChange,
              currentPassword: "incorrect password",
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        accountEncryptionProfileStateSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/encryption/profile",
              headers: ownerHeaders,
            })
          ).json(),
        ),
      ).toEqual(storedProfile);

      const passwordChangeResponse = await app.inject({
        method: "POST",
        url: "/api/account/password",
        headers: ownerHeaders,
        payload: passwordChange,
      });
      expect(passwordChangeResponse.statusCode).toBe(200);
      const changedProfile = accountEncryptionProfileSchema.parse(
        passwordChangeResponse.json(),
      );
      expect(changedProfile.passwordWrappedMasterKey).toEqual(
        replacementWrapper,
      );
      expect(changedProfile.activeMasterKeyRevision).toBe(
        initialized.profile.activeMasterKeyRevision,
      );
      expect(changedProfile.revision).toBe(initialized.profile.revision + 1);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            headers: { origin },
            payload: { email: "owner@example.com", password },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            headers: { origin },
            payload: { email: "owner@example.com", password: changedPassword },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        encryptionKeyGrantListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/encryption/principals/${clientId}/grants`,
              headers: ownerHeaders,
            })
          ).json(),
        )[0]?.wrappedKey,
      ).toEqual(initialization.initialClient.wrappedMasterKey);

      const staleMigration = await app.inject({
        method: "PATCH",
        url: "/api/encryption/profile/migration",
        headers: ownerHeaders,
        payload: {
          expectedRevision: changedProfile.revision,
          payloadMigrationStatus: "in-progress",
        },
      });
      expect(staleMigration.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/encryption/profile/migration",
            headers: ownerHeaders,
            payload: {
              expectedRevision: changedProfile.revision,
              payloadMigrationStatus: "complete",
            },
          })
        ).statusCode,
      ).toBe(409);

      const otherUser = await database.repository.createAccount({
        displayName: "Other Account",
        email: "other@example.com",
        normalizedEmail: "other@example.com",
        passwordHash: await hashPassword(password),
        role: "member",
      });
      const otherLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: otherUser.email, password },
      });
      const otherHeaders = authHeaders(otherLogin);
      const workerId = "encryption-worker-1";
      const workerCredential = `ctwk_${"a".repeat(43)}`;
      const enrollmentCodeHash = "encryption-worker-code-hash";
      await database.repository.createWorkerEnrollmentCode({
        codeHash: enrollmentCodeHash,
        createdBySessionId: null,
        expiresAt: new Date(Date.now() + 60_000),
        label: "Encryption Worker",
        ownerId: owner.id,
      });
      await database.repository.exchangeWorkerEnrollmentCode({
        codeHash: enrollmentCodeHash,
        credentialHash: hashSecret(workerCredential),
        credentialId: "44444444-4444-4444-8444-444444444444",
        heartbeat: workerHeartbeat(workerId),
        replacement: null,
        scopes: ["worker:connect"],
      });
      const workerPrincipalId = "33333333-3333-4333-8333-333333333333";

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/encryption/principals",
            headers: otherHeaders,
            payload: {
              id: workerPrincipalId,
              kind: "worker",
              workerId,
              label: "Foreign worker",
              publicKey,
            },
          })
        ).statusCode,
      ).toBe(409);

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/encryption/bootstrap",
            headers: {
              authorization: "Bearer invalid-worker-credential",
              "x-cantrip-worker-id": workerId,
            },
            payload: { principalId: workerPrincipalId, publicKey },
          })
        ).statusCode,
      ).toBe(401);

      const principalResponse = await app.inject({
        method: "POST",
        url: "/api/internal/workers/encryption/bootstrap",
        headers: {
          authorization: `Bearer ${workerCredential}`,
          "x-cantrip-worker-id": workerId,
        },
        payload: { principalId: workerPrincipalId, publicKey },
      });
      expect(principalResponse.statusCode).toBe(200);
      const pendingBootstrap = workerEncryptionBootstrapResultSchema.parse(
        principalResponse.json(),
      );
      const pending = pendingBootstrap.principal;
      expect(pending.state).toBe("pending");
      expect(pendingBootstrap.grants).toEqual([]);
      expect(
        encryptionPrincipalListSchema.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/encryption/principals",
              headers: otherHeaders,
            })
          ).json(),
        ),
      ).toEqual([]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/encryption/principals/${workerPrincipalId}/grants`,
            headers: otherHeaders,
          })
        ).statusCode,
      ).toBe(404);

      const approvedResponse = await app.inject({
        method: "POST",
        url: `/api/encryption/principals/${workerPrincipalId}/approve`,
        headers: ownerHeaders,
        payload: { expectedRevision: pending.revision },
      });
      const approved = encryptionPrincipalSchema.parse(approvedResponse.json());
      expect(approved.state).toBe("approved");
      const opaqueGrant = workerGrant(workerId);
      const grantResponse = await app.inject({
        method: "POST",
        url: `/api/encryption/principals/${workerPrincipalId}/grants`,
        headers: ownerHeaders,
        payload: {
          component: "chat-content",
          keyRevision: 1,
          wrappedKey: opaqueGrant,
        },
      });
      expect(grantResponse.statusCode).toBe(201);
      expect(
        encryptionKeyGrantSchema.parse(grantResponse.json()).wrappedKey,
      ).toEqual(opaqueGrant);
      const workerBootstrap = workerEncryptionBootstrapResultSchema.parse(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/workers/encryption/bootstrap",
            headers: {
              authorization: `Bearer ${workerCredential}`,
              "x-cantrip-worker-id": workerId,
            },
            payload: { principalId: workerPrincipalId, publicKey },
          })
        ).json(),
      );
      expect(workerBootstrap.ownerId).toBe(owner.id);
      expect(workerBootstrap.grants).toHaveLength(1);
      expect(workerBootstrap.grants[0]?.wrappedKey).toEqual(opaqueGrant);

      const revokedResponse = await app.inject({
        method: "POST",
        url: `/api/encryption/principals/${workerPrincipalId}/revoke`,
        headers: ownerHeaders,
        payload: {
          expectedRevision: approved.revision,
          reason: "worker authorization removed",
        },
      });
      expect(
        encryptionPrincipalSchema.parse(revokedResponse.json()).state,
      ).toBe("revoked");
      const revokedWorkerBootstrap =
        workerEncryptionBootstrapResultSchema.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/internal/workers/encryption/bootstrap",
              headers: {
                authorization: `Bearer ${workerCredential}`,
                "x-cantrip-worker-id": workerId,
              },
              payload: { principalId: workerPrincipalId, publicKey },
            })
          ).json(),
        );
      expect(revokedWorkerBootstrap.principal.state).toBe("revoked");
      expect(revokedWorkerBootstrap.grants).toEqual([]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/encryption/principals/${workerPrincipalId}/grants`,
            headers: ownerHeaders,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/encryption/principals/${workerPrincipalId}/grants`,
            headers: ownerHeaders,
            payload: {
              component: "chat-content",
              keyRevision: 2,
              wrappedKey: { ...opaqueGrant, keyRevision: 2 },
            },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("keeps registry code free of endpoint decryption dependencies", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const registrySource = await readFile(
      new URL("../src/db/encryption-registry.ts", import.meta.url),
      "utf8",
    );
    expect(packageJson.dependencies?.["@cantrip/crypto"]).toBeUndefined();
    expect(registrySource).not.toContain("@cantrip/crypto");
    expect(registrySource).not.toMatch(/\b(?:decrypt|deriveKey|unwrap)\b/u);
  });
});
