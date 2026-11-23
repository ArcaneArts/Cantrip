import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { expect, it } from "vitest";
import {
  workerCommandSchema,
  type WorkerCommand,
  type CantripOsPackageOperationCommand,
} from "@cantrip/protocol";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import * as schema from "../src/db/schema.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((run) => {
    resolve = run;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

it(
  "persists package admissions without an executor, observes after Server restart and fences stale targets/results",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cantrip-packages-http-"));
    let database = new PGlite(directory);
    let db = drizzle(database, { schema }) as RepositoryDatabase;
    let repository = new CantripOsRepository(db),
      app = Fastify(),
      owner = "owner";
    const commands: WorkerCommand[] = [],
      jobs = new Map<string, Record<string, unknown>>();
    const guest = randomUUID(),
      boot = randomUUID();
    const artifact = {
      name: "cantrip-os-recovery",
      version: "0.5.0",
      architecture: "all",
      sha256: "a".repeat(64),
      bytes: 21484,
    };
    const catalog = {
      target: {
        generation: randomUUID(),
        expected: {
          guestInstanceId: guest,
          ownerId: "owner",
          workerId: "worker",
          identityPath: "/private/guest/instance.json",
        },
        bootId: boot,
        initStart: "123",
        architecture: "amd64",
        containerId: null,
      },
      installed: [
        {
          name: artifact.name,
          exitCode: 0,
          status: "install ok installed\t0.5.0\tall",
        },
      ],
      available: [artifact],
      unavailable: 0,
    };
    const envelope = {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(16).toString("base64url"),
    };
    let lose = true,
      staged = false;
    let nextStatus: (() => Promise<unknown>) | null = null;
    let nextObserve: (() => Promise<unknown>) | null = null;
    let nextInspect: (() => Promise<void>) | null = null;
    let runtime = randomUUID();
    const install = () =>
      installCantripOsRoutes(app, {
        applicationOwnerId: () => owner,
        serverId: "server",
        repository: {
          cantripOs: repository,
          getWorker: async () => ({ id: "worker" }),
        } as unknown as Pick<ServerRepository, "cantripOs" | "getWorker">,
        bridge: {
          request: async (_worker, command) => {
            workerCommandSchema.parse(command);
            commands.push(structuredClone(command));
            if (command.type === "cantrip-os.inspect") {
              const observed = {
                guestInstanceId: guest,
                runtimeGeneration: runtime,
                attachment: { ownerId: "owner", workerId: "worker" },
                workspaces: [],
              };
              const run = nextInspect;
              nextInspect = null;
              await run?.();
              return observed;
            }
            expect(command).toHaveProperty("scope");
            expect(
              (command as CantripOsPackageOperationCommand).scope,
            ).not.toHaveProperty("runtimeGeneration");
            if (command.type === "cantrip-os.packages.status") {
              const run = nextStatus;
              nextStatus = null;
              return run ? run() : structuredClone(catalog);
            }
            if (command.type !== "cantrip-os.packages.operation")
              throw new Error("Unexpected Worker command");
            const run = nextObserve;
            if (command.mode === "observe" && run) {
              nextObserve = null;
              return run();
            }
            if (command.mode === "execute") {
              const at = new Date().toISOString();
              jobs.set(command.operationId, {
                operationId: command.operationId,
                targetGeneration: command.target.generation,
                action: command.action,
                configuration: command.configuration,
                state: staged ? "unknown" : "running",
                phase: staged ? "ready-to-install" : "installing",
                startedAt: at,
                updatedAt: at,
                protectedResult: null,
                error: null,
              });
              if (lose) {
                lose = false;
                throw new Error("Lost reply /private/worker/diagnostic");
              }
            }
            const job = jobs.get(command.operationId);
            if (!job) return null;
            if (command.mode === "continue" && job.phase === "ready-to-install")
              Object.assign(job, { state: "running", phase: "installing" });
            if (command.mode === "abandon" && job.phase === "ready-to-install")
              Object.assign(job, {
                state: "failed",
                phase: "abandoned",
                protectedResult: envelope,
              });
            return structuredClone(job);
          },
        },
      });
    const get = async (url: string) => {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      return r.json();
    };
    const post = async (url: string, payload: unknown, status = 200) => {
      const r = await app.inject({
        method: "POST",
        url,
        payload: payload as never,
      });
      expect(r.statusCode, r.body).toBe(status);
      return r.json();
    };
    const statusRelease = deferred<unknown>(),
      statusStarted = deferred<void>();
    const observeRelease = deferred<unknown>(),
      observeStarted = deferred<void>();
    const inspectRelease = deferred<void>(),
      inspectStarted = deferred<void>();
    try {
      const migrations = fileURLToPath(
        new URL("../../../cantrip_server/drizzle", import.meta.url),
      );
      for (const name of (await readdir(migrations)).sort()) {
        if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
        const source = await readFile(join(migrations, name), "utf8");
        if (Number(name.slice(0, 4)) < 243) await database.exec(source);
        else
          for (const part of source.split("--> statement-breakpoint"))
            if (part.trim()) await database.query(part);
      }
      await database.exec(
        "INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','linux','x64',now(),now());",
      );
      const instance = await repository.attach(owner, {
        workerId: "worker",
        guestInstanceId: guest,
        name: "Packages",
        transport: {
          kind: "ssh",
          host: "fixture.invalid",
          port: 22,
          user: "root",
          identityFile: "/private/key",
          knownHostsFile: "/private/known-hosts",
        },
        expectedAttachmentGeneration: null,
      });
      expect(instance.runtimeGeneration).toBeNull();
      install();
      const base = `/api/cantrip-os/${instance.id}`,
        operations = `${base}/package-operations`;
      const inventory = await get(`${base}/packages`);
      expect(inventory.target).toHaveProperty("architecture", "amd64");
      expect(JSON.stringify(inventory)).not.toMatch(
        /\/private\/|identityPath|bootId|containerId/,
      );
      const request = {
        operationId: randomUUID(),
        attachmentGeneration: instance.attachmentGeneration,
        targetGeneration: inventory.target.generation,
        action: "repair",
        configuration: "preserve",
        packages: [artifact],
      };
      await post(
        operations,
        { ...request, runtimeGeneration: randomUUID() },
        400,
      );
      await post(
        operations,
        { ...request, action: "upgrade", configuration: "package-defaults" },
        400,
      );
      await post(
        operations,
        { ...request, packages: [{ ...artifact, sha256: "b".repeat(64) }] },
        409,
      );
      expect(
        commands.filter((c) => c.type === "cantrip-os.packages.operation"),
      ).toHaveLength(0);
      await db
        .update(schema.cantripOsInstances)
        .set({ runtimeGeneration: randomUUID(), status: "connected" })
        .where(eq(schema.cantripOsInstances.id, instance.id));
      nextStatus = async () => {
        statusStarted.resolve();
        return statusRelease.promise;
      };
      const oldInventory = app
        .inject({ method: "GET", url: `${base}/packages` })
        .then((r) => r.json());
      await statusStarted.promise;
      nextInspect = async () => {
        inspectStarted.resolve();
        return inspectRelease.promise;
      };
      const oldRefresh = app
        .inject({ method: "POST", url: `${base}/refresh`, payload: {} })
        .then((r) => r);
      await inspectStarted.promise;
      const initial = await post(operations, request);
      expect(initial.state).toBe("unknown");
      expect(JSON.stringify(initial)).not.toContain("/private/");
      expect(
        (await repository.packages.context(owner, instance.id)).instance
          .runtimeGeneration,
      ).toBeNull();
      statusRelease.resolve(structuredClone(catalog));
      expect((await oldInventory).target).toBeNull();
      inspectRelease.resolve();
      expect((await oldRefresh).statusCode).toBe(409);
      expect(
        (await repository.packages.context(owner, instance.id)).instance
          .runtimeGeneration,
      ).toBeNull();
      await app.close();
      await database.close();
      database = new PGlite(directory);
      db = drizzle(database, { schema }) as RepositoryDatabase;
      repository = new CantripOsRepository(db);
      app = Fastify();
      install();
      expect((await post(operations, request)).state).toBe("running");
      expect(
        commands.filter(
          (c) =>
            c.type === "cantrip-os.packages.operation" && c.mode === "execute",
        ),
      ).toHaveLength(1);
      await post(
        operations,
        { ...request, configuration: "package-defaults" },
        409,
      );
      const current = await get(`${base}/packages`);
      expect(current.target.generation).not.toBe(request.targetGeneration);
      await post(operations, { ...request, operationId: randomUUID() }, 409);
      const observedRoute = `${operations}/${request.operationId}/observe`;
      const running = structuredClone(jobs.get(request.operationId)!);
      nextObserve = async () => {
        observeStarted.resolve();
        return observeRelease.promise;
      };
      const lateRunning = app
        .inject({ method: "POST", url: observedRoute })
        .then((r) => r.json());
      await observeStarted.promise;
      Object.assign(jobs.get(request.operationId)!, {
        state: "ready",
        phase: "complete",
        protectedResult: envelope,
      });
      const completed = await post(observedRoute, {});
      expect(completed.state).toBe("ready");
      expect(completed.protectedResult).toEqual(envelope);
      observeRelease.resolve(running);
      expect(await lateRunning).toEqual(completed);
      const effects = commands.length;
      expect(await post(operations, request)).toEqual(completed);
      expect(commands).toHaveLength(effects);
      expect(
        (await repository.packages.context(owner, instance.id)).instance
          .powerEpoch,
      ).toBe(2);
      expect(
        (await get(`${operations}/${request.operationId}`)).packages,
      ).toEqual([artifact]);
      runtime = randomUUID();
      await post(`${base}/refresh`, {});
      expect(
        (await repository.packages.context(owner, instance.id)).instance
          .runtimeGeneration,
      ).toBe(runtime);
      staged = true;
      const newer = await get(`${base}/packages`);
      const continued = {
        ...request,
        operationId: randomUUID(),
        targetGeneration: newer.target.generation,
      };
      expect((await post(operations, continued)).phase).toBe(
        "ready-to-install",
      );
      const control = {
        attachmentGeneration: continued.attachmentGeneration,
        targetGeneration: continued.targetGeneration,
      };
      await post(
        `${operations}/${continued.operationId}/continue`,
        { ...control, targetGeneration: randomUUID() },
        409,
      );
      expect(
        (await post(`${operations}/${continued.operationId}/continue`, control))
          .state,
      ).toBe("running");
      const dispatched = commands.filter(
        (c): c is CantripOsPackageOperationCommand =>
          c.type === "cantrip-os.packages.operation" &&
          c.operationId === continued.operationId,
      );
      expect({ ...dispatched[1], mode: "execute" }).toEqual(dispatched[0]);
      Object.assign(jobs.get(continued.operationId)!, {
        state: "ready",
        phase: "complete",
        protectedResult: envelope,
      });
      await post(`${operations}/${continued.operationId}/observe`, {});
      const thirdStatus = await get(`${base}/packages`);
      const abandoned = {
        ...request,
        operationId: randomUUID(),
        targetGeneration: thirdStatus.target.generation,
      };
      await post(operations, abandoned);
      expect(
        (
          await post(`${operations}/${abandoned.operationId}/abandon`, {
            attachmentGeneration: abandoned.attachmentGeneration,
            targetGeneration: abandoned.targetGeneration,
          })
        ).state,
      ).toBe("failed");
      const page = await get(`${operations}?limit=1`);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const next = await get(`${operations}?limit=1&cursor=${page.nextCursor}`);
      expect(next.items[0].operationId).not.toBe(page.items[0].operationId);
      owner = "other";
      for (const url of [
        `${base}/packages`,
        operations,
        `${operations}/${request.operationId}`,
      ])
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(409);
      await post(observedRoute, {}, 409);
      owner = "owner";
      catalog.target.expected.ownerId = "other";
      expect((await get(`${base}/packages`)).target).toBeNull();
      catalog.target.expected.ownerId = "owner";
      const olderStatus = await repository.packages.beginStatus(
        owner,
        instance.id,
      );
      const newerStatus = await repository.packages.beginStatus(
        owner,
        instance.id,
      );
      catalog.target.bootId = randomUUID();
      await repository.packages.recordTarget(owner, newerStatus, catalog);
      await expect(
        repository.packages.recordTarget(owner, olderStatus, catalog),
      ).rejects.toThrow("observation changed");
      const pendingTarget = await get(`${base}/packages`);
      const pending = {
        ...request,
        operationId: randomUUID(),
        targetGeneration: pendingTarget.target.generation,
      };
      await post(operations, pending);
      const replacement = await repository.attach(owner, {
        workerId: "worker",
        guestInstanceId: guest,
        name: "Reattached",
        transport: { kind: "docker", container: "replacement" },
        expectedAttachmentGeneration: instance.attachmentGeneration,
      });
      expect(replacement.attachmentGeneration).not.toBe(
        instance.attachmentGeneration,
      );
      await post(
        `${operations}/${pending.operationId}/continue`,
        {
          attachmentGeneration: pending.attachmentGeneration,
          targetGeneration: pending.targetGeneration,
        },
        409,
      );
      await post(`${operations}/${pending.operationId}/observe`, {});
      const last = commands.at(-1) as CantripOsPackageOperationCommand;
      expect(last.mode).toBe("observe");
      expect(last.transport.kind).toBe("ssh");
      expect(last.target.generation).toBe(pending.targetGeneration);
      expect(
        (await get(`${operations}/${request.operationId}`)).protectedResult,
      ).toEqual(envelope);
    } finally {
      statusRelease.resolve(catalog);
      inspectRelease.resolve();
      observeRelease.resolve(null);
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
