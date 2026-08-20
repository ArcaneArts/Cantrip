import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

import { opaquePolicyCreate } from "./policy-encryption-fixture.js";
import { protectedProjectFields } from "./private-label-fixture.js";

const origin = "https://app.cantrip.test";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

interface TestAccount {
  cookie: string;
  csrfToken: string;
  userId: string;
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected a session cookie.");
  return cookie.split(";", 1)[0]!;
}

async function createConfig(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-tenant-authorization-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: "unused-public-registration-token-32-chars",
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode: "accounts",
    authRateLimit: 50,
    bootstrapMode: "pnpm-dev",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "hosted",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    publicRegistration: true,
    secretEncryption: {
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "tenant-authorization-worker-token",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("hosted tenant authorization", () => {
  it("isolates account resources and makes foreign identifiers indistinguishable", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });

    const register = async (
      email: string,
      displayName: string,
    ): Promise<TestAccount> => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: { displayName, email, password },
      });
      expect(response.statusCode).toBe(201);
      return {
        cookie: sessionCookie(response),
        csrfToken: response.json().csrfToken as string,
        userId: response.json().currentUser.id as string,
      };
    };
    const headers = (account: TestAccount, mutation = false) => ({
      cookie: account.cookie,
      origin,
      ...(mutation ? { "x-cantrip-csrf": account.csrfToken } : {}),
    });

    try {
      const first = await register("first@example.com", "First account");
      const second = await register("second@example.com", "Second account");

      const providerResponse = await app.inject({
        method: "POST",
        url: "/api/settings/providers",
        headers: headers(first, true),
        payload: {
          name: "First private provider",
          kind: "openai-compatible",
          baseUrl: "https://models.first.example/v1",
          apiKey: "first-private-key",
        },
      });
      expect(providerResponse.statusCode).toBe(201);
      const firstProviderId = providerResponse.json().id as string;

      const [firstSettings, secondSettings] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/api/settings",
          headers: headers(first),
        }),
        app.inject({
          method: "GET",
          url: "/api/settings",
          headers: headers(second),
        }),
      ]);
      expect(
        firstSettings
          .json()
          .providers.some(
            (provider: { id: string }) => provider.id === firstProviderId,
          ),
      ).toBe(true);
      expect(
        secondSettings
          .json()
          .providers.some(
            (provider: { id: string }) => provider.id === firstProviderId,
          ),
      ).toBe(false);

      const unknownProviderId = "00000000-0000-0000-0000-00000000ffff";
      for (const providerId of [firstProviderId, unknownProviderId]) {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/settings/providers/${providerId}`,
          headers: headers(second, true),
          payload: {
            name: "Unauthorized update",
            kind: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        });
        expect({
          body: response.json(),
          statusCode: response.statusCode,
        }).toEqual({
          body: { error: "Provider not found." },
          statusCode: 404,
        });
      }

      const project = await database.repository.createGithubProject(
        first.userId,
        {
          ...protectedProjectFields(),
          repositoryId: "private-project-one",
          nameWithOwner: "first/private-project",
          url: "https://github.com/first/private-project.git",
        },
      );
      const [firstPoliciesResponse, secondPoliciesResponse] = await Promise.all(
        [
          app.inject({
            method: "GET",
            url: "/api/policies",
            headers: headers(first),
          }),
          app.inject({
            method: "GET",
            url: "/api/policies",
            headers: headers(second),
          }),
        ],
      );
      const firstPolicies = firstPoliciesResponse.json() as {
        collectionVersion: number;
        policies: Array<{ id: string }>;
      };
      const secondPolicies = secondPoliciesResponse.json() as {
        policies: Array<{ id: string }>;
      };
      expect(firstPolicies.policies).toHaveLength(0);
      expect(secondPolicies.policies).toHaveLength(0);
      const privatePolicyResponse = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: headers(first, true),
        payload: opaquePolicyCreate("tenant-policy-secret"),
      });
      expect(privatePolicyResponse.statusCode).toBe(201);
      const privatePolicyId = privatePolicyResponse.json().id as string;
      const secondPolicyResponse = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: headers(second, true),
        payload: opaquePolicyCreate("second-tenant-policy"),
      });
      expect(secondPolicyResponse.statusCode).toBe(201);
      const unknownPolicyId = "00000000-0000-0000-0000-00000000fff0";
      for (const policyId of [privatePolicyId, unknownPolicyId]) {
        const read = await app.inject({
          method: "GET",
          url: `/api/policies/${policyId}`,
          headers: headers(second),
        });
        expect({
          body: read.json(),
          statusCode: read.statusCode,
        }).toEqual({
          body: { error: "Policy not found." },
          statusCode: 404,
        });

        const update = await app.inject({
          method: "PATCH",
          url: `/api/policies/${policyId}`,
          headers: headers(second, true),
          payload: { rowVersion: 1, enabled: false },
        });
        expect({
          body: update.json(),
          statusCode: update.statusCode,
        }).toEqual({
          body: { error: "Policy not found." },
          statusCode: 404,
        });

        const remove = await app.inject({
          method: "DELETE",
          url: `/api/policies/${policyId}`,
          headers: headers(second, true),
          payload: { rowVersion: 1 },
        });
        expect({
          body: remove.json(),
          statusCode: remove.statusCode,
        }).toEqual({
          body: { error: "Policy not found." },
          statusCode: 404,
        });
        expect(
          JSON.stringify([read.json(), update.json(), remove.json()]),
        ).not.toContain("tenant-policy-secret");
      }
      const secondPoliciesAfterCreate = await app.inject({
        method: "GET",
        url: "/api/policies",
        headers: headers(second),
      });
      const firstPoliciesAfterCreate = (
        await app.inject({
          method: "GET",
          url: "/api/policies",
          headers: headers(first),
        })
      ).json() as {
        collectionVersion: number;
        policies: Array<{ id: string }>;
      };
      expect(JSON.stringify(secondPoliciesAfterCreate.json())).not.toContain(
        "tenant-policy-secret",
      );

      expect(
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/policies`,
          headers: headers(first),
        }),
      ).toMatchObject({ statusCode: 200 });
      expect(
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/policies`,
          headers: headers(second),
        }),
      ).toMatchObject({ statusCode: 404 });
      expect(
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${project.id}/policies`,
          headers: headers(first, true),
          payload: {
            collectionVersion: firstPoliciesAfterCreate.collectionVersion,
            policyIds: [secondPolicyResponse.json().id as string],
          },
        }),
      ).toMatchObject({ statusCode: 404 });
      const privateWorkspace = await database.repository.createProjectWorkspace(
        first.userId,
        {
          name: "First private workspace",
        },
      );
      const secondPolicyCollection = secondPoliciesAfterCreate.json() as {
        collectionVersion: number;
        policies: Array<{ id: string }>;
      };
      for (const workspaceId of [
        privateWorkspace.id,
        "00000000-0000-0000-0000-00000000fff1",
      ]) {
        for (const method of ["GET", "PATCH"] as const) {
          const response = await app.inject({
            method,
            url: `/api/workspaces/${workspaceId}/policies`,
            headers: headers(second, method === "PATCH"),
            ...(method === "PATCH"
              ? {
                  payload: {
                    collectionVersion: secondPolicyCollection.collectionVersion,
                    policyIds: [secondPolicyCollection.policies[0]!.id],
                  },
                }
              : {}),
          });
          expect({
            body: response.json(),
            statusCode: response.statusCode,
          }).toEqual({
            body: {
              error:
                method === "GET"
                  ? "Workspace not found."
                  : "Policy workspace not found.",
            },
            statusCode: 404,
          });
        }
      }
      const firstProjects = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: headers(first),
      });
      const secondProjects = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: headers(second),
      });
      expect(
        firstProjects
          .json()
          .some((candidate: { id: string }) => candidate.id === project.id),
      ).toBe(true);
      expect(
        secondProjects
          .json()
          .some((candidate: { id: string }) => candidate.id === project.id),
      ).toBe(false);
      expect(
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/replicas`,
          headers: headers(first),
        }),
      ).toMatchObject({ statusCode: 200, body: "[]" });
      expect(
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/replicas`,
          headers: headers(second),
        }),
      ).toMatchObject({ statusCode: 404 });

      await database.repository.recordTokenUsage(first.userId, {
        sourceKey: "tenant-isolation-token-usage",
        projectId: project.id,
        chatId: null,
        modelRouteId: null,
        modelName: "test-model",
        providerName: "test-provider",
        providerModelName: "test-provider-model",
        usage: {
          inputTokens: 8,
          outputTokens: 5,
          totalTokens: 13,
        },
      });
      const [firstUsage, foreignUsage] = await Promise.all([
        app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/token-usage`,
          headers: headers(first),
        }),
        app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/token-usage`,
          headers: headers(second),
        }),
      ]);
      expect(firstUsage.statusCode).toBe(200);
      expect(firstUsage.json()).toMatchObject({
        total: {
          inputTokens: 8,
          outputTokens: 5,
          totalTokens: 13,
        },
      });
      expect(foreignUsage).toMatchObject({ statusCode: 404 });

      const unknownProjectId = "00000000-0000-0000-0000-00000000fffe";
      for (const projectId of [project.id, unknownProjectId]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          headers: headers(second, true),
          payload: { title: "Unauthorized chat" },
        });
        expect({
          body: response.json(),
          statusCode: response.statusCode,
        }).toEqual({
          body: { error: "Project source not found" },
          statusCode: 404,
        });
      }

      const foreignProjectCollections = [
        "automations",
        "browsers",
        "chats",
        "code-tabs",
        "explorers",
        "remote-desktops",
        "terminals",
        "views",
      ];
      for (const collection of foreignProjectCollections) {
        const response = await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/${collection}`,
          headers: headers(second),
        });
        expect(response.statusCode, collection).toBe(200);
        expect(response.json(), collection).toEqual([]);
      }

      for (const projectId of [project.id, unknownProjectId]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/browser-services`,
          headers: headers(second),
        });
        expect({
          body: response.json(),
          statusCode: response.statusCode,
        }).toEqual({
          body: { error: "Project not found." },
          statusCode: 404,
        });
      }

      await Promise.all([
        app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: headers(first, true),
          payload: { theme: "dark" },
        }),
        app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: headers(second, true),
          payload: { theme: "light" },
        }),
      ]);
      const [updatedFirst, updatedSecond] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/api/settings",
          headers: headers(first),
        }),
        app.inject({
          method: "GET",
          url: "/api/settings",
          headers: headers(second),
        }),
      ]);
      expect(updatedFirst.json().preferences.theme).toBe("dark");
      expect(updatedSecond.json().preferences.theme).toBe("light");
    } finally {
      await app.close();
    }
  }, 30_000);
});
