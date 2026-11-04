import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  cantripOsProvisionRequestContentSchema,
  workerCommandSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { CantripOsController } from "../../cantrip_worker/src/os-executor/controller.js";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../../cantrip_worker/src/os-executor/connection.js";
import { guestFileUri } from "../../cantrip_worker/src/os-executor/paths.js";
import { runGuestProcess } from "../../cantrip_worker/src/os-executor/process.js";
import { prepareOsSourceCommand } from "../../cantrip_worker/src/os-executor/protected-source.js";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.js";
import { protectWorkerRepositoryOperationContent } from "../../cantrip_worker/src/repository-operation-encryption.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
describe.skipIf(!enabled)(
  "actual Server-to-worker CantripOS source dispatch",
  () => {
    it("provisions an exact Git revision through protected admission and observes lost delivery without replay", async () => {
      const transport: OsExecutorTransport = process.env
        .CANTRIP_OS_TEST_TRANSPORT
        ? JSON.parse(
            await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
          )
        : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
      const ownerId = "00000000-0000-4000-8000-000000000001",
        workerId = "00000000-0000-4000-8000-000000000002",
        serverId = "cantrip-os-server-acceptance";
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-os-server-dispatch-"),
      );
      const key = new Uint8Array(32).fill(63);
      const encryption = {
        ownerId: () => ownerId,
        componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
      } as unknown as WorkerEncryptionService;
      const controller = new CantripOsController(directory, workerId),
        routing = new WorkerRoutingRegistry(directory);
      const database = new PGlite(),
        app = Fastify();
      let guestWorkspaceId: string | undefined;
      let connection: OsExecutorConnection | undefined;
      try {
        const migrations = fileURLToPath(
          new URL("../drizzle", import.meta.url),
        );
        for (const name of (await readdir(migrations)).sort()) {
          if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
          const sql = await readFile(`${migrations}/${name}`, "utf8");
          if (Number(name.slice(0, 4)) >= 243) {
            for (const part of sql.split("--> statement-breakpoint"))
              if (part.trim()) await database.query(part);
          } else await database.exec(sql);
        }
        await database.query(
          "INSERT INTO users(id,kind,display_name) VALUES($1,'anonymous','Owner')",
          [ownerId],
        );
        await database.query(
          "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','darwin','arm64',now(),now())",
          [workerId, ownerId],
        );
        const projectId = randomUUID();
        await database.query(
          "INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES($1,$2,'{}','managed-folder','external','direct',true,false)",
          [projectId, ownerId],
        );
        const repository = new CantripOsRepository(
          drizzle(database, { schema }) as RepositoryDatabase,
        );
        let provisions = 0,
          drop = true;
        const commands: WorkerCommand[] = [];
        installCantripOsRoutes(app, {
          applicationOwnerId: () => ownerId,
          serverId,
          repository: {
            cantripOs: repository,
            getWorker: async (owner: string, worker: string) =>
              owner === ownerId && worker === workerId
                ? { id: workerId }
                : null,
          } as unknown as Pick<ServerRepository, "cantripOs" | "getWorker">,
          bridge: {
            request: async (_worker, wire) => {
              const command = await routing.resolveCommand(
                workerCommandSchema.parse(wire),
              );
              commands.push(command);
              const trusted =
                command.type === "cantrip-os.source.provision"
                  ? await prepareOsSourceCommand(command, encryption, routing)
                  : command;
              if (!trusted.type.startsWith("cantrip-os."))
                throw new Error("Unexpected test dispatch");
              const result = await controller
                .handle(trusted as Parameters<typeof controller.handle>[0])
                .catch((error) => {
                  console.error("Acceptance worker dispatch:", error);
                  throw error;
                });
              const protectedResult = await routing.protectResult(
                command.type,
                result,
              );
              if (command.type === "cantrip-os.source.provision") {
                provisions++;
                if (drop) {
                  drop = false;
                  throw new Error(
                    "Lost response after the real guest operation completed",
                  );
                }
              }
              return protectedResult;
            },
          },
        });
        const post = async (url: string, payload: unknown = {}) => {
          const response = await app.inject({ method: "POST", url, payload });
          expect(response.statusCode, response.body).toBe(200);
          return response.json();
        };
        const actual = await post("/api/cantrip-os/inspect", {
          workerId,
          transport,
        });
        const attached = await post("/api/cantrip-os/attach", {
          workerId,
          transport,
          name: "Acceptance",
          guestInstanceId: actual.guestInstanceId,
          expectedAttachmentGeneration: null,
        });
        guestWorkspaceId = `api-${randomUUID().slice(0, 12)}`;
        await post(`/api/cantrip-os/${attached.instance.id}/workspaces`, {
          guestWorkspaceId,
          operationId: randomUUID(),
        });
        const refreshed = await post(
          `/api/cantrip-os/${attached.instance.id}/refresh`,
        );
        const workspace = refreshed.workspaces.find(
          (w: { guestWorkspaceId: string }) =>
            w.guestWorkspaceId === guestWorkspaceId,
        );
        const root = `/api/projects/${projectId}/cantrip-os/bindings`;
        const binding = await post(root, {
          mode: "linux-owned",
          workspaceId: workspace.id,
          sourceKind: "git",
        });
        const nativeBinding = await executorControl<OsExecutorBinding>(
          transport,
          ["open", guestWorkspaceId],
        );
        connection = new OsExecutorConnection(transport, nativeBinding);
        await connection.request("initialize", {
          clientName: "cantrip-os-http-acceptance",
          resumeSessionId: null,
        });
        connection.notify("initialized");
        const fixture = path.join(directory, "repository");
        await mkdir(fixture);
        const execute = promisify(execFile);
        const git = (...args: string[]) =>
          execute("git", args, {
            cwd: fixture,
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
            },
          });
        await git("init", "--initial-branch=main");
        await git("config", "user.name", "CantripOS acceptance");
        await git("config", "user.email", "acceptance@cantrip.invalid");
        const filename = "README # % ? 日本語.txt",
          bytes = "Protected Server admission, actual Linux clone.\n";
        await writeFile(path.join(fixture, filename), bytes);
        await git("add", ".");
        await git("commit", "-m", "Fixture");
        const revision = (await git("rev-parse", "HEAD")).stdout.trim();
        await git("bundle", "create", "fixture.bundle", "--all");
        const guestBundle = `${nativeBinding.home}/fixture.bundle`;
        await connection.request("fs/writeFile", {
          path: guestFileUri(guestBundle),
          dataBase64: (
            await readFile(path.join(fixture, "fixture.bundle"))
          ).toString("base64"),
          sandbox: null,
        });
        await connection.close();
        connection = undefined;
        const operationId = randomUUID();
        const protectedRequest = await protectWorkerRepositoryOperationContent({
          service: encryption,
          context: {
            serverId,
            projectId,
            worktreeId: binding.worktreeId,
            operationId,
            direction: "request",
          },
          schema: cantripOsProvisionRequestContentSchema,
          content: {
            type: "cantrip-os.source.provision",
            instanceId: attached.instance.id,
            workspaceId: workspace.id,
            bindingId: binding.id,
            bindingGeneration: binding.bindingGeneration,
            intent: {
              mode: "linux-owned",
              source: { kind: "git", repositoryUrl: guestBundle, revision },
            },
          },
        });
        const body = {
          operationId,
          bindingGeneration: binding.bindingGeneration,
          protectedRequest,
        };
        const first = await app.inject({
          method: "POST",
          url: `${root}/${binding.id}/provision`,
          payload: body,
        });
        expect(first.statusCode).toBe(409);
        const recovered = await post(`${root}/${binding.id}/recover`);
        expect(recovered.state).toBe("ready");
        await post(`${root}/${binding.id}/provision`, body);
        expect(provisions).toBe(1);
        expect(
          (await repository.bindingContext(ownerId, binding.id))?.available,
        ).toBe(true);
        expect(JSON.stringify(commands)).not.toContain(guestBundle);
        const reopened = await executorControl<OsExecutorBinding>(transport, [
          "open",
          guestWorkspaceId,
        ]);
        connection = new OsExecutorConnection(transport, reopened);
        await connection.request("initialize", {
          clientName: "cantrip-os-http-verification",
          resumeSessionId: null,
        });
        connection.notify("initialized");
        const file = await connection.request<{ dataBase64: string }>(
          "fs/readFile",
          {
            path: guestFileUri(`${binding.guestPath}/${filename}`),
            sandbox: null,
          },
        );
        expect(Buffer.from(file.dataBase64, "base64").toString()).toBe(bytes);
        const guestProcess = await runGuestProcess(
          connection,
          [
            "python3",
            "-c",
            "import os,json,pathlib;pathlib.Path('artifact.txt').write_text('actual Linux artifact'+chr(10));print(json.dumps({'uid':os.getuid(),'cwd':os.getcwd()}))",
          ],
          binding.guestPath,
        );
        expect(guestProcess.exitCode).toBe(0);
        expect(JSON.parse(guestProcess.stdout)).toEqual({
          uid: workspace.uid,
          cwd: binding.guestPath,
        });
        const artifact = await connection.request<{ dataBase64: string }>(
          "fs/readFile",
          {
            path: guestFileUri(`${binding.guestPath}/artifact.txt`),
            sandbox: null,
          },
        );
        expect(Buffer.from(artifact.dataBase64, "base64").toString()).toBe(
          "actual Linux artifact\n",
        );
        const proof = {
          transport: transport.kind,
          instance: attached.instance,
          workspace,
          binding,
          recovered,
          provisions,
          guestProcess,
          admission: await repository.provisionAdmission(ownerId, binding.id),
        };
        const artifacts = new URL(
          "../../cantrip_os/artifacts/phase3-dispatch/",
          import.meta.url,
        );
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          new URL(`server-${transport.kind}-${binding.id}.json`, artifacts),
          JSON.stringify(proof, null, 2),
        );
      } finally {
        await connection?.close();
        if (guestWorkspaceId)
          await executorControl(transport, ["close", guestWorkspaceId]);
        await app.close();
        await database.close();
        key.fill(0);
      }
    }, 180_000);
  },
);
