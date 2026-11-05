import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import {
  endpointProviderKinds,
  type ModelProviderKind,
} from "@cantrip/protocol";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { protectedSecretEnvelopeFixture } from "./protected-provider-credential-fixture.js";

it("persists repeatable endpoint instances with isolated credentials and model routes", async () => {
  const client = new PGlite();
  try {
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 9) }],
      }),
    );
    await repository.ensureLocalIdentity();
    await repository.ensureAccountConfiguration(LOCAL_USER_ID);
    const instances = [];
    for (const [index, kind] of [
      "ollama",
      "ollama",
      "ollama",
      "openai-compatible",
      "openai-compatible",
      ...endpointProviderKinds.flatMap((kind) => [kind, kind]),
    ].entries()) {
      const input = {
        kind: kind as ModelProviderKind,
        name: `Endpoint ${index}`,
        baseUrl: `http://gpu-${index}.lan:8000/proxy/v1`,
        protectedApiKey: protectedSecretEnvelopeFixture(
          String.fromCharCode(65 + index),
        ),
        maxConcurrentInference: index + 1,
      };
      const provider = await repository.createModelProvider(
        LOCAL_USER_ID,
        input,
      );
      const profile = await repository.createModelProfile(LOCAL_USER_ID, {
        name: `Model on ${index}`,
        routes: [
          {
            providerId: provider.id,
            modelName: "same-native-model",
            enabled: true,
          },
        ],
      });
      expect(profile).not.toBeNull();
      instances.push({ provider, profile: profile!, input });
    }
    expect(new Set(instances.map(({ provider }) => provider.id)).size).toBe(17);

    for (const { provider, profile, input } of instances) {
      expect(
        await repository.getModelRuntime(LOCAL_USER_ID, profile.id),
      ).toMatchObject({
        provider: {
          id: provider.id,
          kind: input.kind,
          baseUrl: input.baseUrl,
          protectedApiKey: input.protectedApiKey,
        },
        model: { name: "same-native-model" },
      });
      expect(
        await repository.getModelProvider(LOCAL_USER_ID, provider.id),
      ).toMatchObject({
        maxConcurrentInference: input.maxConcurrentInference,
      });
      expect(
        await repository.getModelProvider("another-owner", provider.id),
      ).toBeNull();
    }

    // Edit and delete one of every endpoint kind while retaining its sibling.
    const changedInstances = instances.filter(
      ({ input }, index) =>
        !instances
          .slice(0, index)
          .some(({ input: earlier }) => earlier.kind === input.kind),
    );
    for (const changed of changedInstances) {
      await repository.updateModelProvider(LOCAL_USER_ID, changed.provider.id, {
        ...changed.input,
        name: "Renamed endpoint",
        baseUrl: "http://[::1]:9000/new/v1/responses/",
        protectedApiKey: protectedSecretEnvelopeFixture("R"),
      });
      expect(
        await repository.getModelRuntime(LOCAL_USER_ID, changed.profile.id),
      ).toMatchObject({
        provider: {
          id: changed.provider.id,
          baseUrl: "http://[::1]:9000/new/v1",
        },
      });
      await repository.deleteModelProfile(LOCAL_USER_ID, changed.profile.id);
      await repository.deleteModelProvider(LOCAL_USER_ID, changed.provider.id);
      expect(
        await repository.getModelProvider(LOCAL_USER_ID, changed.provider.id),
      ).toBeNull();
    }
    for (const { provider, profile, input } of instances.filter(
      (instance) => !changedInstances.includes(instance),
    )) {
      expect(
        await repository.getModelRuntime(LOCAL_USER_ID, profile.id),
      ).toMatchObject({
        provider: {
          id: provider.id,
          baseUrl: input.baseUrl,
          protectedApiKey: input.protectedApiKey,
        },
      });
    }
  } finally {
    await client.close();
  }
}, 30_000);
