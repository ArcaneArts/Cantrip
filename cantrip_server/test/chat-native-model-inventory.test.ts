import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nativeChatModelInventorySchema } from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { installChatNativeModelInventoryRoutes } from "../src/app/routes/chat-native-model-inventory.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
import { protectedSecretEnvelopeFixture } from "./protected-provider-credential-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let providerId: string;
let routeId: string;
let otherProviderId: string;
let ownerId = LOCAL_USER_ID;
let epoch = 0;
const app = Fastify();
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
  const provider = await fixture.repository.createModelProvider(ownerId, {
    name: "Scoped inventory",
    kind: "openai-compatible",
    baseUrl: "https://fixture.invalid/v1",
    protectedApiKey: protectedSecretEnvelopeFixture("Z"),
  });
  providerId = provider.id;
  const other = await fixture.repository.createModelProvider(ownerId, {
    name: "Other inventory",
    kind: "openai-compatible",
    baseUrl: "https://other.invalid/v1",
  });
  otherProviderId = other.id;
  const selected = await fixture.repository.createModelProfile(ownerId, {
    name: "Selected alias",
    routes: [
      { providerId, modelName: "selected-native", enabled: true },
      {
        providerId: otherProviderId,
        modelName: "other-provider-only",
        enabled: true,
      },
      { providerId, modelName: "disabled-native", enabled: false },
    ],
  });
  routeId = selected!.routes.find(
    (route) => route.modelName === "selected-native",
  )!.id;
  await fixture.repository.createModelProfile(ownerId, {
    name: "Another eligible model",
    routes: [{ providerId, modelName: "eligible-native", enabled: true }],
  });
  await selectRoute(routeId);
  installChatNativeModelInventoryRoutes(app, {
    applicationOwnerId: () => ownerId,
    repository: fixture.repository,
  });
}, 60_000);
afterAll(async () => {
  await app.close();
  await fixture?.close();
});
async function selectRoute(
  modelRouteId: string,
  providerAccountId: string | null = null,
) {
  await fixture.db
    .update(schema.chatRuntimeSessions)
    .set({ modelRouteId, providerAccountId })
    .where(eq(schema.chatRuntimeSessions.chatId, fixture.chatId));
}
async function bind() {
  return (
    await fixture.commands.refreshSettingsState(
      LOCAL_USER_ID,
      fixture.chatId,
      async (scope) => ({
        context: {
          chatId: scope.chatId,
          workerId: scope.workerId,
          threadId: scope.threadId,
          runtimeGeneration: "runtime-one",
          settingsVersion: {
            epoch: `inventory-core-${++epoch}`,
            revision: "1",
          },
        },
        contentFingerprint: "a".repeat(64),
        protectedContent: settingsEnvelope,
      }),
    )
  ).binding!;
}
const url = (bindingId: string) =>
  `/api/chats/${fixture.chatId}/native-settings/models?bindingId=${bindingId}`;

describe("public native model inventory", () => {
  it("returns only eligible routes from the canonical provider without credentials or native reads", async () => {
    const binding = await bind();
    const before = await fixture.commands.settingsState(
      ownerId,
      fixture.chatId,
    );
    const result = await app.inject({
      method: "GET",
      url: url(binding.bindingId),
    });
    expect(result.statusCode).toBe(200);
    const inventory = nativeChatModelInventorySchema.parse(result.json());
    expect(inventory).toMatchObject({
      bindingId: binding.bindingId,
      workerId: fixture.workerId,
      providerId,
      providerAccountId: null,
    });
    expect(inventory.models.map((model) => model.name)).toEqual([
      "eligible-native",
      "selected-native",
    ]);
    expect(
      inventory.models.find((model) => model.name === "selected-native")
        ?.routeId,
    ).toBe(routeId);
    expect(result.body).not.toMatch(
      /protectedApiKey|ciphertext|baseUrl|credentialHomeKey|profileName/,
    );
    expect(
      await fixture.commands.settingsState(ownerId, fixture.chatId),
    ).toEqual(before);
  });

  it("requires an exact binding and authenticated owner instead of accepting caller provider routing", async () => {
    const binding = await bind();
    for (const target of [
      `/api/chats/${fixture.chatId}/native-settings/models`,
      `${url(binding.bindingId)}&providerId=${otherProviderId}`,
    ])
      expect(
        (await app.inject({ method: "GET", url: target })).statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: url("replaced-binding") }))
        .statusCode,
    ).toBe(409);
    ownerId = "another-owner";
    try {
      expect(
        (await app.inject({ method: "GET", url: url(binding.bindingId) }))
          .statusCode,
      ).toBe(404);
    } finally {
      ownerId = LOCAL_USER_ID;
    }
  });

  it("uses the bound account and rejects inventory finishing after account migration", async () => {
    const firstAccountId = randomUUID();
    const provider = await fixture.repository.createModelProvider(ownerId, {
      id: randomUUID(),
      name: "Account scoped",
      kind: "chatgpt",
      baseUrl: "https://account.invalid/responses",
      initialAccount: {
        id: firstAccountId,
        protectedLabel: protectedSecretEnvelopeFixture("Y"),
      },
    });
    const second = await fixture.repository.createModelProviderAccount(
      ownerId,
      provider.id,
      {
        id: randomUUID(),
        protectedLabel: protectedSecretEnvelopeFixture("X"),
      },
    );
    const selected = await fixture.repository.createModelProfile(ownerId, {
      name: "Account custom model",
      routes: [
        { providerId: provider.id, modelName: "account-custom", enabled: true },
      ],
    });
    const accountRouteId = selected!.routes[0]!.id;
    await selectRoute(accountRouteId, firstAccountId);
    const binding = await bind();
    const initial = await app.inject({
      method: "GET",
      url: url(binding.bindingId),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      providerId: provider.id,
      providerAccountId: firstAccountId,
    });
    const actualCatalog = fixture.repository.getProviderModelCatalog.bind(
      fixture.repository,
    );
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(fixture.repository, "getProviderModelCatalog")
      .mockImplementationOnce(async (...args) => {
        started();
        await waiting;
        return actualCatalog(...args);
      });
    try {
      const response = app.inject({
        method: "GET",
        url: url(binding.bindingId),
      });
      await reading;
      await selectRoute(accountRouteId, second!.id);
      release();
      const result = await response;
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe("settings-binding-replaced");
    } finally {
      release();
      spy.mockRestore();
      await selectRoute(routeId);
    }
  });

  it("rejects a route retargeted to another provider during inventory assembly", async () => {
    const binding = await bind();
    const actualCatalog = fixture.repository.getProviderModelCatalog.bind(
      fixture.repository,
    );
    const spy = vi
      .spyOn(fixture.repository, "getProviderModelCatalog")
      .mockImplementationOnce(async (...args) => {
        await fixture.db
          .update(schema.modelRoutes)
          .set({ providerId: otherProviderId })
          .where(eq(schema.modelRoutes.id, routeId));
        return actualCatalog(...args);
      });
    try {
      const result = await app.inject({
        method: "GET",
        url: url(binding.bindingId),
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe("settings-binding-replaced");
    } finally {
      spy.mockRestore();
      await fixture.db
        .update(schema.modelRoutes)
        .set({ providerId })
        .where(eq(schema.modelRoutes.id, routeId));
    }
  });
});
