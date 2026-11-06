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
  cantripOsDesktopOperationResultSchema,
  type CantripOsGuestDesktopTarget,
} from "@cantrip/protocol";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import * as schema from "../src/db/schema.js";

it(
  "persists immutable desktop admissions across Server restart, fences stale observations and keeps independent authority",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cantrip-desktop-http-"));
    let database = new PGlite(directory),
      app = Fastify();
    let repository = new CantripOsRepository(
      drizzle(database, { schema }) as RepositoryDatabase,
    );
    let owner = "owner",
      lose = true,
      unavailable = false;
    const runtime = randomUUID(),
      guest = randomUUID(),
      commands: WorkerCommand[] = [],
      jobs = new Map<string, unknown>();
    let physical: CantripOsGuestDesktopTarget = {
      id: "work",
      user: "ctw-work",
      uid: 20000,
      gid: 20000,
      home: "/homes/work",
      display: 100,
      generation: 1,
      desktop_generation: "a".repeat(64),
      status: "running",
    };
    let pause: Promise<void> | null = null,
      observed: (() => void) | null = null;
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
            if (unavailable)
              throw new Error("Actual transport fixture disconnected");
            if (command.type === "cantrip-os.desktop.status") {
              const snapshot = structuredClone(physical);
              observed?.();
              await pause;
              return snapshot;
            }
            if (command.type !== "cantrip-os.desktop.operation")
              throw new Error("Unexpected command");
            if (command.mode === "observe")
              return jobs.get(command.operationId) ?? null;
            const before = structuredClone(physical);
            expect(command.desktopTarget).toEqual(before);
            if (command.action === "stop") physical.status = "stopped";
            else if (
              command.action === "restart" ||
              physical.status === "stopped"
            )
              physical = {
                ...physical,
                status: "running",
                generation: physical.generation + 1,
                desktop_generation: "b".repeat(64),
              };
            const result = cantripOsDesktopOperationResultSchema.parse({
              operationId: command.operationId,
              action: command.action,
              state: "ready",
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              error: null,
              receipt: {
                targetGeneration: command.targetGeneration,
                before,
                after: structuredClone(physical),
                completionEvidence: "acknowledged-and-observed",
              },
              observation: structuredClone(physical),
              observationError: null,
            });
            jobs.set(command.operationId, result);
            if (lose) {
              lose = false;
              throw new Error("Reply lost after actual effect");
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
        guestInstanceId: guest,
        transport: { kind: "docker", container: "fixture" },
        name: "Desktop",
        expectedAttachmentGeneration: null,
      });
      await database.query(
        "UPDATE cantrip_os_instances SET status='connected',runtime_generation=$1 WHERE id=$2",
        [runtime, instance.id],
      );
      const workspace = await repository.recordWorkspace(
        owner,
        instance.id,
        instance.attachmentGeneration,
        {
          guestWorkspaceId: "work",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/homes/work",
        },
      );
      expect(workspace).not.toHaveProperty("desktopEpoch");
      const other = await repository.recordWorkspace(
        owner,
        instance.id,
        instance.attachmentGeneration,
        {
          guestWorkspaceId: "other",
          uid: 20001,
          gid: 20001,
          homeGuestPath: "/homes/other",
        },
      );
      install();
      const base = `/api/cantrip-os/${instance.id}/workspaces/${workspace.id}`;
      const status = async () =>
        (await app.inject({ method: "GET", url: `${base}/desktop` })).json();
      const post = (payload: object) =>
        app.inject({
          method: "POST",
          url: `${base}/desktop-operations`,
          payload,
        });
      const original = await status();
      expect(original.observation.status).toBe("running");
      expect(JSON.stringify(original)).not.toContain(
        physical.desktop_generation,
      );
      expect(JSON.stringify(original)).not.toContain(physical.home);
      expect((await status()).target.generation).toBe(
        original.target.generation,
      );
      const request = {
        operationId: randomUUID(),
        action: "restart",
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: runtime,
        targetGeneration: original.target.generation,
      };
      expect(
        (await post({ ...request, desktopTarget: physical })).statusCode,
      ).toBe(400);
      // Hold an actual old observation before admitting the mutation.
      let release!: () => void;
      pause = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const stale = status();
      await started;
      const first = await post(request);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().state).toBe("unknown");
      release();
      expect((await stale).target).toBeNull();
      pause = null;
      observed = null;
      expect(
        (await post({ ...request, operationId: randomUUID() })).statusCode,
      ).toBe(409);
      const admission = (
        await database.query<{ command: unknown }>(
          "SELECT command FROM cantrip_os_desktop_operations",
        )
      ).rows[0]!.command;
      const independent = await repository.attachment(owner, instance.id);
      expect(independent!.instance.status).toBe("connected");
      expect(independent!.instance.runtimeGeneration).toBe(runtime);
      expect(
        (await repository.desktop.context(owner, instance.id, other.id))
          .workspace.desktopEpoch,
      ).toBe(0);
      await app.close();
      await database.close();
      database = new PGlite(directory);
      app = Fastify();
      repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      install();
      const recovered = await post(request);
      expect(recovered.json().state).toBe("ready");
      expect(
        commands.filter(
          (c) =>
            c.type === "cantrip-os.desktop.operation" && c.mode === "execute",
        ),
      ).toHaveLength(1);
      expect(
        (
          await database.query<{ command: unknown }>(
            "SELECT command FROM cantrip_os_desktop_operations",
          )
        ).rows[0]!.command,
      ).toEqual(admission);
      expect((await post({ ...request, action: "stop" })).statusCode).toBe(409);
      expect(
        (await post({ ...request, runtimeGeneration: randomUUID() }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base.replace(workspace.id, other.id)}/desktop-operations/${request.operationId}`,
          })
        ).statusCode,
      ).toBe(409);
      owner = "other";
      expect(
        (await app.inject({ method: "GET", url: `${base}/desktop-operations` }))
          .statusCode,
      ).toBe(409);
      expect((await post(request)).statusCode).toBe(409);
      owner = "owner";
      unavailable = true;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/desktop-operations/${request.operationId}/observe`,
          })
        ).json().state,
      ).toBe("ready");
      expect((await status()).target).toBeNull();
      unavailable = false;
      const fresh = await status();
      expect(fresh.target.generation).not.toBe(original.target.generation);
      const second = {
        ...request,
        operationId: randomUUID(),
        action: "stop",
        targetGeneration: fresh.target.generation,
      };
      expect((await post(second)).json().state).toBe("ready");
      const page = (
        await app.inject({
          method: "GET",
          url: `${base}/desktop-operations?limit=1`,
        })
      ).json();
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe(second.operationId);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base}/desktop-operations?cursor=${page.nextCursor}`,
          })
        ).json().items[0].operationId,
      ).toBe(request.operationId);
      // An unjournaled uncertain operation is not replayed. An explicit changed
      // actual target may be admitted afresh while its old history remains unknown.
      const stopped = await status();
      unavailable = true;
      const lost = {
        ...request,
        operationId: randomUUID(),
        action: "start",
        targetGeneration: stopped.target.generation,
      };
      expect((await post(lost)).json().state).toBe("unknown");
      unavailable = false;
      physical = {
        ...physical,
        generation: physical.generation + 1,
        desktop_generation: "c".repeat(64),
        status: "running",
      };
      const changed = await status();
      expect(
        (
          await post({
            ...lost,
            operationId: randomUUID(),
            action: "stop",
            targetGeneration: changed.target.generation,
          })
        ).json().state,
      ).toBe("ready");
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base}/desktop-operations/${lost.operationId}/observe`,
          })
        ).json().state,
      ).toBe("unknown");
      expect(
        commands.filter(
          (c) =>
            c.type === "cantrip-os.desktop.operation" &&
            c.mode === "execute" &&
            c.operationId === lost.operationId,
        ),
      ).toHaveLength(1);
      expect(
        (await repository.attachment(owner, instance.id))!.instance.status,
      ).toBe("connected");
    } finally {
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
