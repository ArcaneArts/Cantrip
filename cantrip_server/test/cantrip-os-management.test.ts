import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it } from "vitest";
import {
  cantripOsSourceReceiptSchema,
  cantripOsRecoveryResultSchema,
  workerCommandSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";

it(
  "admits an owned encrypted source once, recovers a lost receipt, and explicitly verifies new generations",
  { timeout: 60_000 },
  async () => {
    const database = new PGlite();
    const app = Fastify();
    try {
      const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
      for (const name of (await readdir(migrations)).sort()) {
        if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
        const sql = await readFile(`${migrations}/${name}`, "utf8");
        if (Number(name.slice(0, 4)) >= 243) {
          for (const part of sql.split("--> statement-breakpoint"))
            if (part.trim()) await database.query(part);
        } else await database.exec(sql);
      }
      await database.exec(`INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other');
      INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','darwin','arm64',now(),now());
      INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability)
      VALUES('project','owner','{}','managed-folder','external','direct',true,false),('second','owner','{}','managed-folder','managed','direct',true,false);`);
      const repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      let owner = "owner",
        runtime = randomUUID(),
        attached = false,
        mutations = 0,
        inspections = 0,
        loseResponse = true,
        offline = false;
      const guest = randomUUID();
      let reportedGuest = guest;
      const records = new Map<string, unknown>();
      const commands: WorkerCommand[] = [];
      const observed = () => ({
        guestInstanceId: reportedGuest,
        runtimeGeneration: runtime,
        attachment: attached ? { ownerId: "owner", workerId: "worker" } : null,
        workspaces: [
          {
            guestWorkspaceId: "alpha",
            uid: 20000,
            gid: 20000,
            homeGuestPath: "/home/alpha",
          },
          {
            guestWorkspaceId: "beta",
            uid: 20001,
            gid: 20001,
            homeGuestPath: "/home/beta",
          },
        ],
      });
      const receipt = (
        scope: Extract<
          WorkerCommand,
          { type: "cantrip-os.source.inspect" }
        >["scope"],
      ) =>
        cantripOsSourceReceiptSchema.parse({
          bindingId: scope.bindingId,
          workspaceId: scope.workspaceId,
          guestWorkspaceId: scope.guestWorkspaceId,
          mode: scope.mode,
          guestPath: scope.guestPath,
          runtimeGeneration: runtime,
          uid: scope.uid,
          homeGuestPath: scope.homeGuestPath,
          head: "a".repeat(40),
          branch: "ctrr:protected-branch",
          detached: false,
          repositoryFingerprint: "fingerprint",
          gitCommonGuestPath: `${scope.guestPath}/.git`,
          recreated: false,
          interruptedGuestWorkspaces: [],
          dependencyOverlays: [],
          cleanupWarnings: [],
        });
      installCantripOsRoutes(app, {
        applicationOwnerId: () => owner,
        serverId: "server",
        repository: {
          cantripOs: repository,
          getWorker: async (ownerId: string, workerId: string) =>
            ownerId === "owner" && workerId === "worker"
              ? { id: workerId }
              : null,
        } as unknown as Pick<ServerRepository, "cantripOs" | "getWorker">,
        bridge: {
          request: async (_worker, command) => {
            workerCommandSchema.parse(command);
            commands.push(command);
            switch (command.type) {
              case "cantrip-os.inspect":
                if (offline) throw new Error("Executor unavailable");
                return observed();
              case "cantrip-os.attach":
                attached = true;
                return observed();
              case "cantrip-os.source.provision": {
                mutations++;
                const at = new Date().toISOString();
                const result = {
                  operationId: command.operationId,
                  state: "ready",
                  error: null,
                  startedAt: at,
                  updatedAt: at,
                  receipt: { kind: "source", source: receipt(command.scope) },
                };
                records.set(command.operationId, result);
                if (loseResponse) {
                  loseResponse = false;
                  throw new Error("Disconnected after actual dispatch");
                }
                return result;
              }
              case "cantrip-os.operation.inspect":
                inspections++;
                return records.get(command.operationId);
              case "cantrip-os.source.inspect":
                return receipt(command.scope);
              default:
                throw new Error("Unexpected command");
            }
          },
        },
      });
      const post = (url: string, payload: unknown = {}) =>
        app.inject({ method: "POST", url, payload });
      owner = "other";
      expect(
        (
          await post("/api/cantrip-os/inspect", {
            workerId: "worker",
            transport: { kind: "docker", container: "test" },
          })
        ).statusCode,
      ).toBe(409);
      expect(commands).toHaveLength(0);
      owner = "owner";
      const response = await post("/api/cantrip-os/attach", {
        workerId: "worker",
        guestInstanceId: guest,
        name: "Test",
        transport: { kind: "docker", container: "test" },
        expectedAttachmentGeneration: null,
      });
      expect(response.statusCode, response.body).toBe(200);
      const { instance, workspaces } = response.json();
      expect(workspaces.map((w: { uid: number }) => w.uid)).toEqual([
        20000, 20001,
      ]);
      const recoveryPath = `/api/cantrip-os/${instance.id}/recovery`;
      let expectedRecovery = {
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: instance.runtimeGeneration,
      };
      const recoverInstance = async (kind: string) => {
        const response = await post(recoveryPath, expectedRecovery);
        expect(response.statusCode, response.body).toBe(200);
        const result = cantripOsRecoveryResultSchema.parse(response.json());
        expect(result.recovery.kind).toBe(kind);
        expect(result.recovery.previousRuntimeGeneration).toBe(
          expectedRecovery.runtimeGeneration,
        );
        expectedRecovery = {
          attachmentGeneration: result.instance.attachmentGeneration,
          runtimeGeneration: result.instance.runtimeGeneration,
        };
        return result;
      };
      const beforeRecovery = commands.length;
      owner = "other";
      expect((await post(recoveryPath, expectedRecovery)).statusCode).toBe(409);
      owner = "owner";
      expect(
        (
          await post(recoveryPath, {
            ...expectedRecovery,
            attachmentGeneration: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post(recoveryPath, {
            ...expectedRecovery,
            runtimeGeneration: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      expect((await post(recoveryPath, {})).statusCode).toBe(400);
      expect(commands).toHaveLength(beforeRecovery);
      await recoverInstance("same-runtime");
      offline = true;
      const missing = await recoverInstance("unavailable");
      expect(missing.instance.runtimeGeneration).toBe(runtime);
      expect(missing.instance.status).toBe("unknown");
      expect(missing.recovery.observedRuntimeGeneration).toBeNull();
      offline = false;
      await recoverInstance("same-runtime");
      reportedGuest = randomUUID();
      const changed = await recoverInstance("identity-changed");
      expect(changed.instance.guestInstanceId).toBe(guest);
      expect(changed.instance.runtimeGeneration).toBe(runtime);
      expect(changed.instance.status).toBe("unknown");
      reportedGuest = guest;
      await recoverInstance("same-runtime");
      await repository.observe(
        "owner",
        instance.id,
        instance.attachmentGeneration,
        { status: "unknown", runtimeGeneration: null, lastError: null },
        runtime,
      );
      expectedRecovery.runtimeGeneration = null;
      await recoverInstance("first-observation");
      expect(
        commands
          .slice(beforeRecovery)
          .every((c) => c.type === "cantrip-os.inspect"),
      ).toBe(true);
      const root = "/api/projects/project/cantrip-os/bindings";
      expect(
        (
          await post(root, {
            mode: "linux-owned",
            workspaceId: workspaces[0].id,
            sourceKind: "git",
            uid: 0,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await post(root, {
            mode: "linux-owned",
            workspaceId: workspaces[0].id,
            sourceKind: "folder",
          })
        ).statusCode,
      ).toBe(409);
      const bindingResponse = await post(root, {
        mode: "linux-owned",
        workspaceId: workspaces[0].id,
        sourceKind: "git",
      });
      expect(bindingResponse.statusCode, bindingResponse.body).toBe(200);
      const binding = bindingResponse.json();
      const second = (
        await post(root, {
          mode: "linux-owned",
          workspaceId: workspaces[1].id,
          sourceKind: "git",
        })
      ).json();
      expect(second.projectSourceId).not.toBe(binding.projectSourceId);
      expect(second.guestPath).toMatch(/^\/home\/beta\//);
      const body = {
        operationId: randomUUID(),
        bindingGeneration: binding.bindingGeneration,
        protectedRequest: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      };
      const path = `${root}/${binding.id}`;
      expect((await post(`${path}/provision`, body)).statusCode).toBe(409);
      expect(
        (await repository.bindingContext("owner", binding.id))?.binding.state,
      ).toBe("unknown");
      const recovered = await post(`${path}/provision`, body);
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(mutations).toBe(1);
      expect(inspections).toBe(1);
      expect(
        (await repository.bindingContext("owner", binding.id))?.available,
      ).toBe(true);
      expect(
        (
          await database.query(
            "SELECT head,branch FROM project_worktrees WHERE id=$1",
            [binding.worktreeId],
          )
        ).rows,
      ).toEqual([{ head: "a".repeat(40), branch: "ctrr:protected-branch" }]);
      const worktreeAdmission = {
        mode: "linux-worktree",
        sourceBindingId: binding.id,
        expectedRuntimeGeneration: runtime,
        operationId: randomUUID(),
      };
      const [createdWorktree, repeatedWorktree] = await Promise.all([
        post(root, worktreeAdmission),
        post(root, worktreeAdmission),
      ]);
      expect(createdWorktree.statusCode, createdWorktree.body).toBe(200);
      expect(repeatedWorktree.statusCode, repeatedWorktree.body).toBe(200);
      const worktree = createdWorktree.json();
      expect(repeatedWorktree.json()).toEqual(worktree);
      expect(worktree.projectSourceId).toBe(binding.projectSourceId);
      expect(worktree.worktreeId).not.toBe(binding.worktreeId);
      expect(
        (await post(root, { ...worktreeAdmission, sourceBindingId: second.id }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await post(root, {
            ...worktreeAdmission,
            guestPath: "/client-supplied",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await post(`${path}/provision`, {
            ...body,
            operationId: randomUUID(),
          })
        ).statusCode,
      ).toBe(409);
      await expect(
        database.query(
          "UPDATE cantrip_os_provision_admissions SET scope='{}' WHERE binding_id=$1",
          [binding.id],
        ),
      ).rejects.toThrow(/immutable/);
      owner = "other";
      expect(
        (await post(root, { ...worktreeAdmission, operationId: randomUUID() }))
          .statusCode,
      ).toBe(409);
      expect((await post(`${path}/recover`)).statusCode).toBe(409);
      owner = "owner";
      expect(
        (
          await post(
            `/api/projects/second/cantrip-os/bindings/${binding.id}/verify`,
          )
        ).statusCode,
      ).toBe(409);
      runtime = randomUUID();
      const restarted = await recoverInstance("runtime-changed");
      expect(restarted.recovery.observedRuntimeGeneration).toBe(runtime);
      expect(
        (await repository.bindingContext("owner", binding.id))?.available,
      ).toBe(false);
      expect(
        (await post(root, { ...worktreeAdmission, operationId: randomUUID() }))
          .statusCode,
      ).toBe(409);
      expect((await post(root, worktreeAdmission)).json()).toEqual(worktree);
      expect((await post(`${path}/recover`)).statusCode).toBe(200);
      expect(
        (await repository.bindingContext("owner", binding.id))?.binding.state,
      ).toBe("unknown");
      expect((await post(`${path}/verify`)).statusCode).toBe(200);
      expect(
        (await repository.bindingContext("owner", binding.id))?.available,
      ).toBe(true);
      expect(mutations).toBe(1);
      const admission = await repository.provisionAdmission(
        "owner",
        binding.id,
      );
      expect(admission?.scope.runtimeGeneration).not.toBe(runtime);
      await expect(
        repository.observe(
          "owner",
          instance.id,
          instance.attachmentGeneration,
          {
            status: "connected",
            runtimeGeneration: admission!.scope.runtimeGeneration,
            lastError: null,
          },
          admission!.scope.runtimeGeneration,
        ),
      ).rejects.toThrow(/changed/);
      offline = true;
      expect(
        (await post(`/api/cantrip-os/${instance.id}/refresh`)).statusCode,
      ).toBe(409);
      expect(
        (await repository.bindingContext("owner", binding.id))?.available,
      ).toBe(false);
      expect((await post(`${path}/recover`)).statusCode).toBe(200);
      expect(
        (await repository.attachment("owner", instance.id))?.instance
          .runtimeGeneration,
      ).toBe(runtime);
      expect(mutations).toBe(1);
      offline = false;
      await post(`/api/cantrip-os/${instance.id}/refresh`);
      expect((await post(`${path}/verify`)).statusCode).toBe(200);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
