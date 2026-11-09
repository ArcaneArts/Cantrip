import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { workerCommandSchema, type WorkerCommand } from "@cantrip/protocol";
import { CantripOsController } from "../../../cantrip_worker/src/os-executor/controller.js";
import { workspaceControl } from "../../../cantrip_worker/src/os-executor/connection.js";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import * as schema from "../src/db/schema.js";

it.skipIf(!process.env.CANTRIP_OS_TEST_CONTAINER)(
  "recovers actual guest workspace creation from a private Worker journal after a lost reply and Server restart",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cantrip-workspace-create-actual-"),
    );
    const ownerId = "00000000-0000-4000-8000-000000000001",
      workerId = "00000000-0000-4000-8000-000000000002";
    const transport = {
      kind: "docker" as const,
      container: process.env.CANTRIP_OS_TEST_CONTAINER!,
    };
    const workerDirectory = join(directory, "worker");
    let controller = new CantripOsController(workerDirectory, workerId);
    const actual = (await controller.handle({
      type: "cantrip-os.inspect",
      ownerId,
      workerId,
      transport,
    })) as { guestInstanceId: string; runtimeGeneration: string };
    let database = new PGlite(join(directory, "database")),
      app = Fastify();
    let repository = new CantripOsRepository(
      drizzle(database, { schema }) as RepositoryDatabase,
    );
    let lose = true,
      creates = 0;
    const commands: WorkerCommand[] = [];
    const install = () =>
      installCantripOsRoutes(app, {
        applicationOwnerId: () => ownerId,
        serverId: "cantrip-workspace-create-actual",
        repository: {
          cantripOs: repository,
          getWorker: async () => ({ id: workerId }),
        } as unknown as Pick<ServerRepository, "cantripOs" | "getWorker">,
        bridge: {
          request: async (_worker, command) => {
            workerCommandSchema.parse(command);
            commands.push(structuredClone(command));
            if (
              command.type !== "cantrip-os.workspaces.create" &&
              command.type !== "cantrip-os.operation.inspect"
            )
              throw new Error("Unexpected command");
            if (command.type === "cantrip-os.workspaces.create") creates++;
            const result = await controller.handle(command);
            if (lose) {
              lose = false;
              throw new Error("Lost reply after actual guest create");
            }
            return result;
          },
        },
      });
    try {
      const migrations = fileURLToPath(
        new URL("../../../cantrip_server/drizzle", import.meta.url),
      );
      for (const name of (await readdir(migrations)).sort()) {
        if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
        const sql = await readFile(join(migrations, name), "utf8");
        if (Number(name.slice(0, 4)) < 243) await database.exec(sql);
        else
          for (const part of sql.split("--> statement-breakpoint"))
            if (part.trim()) await database.query(part);
      }
      await database.query(
        "INSERT INTO users(id,kind,display_name) VALUES($1,'anonymous','Owner')",
        [ownerId],
      );
      await database.query(
        "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','linux','arm64',now(),now())",
        [workerId, ownerId],
      );
      const instance = await repository.attach(ownerId, {
        workerId,
        guestInstanceId: actual.guestInstanceId,
        transport,
        name: "Actual guest",
        expectedAttachmentGeneration: null,
      });
      await database.query(
        "UPDATE cantrip_os_instances SET status='connected',runtime_generation=$1 WHERE id=$2",
        [actual.runtimeGeneration, instance.id],
      );
      const scope = {
        ownerId,
        workerId,
        serverId: "cantrip-workspace-create-actual",
        instanceId: instance.id,
        guestInstanceId: actual.guestInstanceId,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: actual.runtimeGeneration,
      };
      await controller.handle({ type: "cantrip-os.attach", scope, transport });
      install();
      const input = {
        operationId: randomUUID(),
        guestWorkspaceId: `adm-${randomUUID().slice(0, 12)}`,
      };
      const base = `/api/cantrip-os/${instance.id}`;
      const first = await app.inject({
        method: "POST",
        url: `${base}/workspaces`,
        payload: input,
      });
      expect(first.json()).toMatchObject({
        operationId: input.operationId,
        state: "unknown",
      });
      const guest = await workspaceControl<Record<string, unknown>>(transport, [
        "show",
        input.guestWorkspaceId,
      ]);
      const privateRecord = await controller.operations.inspect(
        scope,
        input.operationId,
      );
      expect(privateRecord).toMatchObject({
        state: "ready",
        command: "cantrip-os.workspaces.create",
      });
      await app.close();
      await database.close();
      database = new PGlite(join(directory, "database"));
      repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      controller = new CantripOsController(workerDirectory, workerId);
      app = Fastify();
      install();
      const recovered = await app.inject({
        method: "POST",
        url: `${base}/workspace-operations/${input.operationId}/observe`,
      });
      expect(recovered.json()).toMatchObject({
        operationId: input.operationId,
        state: "ready",
        receipt: {
          kind: "workspace",
          workspace: {
            guestWorkspaceId: input.guestWorkspaceId,
            uid: guest.uid,
          },
        },
      });
      expect(creates).toBe(1);
      expect(
        await workspaceControl(transport, ["show", input.guestWorkspaceId]),
      ).toEqual(guest);
      expect(
        (await repository.listWorkspaces(ownerId, instance.id))[0],
      ).toMatchObject({
        guestWorkspaceId: input.guestWorkspaceId,
        uid: guest.uid,
        gid: guest.gid,
        homeGuestPath: guest.home,
      });
      await database.query(
        "UPDATE cantrip_os_instances SET attachment_generation=$1,runtime_generation=$2 WHERE id=$3",
        [randomUUID(), randomUUID(), instance.id],
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/workspaces`,
            payload: input,
          })
        ).json().state,
      ).toBe("ready");
      expect(
        commands.filter((c) => c.type === "cantrip-os.workspaces.create"),
      ).toHaveLength(1);
      expect(
        (await controller.operations.inspect(scope, input.operationId))
          ?.startedAt,
      ).toBe(privateRecord!.startedAt);
      console.info(
        JSON.stringify({
          evidence: directory,
          instanceId: instance.id,
          operationId: input.operationId,
          guestWorkspaceId: input.guestWorkspaceId,
          uid: guest.uid,
          creates,
        }),
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
);
