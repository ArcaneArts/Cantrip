import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { encryptCantripOsBackupMessage } from "../../packages/crypto/src/cantrip-os-backup-message.js";
import {
  cantripOsBackupRequestEnvelopeSchema,
  workerCommandSchema,
  type WorkerCommand,
  type CantripOsBackupOperationResult,
} from "@cantrip/protocol";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import * as schema from "../src/db/schema.js";

it(
  "persists private HTTP admissions across database restart, preserves capture scope and never replays lost mutations",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-backup-server-"),
    );
    let database = new PGlite(directory),
      app = Fastify();
    const key = randomBytes(32),
      serverId = "backup-server";
    let owner = "owner",
      online = true,
      loseReply = true;
    const sent: WorkerCommand[] = [],
      results = new Map<string, CantripOsBackupOperationResult>();
    let repository = new CantripOsRepository(
      drizzle(database, { schema }) as RepositoryDatabase,
    );
    const frame = async (
      id: string,
      direction: "request" | "response",
      value: unknown,
    ) =>
      encryptCantripOsBackupMessage({
        ownerId: "owner",
        serverId,
        operationId: id,
        keyRevision: 1,
        componentKey: key,
        direction,
        plaintext: new TextEncoder().encode(JSON.stringify(value)),
      });
    const install = () =>
      installCantripOsRoutes(app, {
        applicationOwnerId: () => owner,
        serverId,
        repository: { cantripOs: repository, getWorker: async () => null },
        bridge: {
          isConnected: () => online,
          request: async (_worker, command) => {
            workerCommandSchema.parse(command);
            sent.push(command);
            if (!online) throw new Error("Fixture transport lost");
            if (command.type === "cantrip-os.backup.observe")
              return results.get(command.operationId);
            if (
              command.type !== "cantrip-os.backup.capture" &&
              command.type !== "cantrip-os.backup.restore" &&
              command.type !== "cantrip-os.backup.rollback"
            )
              throw new Error("Unexpected mutation");
            const action = command.type.slice("cantrip-os.backup.".length) as
              "capture" | "restore" | "rollback";
            const at = new Date().toISOString();
            const result = {
              operationId: command.operationId,
              action,
              state: "ready",
              phase: "complete",
              startedAt: at,
              updatedAt: at,
              error: null,
              protectedResult: await frame(command.operationId, "response", {
                action,
                fixture: true,
              }),
            } as CantripOsBackupOperationResult;
            results.set(command.operationId, result);
            if (loseReply) {
              loseReply = false;
              throw new Error(
                "Lost acknowledgement after completed Worker operation",
              );
            }
            return result;
          },
        },
      });
    const post = (url: string, payload: unknown) =>
      app.inject({ method: "POST", url, payload });
    try {
      const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
      for (const name of (await readdir(migrations)).sort())
        if (/^\d{4}_.+\.sql$/.test(name)) {
          const sql = await readFile(path.join(migrations, name), "utf8");
          if (Number(name.slice(0, 4)) >= 243) {
            for (const part of sql.split("--> statement-breakpoint"))
              if (part.trim()) await database.query(part);
          } else await database.exec(sql);
        }
      await database.exec(
        "INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','linux','x64',now(),now());",
      );
      const instance = await repository.attach("owner", {
        workerId: "worker",
        guestInstanceId: randomUUID(),
        name: "Source",
        transport: { kind: "docker", container: "private-container" },
        expectedAttachmentGeneration: null,
      });
      const runtime = randomUUID();
      await repository.observe(
        "owner",
        instance.id,
        instance.attachmentGeneration,
        { status: "unknown", runtimeGeneration: runtime, lastError: null },
      );
      const source = await repository.recordWorkspace(
        "owner",
        instance.id,
        instance.attachmentGeneration,
        {
          guestWorkspaceId: "source",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/private/source-home",
        },
      );
      await database.exec(
        "INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES('project','owner','{}','managed-folder','managed','direct',true,false)",
      );
      const binding = await repository.createLinuxSource("owner", {
        projectId: "project",
        workspaceId: source.id,
        sourceKind: "git",
      });
      await database.query(
        "UPDATE cantrip_os_project_sources SET git_common_guest_path='/private/canonical-git' WHERE id=$1",
        [binding.source.id],
      );
      const targetInstance = await repository.attach("owner", {
        workerId: "worker",
        guestInstanceId: randomUUID(),
        name: "Target",
        transport: { kind: "docker", container: "target-container" },
        expectedAttachmentGeneration: null,
      });
      const targetRuntime = randomUUID();
      await repository.observe(
        "owner",
        targetInstance.id,
        targetInstance.attachmentGeneration,
        {
          status: "connected",
          runtimeGeneration: targetRuntime,
          lastError: null,
        },
      );
      const destination = await repository.recordWorkspace(
        "owner",
        targetInstance.id,
        targetInstance.attachmentGeneration,
        {
          guestWorkspaceId: "destination",
          uid: 20001,
          gid: 20001,
          homeGuestPath: "/private/destination-home",
        },
      );
      install();
      const captureId = randomUUID();
      const capture = {
        action: "capture",
        operationId: captureId,
        workspaceId: source.id,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: runtime,
        protectedRequest: cantripOsBackupRequestEnvelopeSchema.parse(
          await frame(captureId, "request", {
            action: "capture",
            workspaceId: source.id,
            label: "Private backup name",
            exclusions: [],
          }),
        ),
      };
      const url = `/api/cantrip-os/${instance.id}/backup-operations`;
      owner = "other";
      expect((await post(url, capture)).statusCode).toBe(409);
      expect(sent).toHaveLength(0);
      owner = "owner";
      expect((await post(url, { ...capture, uid: 0 })).statusCode).toBe(400);
      expect(
        (await post(url, { ...capture, runtimeGeneration: randomUUID() }))
          .statusCode,
      ).toBe(409);
      expect(sent).toHaveLength(0);
      const lost = await post(url, capture);
      expect(lost.statusCode).toBe(200);
      expect(lost.json().result.state).toBe("unknown");
      expect(JSON.stringify(lost.json())).not.toContain("/private/source-home");
      expect(JSON.stringify(lost.json())).not.toContain("Private backup name");
      expect(sent.at(-1)).toMatchObject({
        sources: [
          {
            bindingId: binding.binding.id,
            guestPath: binding.binding.guestPath,
            gitCommonGuestPath: "/private/canonical-git",
          },
        ],
      });
      const changedRuntime = randomUUID();
      await repository.observe(
        "owner",
        instance.id,
        instance.attachmentGeneration,
        {
          status: "connected",
          runtimeGeneration: changedRuntime,
          lastError: null,
        },
      );
      await app.close();
      await database.close();
      database = new PGlite(directory);
      repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      app = Fastify();
      install();
      const recovered = await post(url, capture);
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().result.state).toBe("ready");
      expect(
        sent.filter((c) => c.type === "cantrip-os.backup.capture"),
      ).toHaveLength(1);
      expect(sent.at(-1)).toMatchObject({
        type: "cantrip-os.backup.observe",
        scope: { runtimeGeneration: runtime },
      });
      expect(
        (await post(url, { ...capture, workspaceId: destination.id }))
          .statusCode,
      ).toBe(409);
      const recoveryUrl = `/api/cantrip-os/backup-operations/${captureId}/recovery`;
      expect(
        (
          await post(recoveryUrl, {
            mode: "continue",
            attachmentGeneration: instance.attachmentGeneration,
            runtimeGeneration: runtime,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post(recoveryUrl, {
            mode: "continue",
            attachmentGeneration: instance.attachmentGeneration,
            runtimeGeneration: changedRuntime,
          })
        ).statusCode,
      ).toBe(200);
      expect(sent.at(-1)).toMatchObject({
        scope: { runtimeGeneration: runtime },
        continuationScope: { runtimeGeneration: changedRuntime },
      });
      expect(
        (await repository.backups.get("owner", captureId))!.command.scope
          .runtimeGeneration,
      ).toBe(runtime);
      expect(
        (await repository.backups.get("owner", captureId))!.continuationScope
          ?.runtimeGeneration,
      ).toBe(changedRuntime);
      const restoreId = randomUUID();
      const restore = {
        action: "restore",
        operationId: restoreId,
        workspaceId: destination.id,
        attachmentGeneration: targetInstance.attachmentGeneration,
        runtimeGeneration: targetRuntime,
        backupId: captureId,
        replace: false,
        protectedRequest: cantripOsBackupRequestEnvelopeSchema.parse(
          await frame(restoreId, "request", {
            action: "restore",
            workspaceId: destination.id,
            backupId: captureId,
            replace: false,
          }),
        ),
      };
      const restored = await post(
        `/api/cantrip-os/${targetInstance.id}/backup-operations`,
        restore,
      );
      expect(restored.statusCode).toBe(200);
      expect(restored.json().result.state).toBe("ready");
      expect(sent.at(-1)).toMatchObject({
        type: "cantrip-os.backup.restore",
        backupScope: { runtimeGeneration: runtime, instanceId: instance.id },
        scope: {
          runtimeGeneration: targetRuntime,
          instanceId: targetInstance.id,
        },
        workspace: {
          uid: 20001,
          gid: 20001,
          homeGuestPath: "/private/destination-home",
        },
      });
      const rollbackId = randomUUID();
      const rollback = {
        action: "rollback",
        operationId: rollbackId,
        workspaceId: source.id,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: changedRuntime,
        restoreOperationId: restoreId,
        protectedRequest: cantripOsBackupRequestEnvelopeSchema.parse(
          await frame(rollbackId, "request", {
            action: "rollback",
            workspaceId: source.id,
            restoreOperationId: restoreId,
          }),
        ),
      };
      const before = sent.length;
      expect((await post(url, rollback)).statusCode).toBe(409);
      expect(sent).toHaveLength(before);
      const secondId = randomUUID();
      const second = {
        ...capture,
        operationId: secondId,
        runtimeGeneration: changedRuntime,
        protectedRequest: cantripOsBackupRequestEnvelopeSchema.parse(
          await frame(secondId, "request", {
            action: "capture",
            workspaceId: source.id,
            label: "Second",
            exclusions: [],
          }),
        ),
      };
      expect((await post(url, second)).json().result.state).toBe("ready");
      const page = (await app.inject("/api/cantrip-os/backups?limit=1")).json();
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const next = (
        await app.inject(
          `/api/cantrip-os/backups?limit=1&cursor=${page.nextCursor}`,
        )
      ).json();
      expect(next.items).toHaveLength(1);
      expect(next.items[0].operationId).not.toBe(page.items[0].operationId);
      expect(next.nextCursor).toBeNull();
      const thirdId = randomUUID();
      loseReply = true;
      const third = {
        ...capture,
        operationId: thirdId,
        runtimeGeneration: changedRuntime,
        protectedRequest: cantripOsBackupRequestEnvelopeSchema.parse(
          await frame(thirdId, "request", {
            action: "capture",
            workspaceId: source.id,
            label: "Late completion",
            exclusions: [],
          }),
        ),
      };
      expect((await post(url, third)).json().result.state).toBe("unknown");
      const early = await repository.backups.beginObservation("owner", thirdId);
      const late = await repository.backups.beginObservation("owner", thirdId);
      const lateUnknown = {
        ...results.get(thirdId)!,
        state: "unknown",
        phase: "recovery-required",
        protectedResult: null,
        error: "Lost carrier",
      } as CantripOsBackupOperationResult;
      await repository.backups.record("owner", late, lateUnknown);
      expect(
        (await repository.backups.record("owner", early, results.get(thirdId)!))
          .result?.state,
      ).toBe("ready");
      expect(
        (await repository.backups.record("owner", late, lateUnknown)).result
          ?.state,
      ).toBe("ready");
      const firstRevision = await repository.backups.beginObservation(
        "owner",
        secondId,
      );
      const secondRevision = await repository.backups.beginObservation(
        "owner",
        secondId,
      );
      const unknown = {
        ...results.get(secondId)!,
        state: "unknown",
        phase: "recovery-required",
        protectedResult: null,
        error: "Transport lost",
      } as CantripOsBackupOperationResult;
      // A delayed unavailable observation cannot downgrade completed evidence.
      expect(
        (await repository.backups.record("owner", secondRevision, unknown))
          .result?.state,
      ).toBe("ready");
      expect(
        (
          await repository.backups.record(
            "owner",
            firstRevision,
            results.get(secondId)!,
          )
        ).result?.state,
      ).toBe("ready");
      online = false;
      const offline = await post(
        `/api/cantrip-os/backup-operations/${captureId}/recovery`,
        { mode: "observe" },
      );
      expect(offline.json()).toMatchObject({
        workerConnected: false,
        archiveAvailability: "worker-offline",
        result: { state: "ready" },
      });
      owner = "other";
      const count = sent.length;
      expect(
        (await app.inject(`/api/cantrip-os/backup-operations/${captureId}`))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await post(
            `/api/cantrip-os/backup-operations/${captureId}/recovery`,
            { mode: "observe" },
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (await app.inject("/api/cantrip-os/backups")).json().items,
      ).toEqual([]);
      expect(sent).toHaveLength(count);
    } finally {
      await app.close();
      await database.close();
      key.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
