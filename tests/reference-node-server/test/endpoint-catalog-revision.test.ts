import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endpointProviderKinds } from "@cantrip/protocol";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { OllamaCatalogService } from "../src/models/ollama-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { normalizeEndpointModel } from "../../../cantrip_worker/src/endpoint-models.js";
import { protectedSecretEnvelopeFixture } from "./protected-provider-credential-fixture.js";

function inventory(kind: string, context: number) {
  return {
    observedAt: new Date().toISOString(),
    models:
      kind === "ollama"
        ? [
            {
              name: "same-model",
              modifiedAt: null,
              sizeBytes: null,
              digest: null,
              family: null,
              families: [],
              parameterSize: null,
              quantization: null,
              capabilities: ["completion", "tools"],
              modelInfo: {
                "general.architecture": "fixture",
                "fixture.context_length": context,
              },
            },
          ]
        : [
            normalizeEndpointModel({
              id: "same-model",
              context_length: context,
              supports_tool_calling: true,
              loaded: true,
            }),
          ],
  };
}

it("fences old connection successes and failures for every endpoint kind and persists provider/model selection across reopening the database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-catalog-revision-"));
  const client = new PGlite(root);
  let closed = false;
  let reopened: PGlite | undefined;
  const vault = () =>
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 9) }],
    });
  try {
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL("../../../cantrip_server/drizzle", import.meta.url),
      ),
    });
    const repository = new ServerRepository(database, vault());
    await repository.ensureLocalIdentity();
    await repository.ensureAccountConfiguration(LOCAL_USER_ID);
    await client.query(
      "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker',$1,'Worker','linux','x64',now(),now())",
      [LOCAL_USER_ID],
    );
    let context = 4096;
    let pause: { entered(): void; result: Promise<unknown> } | undefined;
    let requests = 0;
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
      async request(_worker, command) {
        if (
          command.type !== "model.endpoint.catalog" &&
          command.type !== "model.ollama.catalog"
        )
          throw new Error("Unexpected worker request");
        requests++;
        if (pause) {
          const pending = pause;
          pause = undefined;
          pending.entered();
          return pending.result;
        }
        return inventory(command.provider.kind, context);
      },
    } satisfies WorkerCommandBus;
    const service = new OllamaCatalogService(repository, bridge);
    const identities: string[] = [];
    let selectedModelId: string | undefined;
    for (const kind of ["ollama", ...endpointProviderKinds] as const) {
      context = 4096;
      const a = await repository.createModelProvider(LOCAL_USER_ID, {
        name: `${kind} A`,
        kind,
        baseUrl: `http://${kind}-a.lan/v1`,
      });
      const b = await repository.createModelProvider(LOCAL_USER_ID, {
        name: `${kind} B`,
        kind,
        baseUrl: `http://${kind}-b.lan/v1`,
      });
      identities.push(a.id, b.id);
      await service.getProviderCatalog(LOCAL_USER_ID, a.id, "worker", true);
      await service.getProviderCatalog(LOCAL_USER_ID, b.id, "worker", true);
      const profiles = (
        await repository.getSettings(LOCAL_USER_ID)
      ).models.filter((model) =>
        model.routes.some((route) => route.providerId === a.id),
      );
      expect(profiles).toHaveLength(1);
      selectedModelId = profiles[0]!.id;
      await repository.updateSettings(LOCAL_USER_ID, {
        defaultModelId: selectedModelId,
      });
      for (const oldFails of [false, true]) {
        let release!: (value: unknown) => void,
          reject!: (error: Error) => void,
          entered!: () => void;
        const received = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const result = new Promise<unknown>((resolve, fail) => {
          release = resolve;
          reject = fail;
        });
        pause = { entered, result };
        const old = service.getProviderCatalog(
          LOCAL_USER_ID,
          a.id,
          "worker",
          true,
        );
        await received;
        try {
          const previous = (await repository.getModelProvider(
            LOCAL_USER_ID,
            a.id,
          ))!;
          const saved = await repository.updateModelProvider(
            LOCAL_USER_ID,
            a.id,
            {
              name: a.name,
              kind,
              baseUrl: oldFails
                ? `http://${kind}-new.lan/v1`
                : `http://${kind}-new.lan/v1/responses/`,
              protectedApiKey: protectedSecretEnvelopeFixture(
                oldFails ? "Y" : "X",
              ),
            },
          );
          expect(saved?.connectionRevision).toBe(
            previous.connectionRevision! + 1,
          );
          const invalidated = await repository.getProviderModelCatalog(
            LOCAL_USER_ID,
            a.id,
          );
          expect(invalidated?.models[0]).toMatchObject({
            contextWindow: null,
            supportsTools: null,
            metadataSource: "manual",
          });
          expect(invalidated?.syncStates[0]).toMatchObject({
            status: "stale",
            lastSuccessAt: null,
          });
          context = oldFails ? 32768 : 16384;
          await service.getProviderCatalog(LOCAL_USER_ID, a.id, "worker", true);
          if (oldFails) reject(new Error("private-old-credential-response"));
          else release(inventory(kind, 2048));
          const superseded = await old;
          expect(superseded?.models[0]?.contextWindow).toBe(context);
          expect(superseded?.syncStates[0]?.status).toBe("current");
          expect(JSON.stringify(superseded)).not.toContain(
            "private-old-credential-response",
          );
          expect(
            (await repository.getProviderModelCatalog(LOCAL_USER_ID, b.id))
              ?.models[0]?.contextWindow,
          ).toBe(4096);
          expect(
            (await repository.getModelProvider(LOCAL_USER_ID, b.id))
              ?.connectionRevision,
          ).toBe(1);
        } finally {
          release(inventory(kind, 2048));
          await old.catch(() => undefined);
        }
      }
      const before = (await repository.getModelProvider(LOCAL_USER_ID, a.id))!;
      await repository.updateModelProvider(LOCAL_USER_ID, a.id, {
        name: `${kind} renamed`,
        kind,
        baseUrl: before.baseUrl,
        maxConcurrentInference: 2,
      });
      expect(
        (await repository.getModelProvider(LOCAL_USER_ID, a.id))
          ?.connectionRevision,
      ).toBe(before.connectionRevision);
      const count = requests;
      await service.getProviderCatalog(LOCAL_USER_ID, a.id, "worker");
      expect(requests).toBe(count);
      expect(
        (await repository.getSettings(LOCAL_USER_ID)).models
          .filter((model) =>
            model.routes.some((route) => route.providerId === a.id),
          )
          .map(({ id }) => id),
      ).toEqual(profiles.map(({ id }) => id));
    }
    await client.close();
    closed = true;
    reopened = new PGlite(root);
    const restored = await new ServerRepository(
      drizzle(reopened, { schema }),
      vault(),
    ).getSettings(LOCAL_USER_ID);
    expect(restored.preferences.defaultModelId).toBe(selectedModelId);
    expect(restored.providers.map(({ id }) => id).sort()).toEqual(
      identities.sort(),
    );
    expect(
      restored.providers.filter(
        ({ connectionRevision }) => connectionRevision === 3,
      ),
    ).toHaveLength(7);
  } finally {
    if (!closed) await client.close();
    await reopened?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
