import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import {
  workerCommandSchema,
  type WorkerCommand,
  type CantripOsSystemOperationCommand,
} from "@cantrip/protocol";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import { CantripOsSystemCoordinator } from "../src/cantrip-os/systems.js";
import { WorkerCommandNotSentError } from "../src/workers/bridge.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import * as schema from "../src/db/schema.js";

it(
  "persists original system admissions, fences root changes, enrolls by exact transition and recovers without replay",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cantrip-systems-http-"));
    let database = new PGlite(directory),
      db = drizzle(database, { schema }) as RepositoryDatabase;
    let repository = new CantripOsRepository(db),
      app = Fastify(),
      owner = "owner";
    const recoveryErrors: unknown[] = [],
      recover = CantripOsSystemCoordinator.prototype.recover;
    const recoverySpy = vi
      .spyOn(CantripOsSystemCoordinator.prototype, "recover")
      .mockImplementation(async function (
        this: CantripOsSystemCoordinator,
        ...args
      ) {
        try {
          return await recover.apply(this, args);
        } catch (error) {
          recoveryErrors.push(error);
          throw error;
        }
      });
    const commands: WorkerCommand[] = [],
      executions: WorkerCommand[] = [],
      jobs = new Map<string, any>(),
      originalGuest = randomUUID();
    let guest = originalGuest,
      runtime = randomUUID(),
      attached = true,
      loseCapture = true,
      loseAttach = true,
      unknownReplace = false;
    let nextStatus: (() => Promise<void>) | null = null,
      notSent = false,
      dropPrepare = false,
      losePrepare = false;
    const envelope = {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(16).toString("base64url"),
    };
    const baseImage = `sha256:${"c".repeat(64)}`;
    let actual = {
      generation: randomUUID(),
      expected: {
        guestInstanceId: guest,
        ownerId: "owner",
        workerId: "worker",
        identityPath: "/private/identity/instance.json",
      },
      containerId: "a".repeat(64),
      containerName: "system-fixture",
      imageId: `sha256:${"b".repeat(64)}`,
      architecture: "amd64",
      identityEvidence: "guest-identity",
    };
    const statusValue = () => ({
      supported: true,
      target: attached ? structuredClone(actual) : null,
      bases: [
        {
          imageId: baseImage,
          architecture: "amd64",
          tags: ["cantrip-os:fixture"],
        },
      ],
      running: true,
      enrollment: attached
        ? null
        : { containerId: actual.containerId, guestInstanceId: guest },
      error: attached ? null : "Unattached",
    });
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
            if (
              dropPrepare &&
              command.type === "cantrip-os.system.capture" &&
              command.mode === "prepare"
            ) {
              dropPrepare = false;
              throw new Error("Uncertain delivery before admission reply");
            }
            if (
              notSent &&
              command.type === "cantrip-os.system.capture" &&
              command.mode === "prepare"
            ) {
              notSent = false;
              throw new WorkerCommandNotSentError("Worker is offline");
            }
            commands.push(structuredClone(command));
            if (command.type === "cantrip-os.inspect")
              return {
                guestInstanceId: guest,
                runtimeGeneration: runtime,
                attachment: attached
                  ? { ownerId: "owner", workerId: "worker" }
                  : null,
                workspaces: [],
              };
            if (command.type === "cantrip-os.attach") {
              expect(command.transport).toEqual({
                kind: "docker",
                container: actual.containerId,
              });
              expect(command.scope.guestInstanceId).toBe(guest);
              attached = true;
              if (loseAttach) {
                loseAttach = false;
                throw new Error("Lost enrollment reply /private/diagnostic");
              }
              return {
                guestInstanceId: guest,
                runtimeGeneration: runtime,
                attachment: { ownerId: "owner", workerId: "worker" },
                workspaces: [],
              };
            }
            if (command.type === "cantrip-os.system.status") {
              const value = statusValue(),
                wait = nextStatus;
              nextStatus = null;
              await wait?.();
              if (!command.recovery && guest !== command.scope.guestInstanceId)
                throw new Error("Guest identity changed");
              return value;
            }
            if (!command.type.startsWith("cantrip-os.system."))
              throw new Error("Unexpected command");
            const c = command as CantripOsSystemOperationCommand;
            expect(c.scope).not.toHaveProperty("runtimeGeneration");
            if (c.mode === "prepare" && !jobs.has(c.operationId)) {
              const at = new Date().toISOString();
              jobs.set(c.operationId, {
                operationId: c.operationId,
                targetGeneration: c.target.generation,
                action: c.action,
                state: "running",
                phase: "prepared",
                startedAt: at,
                updatedAt: at,
                root: null,
                protectedResult: envelope,
                error: null,
              });
            }
            if (c.mode === "prepare" && losePrepare) {
              losePrepare = false;
              throw new Error("Lost prepared admission reply");
            }
            const first =
              c.mode === "execute" ||
              (c.mode === "continue" &&
                jobs.get(c.operationId)?.phase === "prepared");
            if (first) {
              executions.push(structuredClone(c));
              const at = new Date().toISOString();
              const result: any = {
                operationId: c.operationId,
                targetGeneration: c.target.generation,
                action: c.action,
                state: "running",
                phase: "running",
                startedAt: at,
                updatedAt: at,
                root: null,
                protectedResult: null,
                error: null,
              };
              if (c.action === "replace") {
                if (c.source.kind === "base") {
                  guest = randomUUID();
                  attached = false;
                } else {
                  guest = c.source.capture.context.guestInstanceId;
                  attached = true;
                }
                actual = {
                  ...actual,
                  containerId: (c.source.kind === "base" ? "d" : "e").repeat(
                    64,
                  ),
                  expected: { ...actual.expected, guestInstanceId: guest },
                };
                Object.assign(result, {
                  state: unknownReplace ? "unknown" : "ready",
                  phase: unknownReplace ? "create-requested" : "complete",
                  protectedResult: unknownReplace ? null : envelope,
                  root: {
                    requestSha256: "f".repeat(64),
                    originalContainerId: c.target.containerId,
                    targetContainerId: actual.containerId,
                    retainedContainerId: c.target.containerId,
                    runtimeHandlesRestored: false,
                    guestInstanceId: guest,
                    guestAttachment: attached ? "owned" : "unattached",
                  },
                });
              } else if (c.action === "rollback") {
                actual = structuredClone(c.target);
                guest = actual.expected.guestInstanceId;
                attached = true;
                Object.assign(result, {
                  state: "ready",
                  phase: "complete",
                  protectedResult: envelope,
                  root: {
                    requestSha256: "f".repeat(64),
                    originalContainerId: c.target.containerId,
                    targetContainerId: actual.containerId,
                    retainedContainerId: "e".repeat(64),
                    runtimeHandlesRestored: false,
                    guestInstanceId: guest,
                    guestAttachment: "owned",
                  },
                });
              }
              jobs.set(c.operationId, result);
              if (c.action === "capture" && loseCapture) {
                loseCapture = false;
                throw new Error("Lost capture reply /private/diagnostic");
              }
            }
            const result = jobs.get(c.operationId);
            if (
              result &&
              !first &&
              c.mode === "continue" &&
              c.action === "capture"
            )
              Object.assign(result, {
                state: "ready",
                phase: "complete",
                protectedResult: envelope,
              });
            return result ? structuredClone(result) : null;
          },
        },
      });
    const post = async (url: string, payload: unknown, expected = 200) => {
      const response = await app.inject({
        method: "POST",
        url,
        payload: payload as never,
      });
      if (response.statusCode !== expected)
        for (const error of recoveryErrors) console.error(error);
      expect(response.statusCode, response.body).toBe(expected);
      return response.json();
    };
    const get = async (url: string, expected = 200) => {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, response.body).toBe(expected);
      return response.json();
    };
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
        name: "System",
        transport: { kind: "docker", container: actual.containerId },
        expectedAttachmentGeneration: null,
      });
      for (const column of ["owner_id", "worker_id", "guest_instance_id"])
        await expect(
          database.query(
            `UPDATE cantrip_os_instances SET ${column}=$1 WHERE id=$2`,
            [randomUUID(), instance.id],
          ),
        ).rejects.toThrow("OS instance identity is immutable");
      await repository.observe(
        owner,
        instance.id,
        instance.attachmentGeneration,
        { status: "connected", runtimeGeneration: runtime, lastError: null },
      );
      install();
      const root = `/api/cantrip-os/${instance.id}`;
      const first = await get(`${root}/system`);
      expect(JSON.stringify(first)).not.toContain("/private");
      const captureRequest = {
        operationId: randomUUID(),
        attachmentGeneration: instance.attachmentGeneration,
        targetGeneration: first.target.generation,
        action: "capture",
        resumeOriginal: true,
      };
      const pending = await post(`${root}/system-operations`, captureRequest);
      expect(pending.state).toBe("unknown");
      expect(pending.error).not.toContain("/private");
      expect(pending.attachmentGeneration).not.toBe(
        instance.attachmentGeneration,
      );
      expect(pending.context.attachmentGeneration).toBe(
        instance.attachmentGeneration,
      );
      let current = (await repository.attachment(owner, instance.id))!;
      expect(current.transport).toEqual({
        kind: "docker",
        container: actual.containerName,
      });
      await repository.observe(
        owner,
        instance.id,
        current.instance.attachmentGeneration,
        { status: "connected", runtimeGeneration: runtime, lastError: null },
      );
      current = (await repository.attachment(owner, instance.id))!;
      expect(current.instance.status).toBe("unknown");
      expect(current.instance.runtimeGeneration).toBeNull();
      await expect(
        repository.attach(owner, {
          workerId: "worker",
          guestInstanceId: guest,
          name: "Retarget",
          transport: { kind: "docker", container: "another" },
          expectedAttachmentGeneration: pending.attachmentGeneration,
        }),
      ).rejects.toThrow("system operation");
      await post(
        `${root}/power-operations`,
        {
          operationId: randomUUID(),
          attachmentGeneration: pending.attachmentGeneration,
          targetGeneration: randomUUID(),
          action: "restart",
        },
        409,
      );
      const before = commands.length;
      await post(`${root}/system-operations`, captureRequest);
      expect(
        commands
          .slice(before)
          .every((c) => !("mode" in c) || c.mode === "observe"),
      ).toBe(true);
      expect(
        executions.filter(
          (c) =>
            c.type === "cantrip-os.system.capture" &&
            c.operationId === pending.operationId,
        ),
      ).toHaveLength(1);
      // Reconstruct both HTTP services and SQL repository from retained storage.
      await app.close();
      await database.close();
      database = new PGlite(directory);
      db = drizzle(database, { schema }) as RepositoryDatabase;
      repository = new CantripOsRepository(db);
      app = Fastify();
      install();
      await post(
        `${root}/system-operations/${pending.operationId}/continue`,
        {
          attachmentGeneration: instance.attachmentGeneration,
          targetGeneration: pending.targetGeneration,
        },
        409,
      );
      const captured = await post(
        `${root}/system-operations/${pending.operationId}/continue`,
        {
          attachmentGeneration: pending.attachmentGeneration,
          targetGeneration: pending.targetGeneration,
        },
      );
      expect(captured.state).toBe("ready");
      expect(await post(`${root}/system-operations`, captureRequest)).toEqual(
        captured,
      );
      const status = await get(`${root}/system`);
      const base = await post(`${root}/system-operations`, {
        operationId: randomUUID(),
        attachmentGeneration: status.target.attachmentGeneration,
        targetGeneration: status.target.generation,
        action: "replace",
        startTarget: true,
        source: { kind: "base", imageId: baseImage },
      });
      expect(base.state).toBe("ready");
      const recovery = {
        attachmentGeneration: base.attachmentGeneration,
        targetGeneration: base.targetGeneration,
      };
      await post(
        `${root}/system-operations/${base.operationId}/recover`,
        recovery,
        409,
      );
      expect(
        (await repository.attachment(owner, instance.id))!.instance
          .guestInstanceId,
      ).toBe(originalGuest);
      const enrolled = await post(
        `${root}/system-operations/${base.operationId}/recover`,
        recovery,
      );
      expect(enrolled.id).toBe(instance.id);
      expect(enrolled.guestInstanceId).toBe(guest);
      expect(enrolled.runtimeGeneration).toBeNull();
      expect(enrolled.attachmentGeneration).not.toBe(base.attachmentGeneration);
      expect(
        commands.filter((c) => c.type === "cantrip-os.attach"),
      ).toHaveLength(1);
      const requests = commands.length;
      expect(
        await post(
          `${root}/system-operations/${base.operationId}/recover`,
          recovery,
        ),
      ).toEqual(enrolled);
      expect(commands).toHaveLength(requests);
      const now = await get(`${root}/system`);
      unknownReplace = true;
      const replacement = await post(`${root}/system-operations`, {
        operationId: randomUUID(),
        attachmentGeneration: now.target.attachmentGeneration,
        targetGeneration: now.target.generation,
        action: "replace",
        startTarget: true,
        source: { kind: "checkpoint", operationId: captured.operationId },
      });
      expect(replacement.state).toBe("unknown");
      const dispatched = commands.findLast(
        (c) => c.type === "cantrip-os.system.replace",
      )! as Extract<CantripOsSystemOperationCommand, { action: "replace" }>;
      expect(dispatched.source.kind).toBe("checkpoint");
      if (dispatched.source.kind === "checkpoint")
        expect(dispatched.source.capture.context.attachmentGeneration).toBe(
          instance.attachmentGeneration,
        );
      const rollback = await post(`${root}/system-operations`, {
        operationId: randomUUID(),
        action: "rollback",
        attachmentGeneration: replacement.attachmentGeneration,
        targetGeneration: replacement.targetGeneration,
        replacementOperationId: replacement.operationId,
        startTarget: true,
      });
      expect(rollback.state).toBe("ready");
      expect(
        (await get(`${root}/system-operations/${replacement.operationId}`))
          .retiredBy,
      ).toBe(rollback.operationId);
      await post(
        `${root}/system-operations/${replacement.operationId}/continue`,
        {
          attachmentGeneration: replacement.attachmentGeneration,
          targetGeneration: replacement.targetGeneration,
        },
        409,
      );
      const restored = await post(
        `${root}/system-operations/${rollback.operationId}/recover`,
        {
          attachmentGeneration: rollback.attachmentGeneration,
          targetGeneration: rollback.targetGeneration,
        },
      );
      runtime = randomUUID();
      await repository.observe(
        owner,
        instance.id,
        restored.attachmentGeneration,
        { status: "connected", runtimeGeneration: runtime, lastError: null },
      );
      Object.assign(jobs.get(replacement.operationId), {
        state: "ready",
        phase: "complete",
        protectedResult: envelope,
      });
      await post(
        `${root}/system-operations/${replacement.operationId}/observe`,
        {},
      );
      expect(
        (await repository.attachment(owner, instance.id))!.instance
          .runtimeGeneration,
      ).toBe(runtime);
      const page = await get(`${root}/system-operations?limit=1`);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy();
      const second = await get(
        `${root}/system-operations?limit=1&cursor=${page.nextCursor}`,
      );
      expect(second.items[0].operationId).not.toBe(page.items[0].operationId);
      expect(
        JSON.stringify(await get(`${root}/system-operations`)),
      ).not.toContain("/private");
      let release!: () => void, started!: () => void;
      const startedPromise = new Promise<void>((r) => {
          started = r;
        }),
        held = new Promise<void>((r) => {
          release = r;
        });
      nextStatus = async () => {
        started();
        await held;
      };
      const observing = get(`${root}/system`);
      await startedPromise;
      const authority = (await repository.attachment(owner, instance.id))!;
      await repository.attach(owner, {
        workerId: "worker",
        guestInstanceId: guest,
        name: "Reattached",
        transport: authority.transport,
        expectedAttachmentGeneration: authority.instance.attachmentGeneration,
      });
      release();
      expect((await observing).target).toBeNull();
      const available = await get(`${root}/system`);
      const refusedRequest = {
        operationId: randomUUID(),
        action: "capture",
        attachmentGeneration: available.target.attachmentGeneration,
        targetGeneration: available.target.generation,
        resumeOriginal: true,
      };
      notSent = true;
      const commandCount = commands.length;
      const rejected = await post(`${root}/system-operations`, refusedRequest);
      expect(rejected.state).toBe("rejected");
      expect(rejected.phase).toBe("not-dispatched");
      expect(rejected.protectedResult).toBeNull();
      expect(commands).toHaveLength(commandCount);
      expect(await post(`${root}/system-operations`, refusedRequest)).toEqual(
        rejected,
      );
      const afterRefusal = await get(`${root}/system`);
      const retried = await post(`${root}/system-operations`, {
        ...refusedRequest,
        operationId: randomUUID(),
        attachmentGeneration: afterRefusal.target.attachmentGeneration,
        targetGeneration: afterRefusal.target.generation,
      });
      expect(retried.state).toBe("running");
      await post(`${root}/system-operations/${retried.operationId}/continue`, {
        attachmentGeneration: retried.attachmentGeneration,
        targetGeneration: retried.targetGeneration,
      });
      let currentStatus = await get(`${root}/system`);
      dropPrepare = true;
      const undelivered = await post(`${root}/system-operations`, {
        ...refusedRequest,
        operationId: randomUUID(),
        attachmentGeneration: currentStatus.target.attachmentGeneration,
        targetGeneration: currentStatus.target.generation,
      });
      expect(undelivered).toMatchObject({
        state: "unknown",
        dispatchStage: "preparing",
      });
      expect(jobs.has(undelivered.operationId)).toBe(false);
      const admitted = await post(
        `${root}/system-operations/${undelivered.operationId}/continue`,
        {
          attachmentGeneration: undelivered.attachmentGeneration,
          targetGeneration: undelivered.targetGeneration,
        },
      );
      expect(admitted.dispatchStage).toBe("executing");
      await post(`${root}/system-operations/${admitted.operationId}/continue`, {
        attachmentGeneration: admitted.attachmentGeneration,
        targetGeneration: admitted.targetGeneration,
      });
      expect(
        executions.filter(
          (c) => "operationId" in c && c.operationId === admitted.operationId,
        ),
      ).toHaveLength(1);
      currentStatus = await get(`${root}/system`);
      losePrepare = true;
      const cancellable = await post(`${root}/system-operations`, {
        ...refusedRequest,
        operationId: randomUUID(),
        attachmentGeneration: currentStatus.target.attachmentGeneration,
        targetGeneration: currentStatus.target.generation,
      });
      const prepared = await post(
        `${root}/system-operations/${cancellable.operationId}/observe`,
        {},
      );
      expect(prepared).toMatchObject({
        dispatchStage: "preparing",
        phase: "prepared",
      });
      const closed = await post(
        `${root}/system-operations/${cancellable.operationId}/abandon`,
        {
          attachmentGeneration: prepared.attachmentGeneration,
          targetGeneration: prepared.targetGeneration,
        },
      );
      expect(closed).toMatchObject({
        state: "rejected",
        phase: "not-dispatched",
      });
      expect(
        executions.some(
          (c) => "operationId" in c && c.operationId === prepared.operationId,
        ),
      ).toBe(false);
      owner = "other";
      await get(`${root}/system-operations/${captured.operationId}`, 409);
      await get(`${root}/system-operations`, 409);
    } finally {
      recoverySpy.mockRestore();
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
