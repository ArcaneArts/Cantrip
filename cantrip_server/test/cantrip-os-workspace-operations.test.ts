import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { workerCommandSchema, type WorkerCommand } from "@cantrip/protocol";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import * as schema from "../src/db/schema.js";

it(
  "keeps workspace creation on its original admission across restart, replacement and lost replies",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cantrip-workspace-admission-"),
    );
    let database = new PGlite(directory),
      app = Fastify();
    let repository = new CantripOsRepository(
      drizzle(database, { schema }) as RepositoryDatabase,
    );
    let owner = "owner",
      lose = true,
      calls = 0;
    const commands: WorkerCommand[] = [],
      results = new Map<string, unknown>();
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
            if (command.type === "cantrip-os.operation.inspect")
              return results.get(command.operationId) ?? null;
            if (command.type !== "cantrip-os.workspaces.create")
              throw new Error("Unexpected command");
            calls++;
            const result = {
              operationId: command.operationId,
              state: "ready",
              error: null,
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              receipt: {
                kind: "workspace",
                workspace: {
                  guestWorkspaceId: command.guestWorkspaceId,
                  uid: 20000 + calls,
                  gid: 20000 + calls,
                  homeGuestPath: `/homes/${command.guestWorkspaceId}`,
                },
              },
            };
            results.set(command.operationId, result);
            if (lose) {
              lose = false;
              throw new Error("Reply lost after workspace creation");
            }
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
        guestInstanceId: randomUUID(),
        transport: { kind: "docker", container: "original" },
        name: "OS",
        expectedAttachmentGeneration: null,
      });
      const runtime = randomUUID();
      await database.query(
        "UPDATE cantrip_os_instances SET status='connected',runtime_generation=$1 WHERE id=$2",
        [runtime, instance.id],
      );
      install();
      const base = `/api/cantrip-os/${instance.id}`,
        input = {
          operationId: randomUUID(),
          guestWorkspaceId: "first",
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: runtime,
        };
      const post = (path: string, payload?: unknown) =>
        app.inject({
          method: "POST",
          url: base + path,
          ...(payload ? { payload } : {}),
        });
      expect(
        (
          await post("/workspaces", {
            ...input,
            runtimeGeneration: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post("/workspaces", {
            ...input,
            attachmentGeneration: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      expect(commands).toHaveLength(0);
      expect((await post("/workspaces", input)).json()).toMatchObject({
        operationId: input.operationId,
        state: "unknown",
      });
      expect(calls).toBe(1);
      expect(await repository.listWorkspaces(owner, instance.id)).toEqual([]);
      const admitted = await repository.workspaceOperations.get(
        owner,
        instance.id,
        input.operationId,
      );
      expect(admitted?.command.transport).toEqual({
        kind: "docker",
        container: "original",
      });
      await app.close();
      await database.close();
      database = new PGlite(directory);
      repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      app = Fastify();
      install();
      expect((await post("/workspaces", input)).json()).toMatchObject({
        operationId: input.operationId,
        state: "ready",
      });
      expect(calls).toBe(1);
      expect(commands.at(-1)).toEqual({
        type: "cantrip-os.operation.inspect",
        scope: admitted!.command.scope,
        operationId: input.operationId,
      });
      expect(await repository.listWorkspaces(owner, instance.id)).toMatchObject(
        [{ guestWorkspaceId: "first", uid: 20001 }],
      );
      const observed = await app.inject({
        method: "GET",
        url: `${base}/workspace-operations/${input.operationId}`,
      });
      expect(observed.json()).toMatchObject({
        instanceId: instance.id,
        guestWorkspaceId: "first",
        runtimeGeneration: runtime,
        state: "ready",
      });
      expect(observed.body).not.toContain('"transport"');
      expect(
        (await post("/workspaces", { ...input, guestWorkspaceId: "different" }))
          .statusCode,
      ).toBe(409);
      owner = "other";
      expect(
        (await post(`/workspace-operations/${input.operationId}/observe`))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base}/workspace-operations`,
          })
        ).statusCode,
      ).toBe(409);
      owner = "owner";

      // A durable admission whose original reply was lost cannot follow replacement.
      lose = true;
      const replaced = {
        operationId: randomUUID(),
        guestWorkspaceId: "replaced",
      };
      expect((await post("/workspaces", replaced)).json().state).toBe(
        "unknown",
      );
      const original = await repository.workspaceOperations.get(
        owner,
        instance.id,
        replaced.operationId,
      );
      await database.query(
        "UPDATE cantrip_os_instances SET attachment_generation=$1,runtime_generation=$2,transport=$3 WHERE id=$4",
        [
          randomUUID(),
          randomUUID(),
          { kind: "docker", container: "replacement" },
          instance.id,
        ],
      );
      expect((await post("/workspaces", replaced)).json().state).toBe("ready");
      expect(commands.at(-1)).toEqual({
        type: "cantrip-os.operation.inspect",
        scope: original!.command.scope,
        operationId: replaced.operationId,
      });
      expect(calls).toBe(2);
      expect(
        (await repository.listWorkspaces(owner, instance.id)).map(
          (w) => w.guestWorkspaceId,
        ),
      ).toEqual(["first"]);

      // Concurrent late replies cannot downgrade newer observation or forge receipts.
      const pending = {
        operationId: randomUUID(),
        guestWorkspaceId: "pending",
      };
      const { row } = await repository.workspaceOperations.admit(
        owner,
        instance.id,
        "server",
        pending,
      );
      const newer = await repository.workspaceOperations.beginObservation(
        owner,
        instance.id,
        pending.operationId,
      );
      await repository.workspaceOperations.unknown(newer);
      const ready = {
        operationId: pending.operationId,
        state: "ready",
        error: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        receipt: {
          kind: "workspace",
          workspace: {
            guestWorkspaceId: "pending",
            uid: 20003,
            gid: 20003,
            homeGuestPath: "/homes/pending",
          },
        },
      };
      expect(
        (await repository.workspaceOperations.record(row, ready)).state,
      ).toBe("unknown");
      expect((await repository.listWorkspaces(owner, instance.id)).length).toBe(
        1,
      );
      const fresh = await repository.workspaceOperations.beginObservation(
        owner,
        instance.id,
        pending.operationId,
      );
      await expect(
        repository.workspaceOperations.record(fresh, {
          ...ready,
          operationId: randomUUID(),
        }),
      ).rejects.toThrow("receipt");
      await expect(
        repository.workspaceOperations.record(fresh, {
          ...ready,
          receipt: {
            ...ready.receipt,
            workspace: {
              ...ready.receipt.workspace,
              guestWorkspaceId: "wrong",
            },
          },
        }),
      ).rejects.toThrow("receipt");
      expect(
        (
          await post(`/workspace-operations/${pending.operationId}/observe`)
        ).json().state,
      ).toBe("unknown");
      results.set(pending.operationId, ready);
      expect(
        (
          await post(`/workspace-operations/${pending.operationId}/observe`)
        ).json().state,
      ).toBe("ready");
      const before = commands.length;
      expect(
        (
          await post(`/workspace-operations/${pending.operationId}/observe`)
        ).json().state,
      ).toBe("ready");
      expect(commands).toHaveLength(before);
      const page = (
        await app.inject({
          method: "GET",
          url: `${base}/workspace-operations?limit=1`,
        })
      ).json();
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeTypeOf("string");
      const next = (
        await app.inject({
          method: "GET",
          url: `${base}/workspace-operations?limit=1&cursor=${page.nextCursor}`,
        })
      ).json();
      expect(next.items[0].operationId).not.toBe(page.items[0].operationId);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base}/workspace-operations?cursor=${randomUUID()}`,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await post(`/workspace-operations/${randomUUID()}/observe`))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base}/workspace-operations?limit=0`,
          })
        ).statusCode,
      ).toBe(400);
      expect(calls).toBe(2);
    } finally {
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
