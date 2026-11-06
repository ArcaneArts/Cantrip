import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import { installCantripOsRoutes } from "../src/app/routes/cantrip-os.js";
import { existingLinuxSourcePath } from "../src/db/repository/cantrip-os-existing-path.js";

it("uses Linux path semantics while preserving spaces/Unicode and rejecting another workspace", () => {
  expect(
    existingLinuxSourcePath("/home/linux", "./restored//日本語 repo "),
  ).toBe("/home/linux/restored/日本語 repo ");
  expect(existingLinuxSourcePath("/home/linux", ".")).toBe("/home/linux");
  for (const path of [
    "",
    "/host/repo",
    "../other",
    "a/../other",
    "a/../../other",
    "repo\0secret",
  ])
    expect(() => existingLinuxSourcePath("/home/linux", path)).toThrow();
});

it(
  "durably reserves an existing path with fresh identities, survives database restart and rejects changed creation intent",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cantrip-existing-sources-"),
    );
    let database = new PGlite(directory);
    let repository = new CantripOsRepository(
      drizzle(database, { schema }) as RepositoryDatabase,
    );
    let app = Fastify();
    let owner = "owner";
    let workerCalls = 0;
    const install = () =>
      installCantripOsRoutes(app, {
        applicationOwnerId: () => owner,
        serverId: "server",
        repository: { cantripOs: repository, getWorker: async () => null },
        bridge: {
          request: async () => {
            workerCalls++;
            throw new Error("Creation must not claim guest verification.");
          },
        },
      });
    const url = "/api/projects/project/cantrip-os/bindings";
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url, payload: payload as object });
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
      await database.exec(`INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other');
      INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','darwin','arm64',now(),now());
      INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability)
      VALUES('project','owner','{}','managed-folder','external','direct',true,false);`);
      const instance = await repository.attach("owner", {
        workerId: "worker",
        guestInstanceId: randomUUID(),
        transport: { kind: "docker", container: "not-contacted" },
        name: "Existing source",
        expectedAttachmentGeneration: null,
      });
      const workspace = await repository.recordWorkspace(
        "owner",
        instance.id,
        instance.attachmentGeneration,
        {
          guestWorkspaceId: "restored",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/home/restored",
        },
      );
      install();
      const oldSourceId = randomUUID();
      const request = {
        mode: "linux-existing",
        operationId: randomUUID(),
        workspaceId: workspace.id,
        sourceKind: "git",
        relativePath: `checkouts/${oldSourceId}`,
      };
      const created = await post(request);
      expect(created.statusCode, created.body).toBe(200);
      const binding = created.json();
      expect(binding).toMatchObject({
        mode: "linux-owned",
        state: "provisioning",
        guestPath: `/home/restored/checkouts/${oldSourceId}`,
      });
      expect(binding.projectSourceId).not.toBe(oldSourceId);
      expect(
        new Set([binding.id, binding.projectSourceId, binding.worktreeId]).size,
      ).toBe(3);
      expect(workerCalls).toBe(0);
      const location = await repository.bindingContext("owner", binding.id);
      expect(location?.primaryGuestPath).toBe(binding.guestPath);
      expect(location?.available).toBe(false);
      await app.close();
      await database.close();
      database = new PGlite(directory);
      repository = new CantripOsRepository(
        drizzle(database, { schema }) as RepositoryDatabase,
      );
      app = Fastify();
      install();
      expect((await post(request)).json()).toEqual(binding);
      for (const changed of [
        { ...request, relativePath: "different" },
        { ...request, sourceKind: "folder" },
      ]) {
        const response = await post(changed);
        expect(response.statusCode, response.body).toBe(409);
      }
      for (const relativePath of ["../other", "/host/project", "repo\0path"]) {
        const response = await post({
          ...request,
          operationId: randomUUID(),
          relativePath,
        });
        expect(response.statusCode, response.body).toBe(409);
      }
      owner = "other";
      expect((await post(request)).statusCode).toBe(409);
      owner = "owner";
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM cantrip_os_existing_source_admissions",
          )
        ).rows[0]?.count,
      ).toBe(1);
      const stored = (
        await database.query<{
          ownership_kind: string;
          absolute_path: string | null;
        }>(
          "SELECT s.ownership_kind,t.absolute_path FROM cantrip_os_project_sources s JOIN project_worktrees t ON t.project_source_id=s.id",
        )
      ).rows[0];
      expect(stored).toEqual({ ownership_kind: "user", absolute_path: null });
      expect(workerCalls).toBe(0);
      // A creation receipt must not prevent the existing project/binding
      // cascade. Removing Server metadata performs no guest filesystem work.
      await database.exec("DELETE FROM projects WHERE id='project'");
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM cantrip_os_existing_source_admissions",
          )
        ).rows[0]?.count,
      ).toBe(0);
      expect(workerCalls).toBe(0);
    } finally {
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
