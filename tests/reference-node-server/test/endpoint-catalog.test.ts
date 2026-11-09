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

it("discovers each native backend on its worker and isolates catalogs by instance", async () => {
  const client = new PGlite();
  try {
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL("../../../cantrip_server/drizzle", import.meta.url),
      ),
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
    await client.query(
      "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker-a',$1,'Worker','linux','x64',now(),now())",
      [LOCAL_USER_ID],
    );
    let context = 4096;
    let fail = false;
    const observed: Array<{
      worker: string;
      provider: string;
      kind: string;
      url: string;
    }> = [];
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
      async request(worker, command) {
        if (command.type !== "model.endpoint.catalog")
          throw new Error("Unexpected command");
        observed.push({
          worker,
          provider: command.provider.id,
          kind: command.provider.kind,
          url: command.provider.baseUrl,
        });
        if (fail) throw new Error("Fixture offline");
        return {
          models: [
            normalizeEndpointModel({
              id: "same-model",
              context_length: context,
              loaded: false,
            }),
          ],
          observedAt: new Date().toISOString(),
        };
      },
    } satisfies WorkerCommandBus;
    const service = new OllamaCatalogService(repository, bridge);
    for (const kind of endpointProviderKinds) {
      const first = await repository.createModelProvider(LOCAL_USER_ID, {
        name: `${kind} first`,
        kind,
        baseUrl: `http://${kind}-a.lan/v1`,
      });
      const second = await repository.createModelProvider(LOCAL_USER_ID, {
        name: `${kind} second`,
        kind,
        baseUrl: `http://${kind}-b.lan/v1`,
      });
      context = 4096;
      const a = await service.getProviderCatalog(
        LOCAL_USER_ID,
        first.id,
        "worker-a",
        true,
      );
      context = 8192;
      const b = await service.getProviderCatalog(
        LOCAL_USER_ID,
        second.id,
        "worker-a",
        true,
      );
      expect(a?.models[0]).toMatchObject({
        providerId: first.id,
        nativeModelId: "same-model",
        contextWindow: 4096,
        supportsTools: null,
        loaded: false,
      });
      expect(b?.models[0]).toMatchObject({
        providerId: second.id,
        nativeModelId: "same-model",
        contextWindow: 8192,
        supportsTools: null,
      });
      expect(a?.models[0]?.id).not.toBe(b?.models[0]?.id);
      fail = true;
      const stale = await service.getProviderCatalog(
        LOCAL_USER_ID,
        first.id,
        "worker-a",
        true,
      );
      expect(stale?.servedStale).toBe(true);
      expect(stale?.models[0]?.contextWindow).toBe(4096);
      expect(
        (await repository.getProviderModelCatalog(LOCAL_USER_ID, second.id))
          ?.models[0]?.contextWindow,
      ).toBe(8192);
      fail = false;
      expect(
        await service.getProviderCatalog(
          "another-owner",
          first.id,
          "worker-a",
          true,
        ),
      ).toBeNull();
      expect(observed).toContainEqual({
        worker: "worker-a",
        provider: first.id,
        kind,
        url: `http://${kind}-a.lan/v1`,
      });
    }
  } finally {
    await client.close();
  }
}, 30_000);
