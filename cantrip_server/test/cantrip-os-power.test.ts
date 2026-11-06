import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it } from "vitest";
import {
  workerCommandSchema,
  type WorkerCommand,
  cantripOsPowerOperationResultSchema,
} from "@cantrip/protocol";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import * as schema from "../src/db/schema.js";

it(
  "durably admits retained power once, fences execution, observes after restart and rotates the actual target deliberately",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cantrip-power-http-"));
    let database = new PGlite(directory),
      app = Fastify();
    let repository = new CantripOsRepository(
      drizzle(database, { schema }) as RepositoryDatabase,
    );
    let owner = "owner",
      runtime = randomUUID(),
      carrier = "a".repeat(64),
      lose = true;
    let inspectPause: Promise<void> | null = null;
    let inspectStarted: (() => void) | null = null;
    const guest = randomUUID(),
      commands: WorkerCommand[] = [],
      jobs = new Map<string, unknown>();
    let physical = {
      containerId: carrier,
      running: true,
      status: "running",
      startedAt: "2026-11-06T01:00:00Z",
      finishedAt: "0001-01-01T00:00:00Z",
    };
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
            commands.push(command);
            if (command.type === "cantrip-os.inspect") {
              const result = {
                guestInstanceId: guest,
                runtimeGeneration: runtime,
                attachment: { ownerId: "owner", workerId: "worker" },
                workspaces: [],
                powerTarget: { kind: "docker", containerId: carrier },
              };
              inspectStarted?.();
              await inspectPause;
              return result;
            }
            if (command.type === "cantrip-os.power.status") return physical;
            if (command.type !== "cantrip-os.power.operation")
              throw new Error("Unexpected command");
            if (command.mode === "observe")
              return jobs.get(command.operationId) ?? null;
            const before = { ...physical },
              after = {
                ...physical,
                running: command.action !== "stop",
                status: command.action === "stop" ? "exited" : "running",
                startedAt:
                  command.action === "restart"
                    ? new Date().toISOString()
                    : physical.startedAt,
              };
            const result = cantripOsPowerOperationResultSchema.parse({
              operationId: command.operationId,
              action: command.action,
              state: "ready",
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              error: null,
              receipt: {
                targetGeneration: command.powerTarget.generation,
                containerId: carrier,
                before,
                after,
                completionEvidence: "acknowledged-and-observed",
              },
              observation: after,
              observationError: null,
            });
            jobs.set(command.operationId, result);
            if (lose) {
              lose = false;
              throw new Error("Lost actual Worker reply fixture");
            }
            physical = after;
            return result;
          },
        },
      });
    try {
      const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
      for (const name of (await readdir(migrations)).sort()) {
        if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
        const sql = await readFile(join(migrations, name), "utf8");
        if (Number(name.slice(0, 4)) < 243) await database.exec(sql);
        else
          for (const part of sql.split("--> statement-breakpoint"))
            if (part.trim()) await database.query(part);
      }
      await database.exec(
        "INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','linux','arm64',now(),now());",
      );
      const instance = await repository.attach(owner, {
        workerId: "worker",
        guestInstanceId: guest,
        transport: { kind: "docker", container: "fixture" },
        name: "Power",
        expectedAttachmentGeneration: null,
      });
      install();
      const base = `/api/cantrip-os/${instance.id}`;
      expect(
        (await app.inject({ method: "GET", url: `${base}/power` })).json()
          .target,
      ).toBeNull();
      expect(commands).toHaveLength(0);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/recovery`,
            payload: {
              attachmentGeneration: instance.attachmentGeneration,
              runtimeGeneration: instance.runtimeGeneration,
            },
          })
        ).statusCode,
      ).toBe(200);
      const status = (
        await app.inject({ method: "GET", url: `${base}/power` })
      ).json();
      expect(status.target.kind).toBe("docker");
      expect(status.observation.running).toBe(true);
      expect(JSON.stringify(status)).not.toContain(carrier);
      const request = {
        operationId: randomUUID(),
        action: "stop",
        attachmentGeneration: instance.attachmentGeneration,
        targetGeneration: status.target.generation,
      };
      const post = (payload: unknown) =>
        app.inject({
          method: "POST",
          url: `${base}/power-operations`,
          payload: payload as object,
        });
      expect(
        (await post({ ...request, containerId: "forged" })).statusCode,
      ).toBe(400);
      const first = await post(request);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().state).toBe("unknown");
      expect(
        (await repository.attachment(owner, instance.id))?.instance.status,
      ).toBe("unknown");
      const blocked = await post({
        ...request,
        operationId: randomUUID(),
        action: "start",
      });
      expect(blocked.statusCode, blocked.body).toBe(409);
      // An owned guest observation arriving during a power operation cannot lift its fence.
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/refresh`,
            payload: {},
          })
        ).json().instance.status,
      ).toBe("unknown");
      const duringRecovery = await app.inject({
        method: "POST",
        url: `${base}/recovery`,
        payload: {
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: runtime,
        },
      });
      expect(duringRecovery.statusCode, duringRecovery.body).toBe(200);
      expect(duringRecovery.json().instance.status).toBe("unknown");
      const admitted = (
        await database.query<{ command: unknown }>(
          "SELECT command FROM cantrip_os_power_operations",
        )
      ).rows[0]!.command;
      await app.close();
      await database.close();
      database = new PGlite(directory);
      app = Fastify();
      repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      install();
      const recovered = await post(request);
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json()).toMatchObject({
        operationId: request.operationId,
        state: "ready",
        completionEvidence: "acknowledged-and-observed",
      });
      expect(
        commands.filter(
          (c) =>
            c.type === "cantrip-os.power.operation" && c.mode === "execute",
        ),
      ).toHaveLength(1);
      expect(
        (
          await database.query<{ command: unknown }>(
            "SELECT command FROM cantrip_os_power_operations",
          )
        ).rows[0]!.command,
      ).toEqual(admitted);
      expect(
        (await repository.attachment(owner, instance.id))?.instance.status,
      ).toBe("disconnected");
      expect((await post({ ...request, action: "restart" })).statusCode).toBe(
        409,
      );
      // Delayed refresh/recovery results admitted before a settled power mutation
      // cannot make its old runtime available after the active-operation fence ends.
      for (const endpoint of ["refresh", "recovery"]) {
        let release!: () => void;
        inspectPause = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          inspectStarted = resolve;
        });
        const delayed = app
          .inject({
            method: "POST",
            url: `${base}/${endpoint}`,
            payload:
              endpoint === "refresh"
                ? {}
                : {
                    attachmentGeneration: instance.attachmentGeneration,
                    runtimeGeneration: runtime,
                  },
          })
          .then((response) => response);
        await started;
        expect(
          (
            await post({
              ...request,
              operationId: randomUUID(),
              action: "restart",
            })
          ).json().state,
        ).toBe("ready");
        release();
        expect((await delayed).statusCode).toBe(409);
        inspectPause = null;
        inspectStarted = null;
        expect(
          (await repository.attachment(owner, instance.id))?.instance.status,
        ).toBe("unknown");
      }
      // The same retained container may have a fresh guest runtime; old admissions
      // retain their original runtime and no captured chat is rewritten.
      const oldRuntime = runtime;
      runtime = randomUUID();
      physical = { ...physical, startedAt: new Date().toISOString() };
      await app.inject({ method: "POST", url: `${base}/refresh`, payload: {} });
      const refreshed = (
        await app.inject({ method: "GET", url: `${base}/power` })
      ).json();
      expect(refreshed.target.generation).toBe(request.targetGeneration);
      await post(request);
      const latest = commands
        .filter((c) => c.type === "cantrip-os.power.operation")
        .at(-1)!;
      expect("scope" in latest && latest.scope.runtimeGeneration).toBe(
        oldRuntime,
      );
      expect(
        (await repository.attachment(owner, instance.id))?.instance.status,
      ).toBe("connected");
      carrier = "b".repeat(64);
      physical = { ...physical, containerId: carrier };
      runtime = randomUUID();
      await app.inject({ method: "POST", url: `${base}/refresh`, payload: {} });
      const replacement = (
        await app.inject({ method: "GET", url: `${base}/power` })
      ).json();
      expect(replacement.target.generation).not.toBe(request.targetGeneration);
      expect(
        (await post({ ...request, operationId: randomUUID() })).statusCode,
      ).toBe(409);
      const beforeOwner = commands.length;
      owner = "other";
      expect((await post(request)).statusCode).toBe(409);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base}/power-operations/${request.operationId}`,
          })
        ).statusCode,
      ).toBe(409);
      expect(commands).toHaveLength(beforeOwner);
      owner = "owner";
      const history = (
        await app.inject({
          method: "GET",
          url: `${base}/power-operations?limit=1`,
        })
      ).json();
      expect(history.items).toHaveLength(1);
      expect(history.items[0].state).toBe("ready");
      expect(history.nextCursor).not.toBeNull();
      const original = (
        await app.inject({
          method: "GET",
          url: `${base}/power-operations/${request.operationId}`,
        })
      ).json();
      expect(original.operationId).toBe(request.operationId);
      expect(original.state).toBe("ready");
    } finally {
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
