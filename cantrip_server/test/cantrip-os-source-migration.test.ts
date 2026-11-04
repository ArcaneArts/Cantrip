import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import * as schema from "../src/db/schema.js";

const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
async function apply(database: PGlite, first: number, last: number) {
  for (const name of (await readdir(migrations)).sort()) {
    if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
    const index = Number(name.slice(0, 4));
    if (index >= first && index <= last) {
      const contents = await readFile(`${migrations}/${name}`, "utf8");
      if (index === 243) {
        // Drizzle uses prepared statements for each breakpoint, not exec's
        // permissive multi-statement protocol.
        for (const statement of contents.split("--> statement-breakpoint"))
          if (statement.trim()) await database.query(statement);
      } else await database.exec(contents);
    }
  }
}
const local = (source = "local", worktree = "local-primary") => `
  INSERT INTO project_sources(id, project_id, worker_id, absolute_path, display_path)
    VALUES ('${source}', 'project', 'worker', '/host/${source}', '${source}');
  INSERT INTO project_worktrees(id, project_source_id, worker_id, name, absolute_path,
    display_path, is_primary, is_default, origin, lifecycle_state)
    VALUES ('${worktree}', '${source}', 'worker', 'Primary', '/host/${source}', '${source}', true, true, 'cantrip', 'ready');
`;
async function fixture() {
  const database = new PGlite();
  await apply(database, 0, 242);
  await database.exec(`
    INSERT INTO users(id, kind, display_name) VALUES ('owner', 'anonymous', 'Owner'), ('other', 'anonymous', 'Other');
    INSERT INTO workers(id, owner_id, name, platform, architecture, started_at, last_seen_at) VALUES
      ('worker', 'owner', 'Worker', 'darwin', 'arm64', now(), now()),
      ('worker2', 'owner', 'Second worker', 'linux', 'x64', now(), now()),
      ('foreign-worker', 'other', 'Other worker', 'linux', 'x64', now(), now());
    INSERT INTO projects(id, owner_id, protected_label, origin_kind, folder_management, worktree_policy, git_capability, github_capability)
      VALUES ('project', 'owner', '{}', 'managed-folder', 'external', 'direct', true, false);
    ${local()}
  `);
  await apply(database, 243, 243);
  return database;
}
const profiles = `
  INSERT INTO cantrip_os_instances(id, owner_id, worker_id, guest_instance_id, attachment_generation, transport, name)
    VALUES ('os', 'owner', 'worker', 'guest', 'attachment-1', '{"kind":"docker","container":"fixture"}', 'Fixture'),
      ('os2', 'owner', 'worker2', 'guest2', 'attachment-2', '{"kind":"ssh"}', 'Second worker OS');
  INSERT INTO cantrip_os_workspaces(id, instance_id, guest_workspace_id, uid, gid, home_guest_path)
    VALUES ('profile', 'os', 'a', 20000, 20000, '/home/a'),
      ('profile2', 'os', 'b', 20001, 20001, '/home/b'),
      ('profile3', 'os2', 'c', 20000, 20000, '/home/c');
`;
const linux = `
  INSERT INTO project_source_identities(id, project_id, worker_id, location_kind)
    VALUES ('linux', 'project', 'worker', 'cantrip-os');
  INSERT INTO cantrip_os_project_sources(id, workspace_id, source_kind, guest_path, ownership_kind)
    VALUES ('linux', 'profile', 'git', '/home/a/checkouts/linux', 'cantrip');
  INSERT INTO project_worktrees(id, project_source_id, worker_id, location_kind, guest_path, name,
    display_path, is_primary, is_default, origin, lifecycle_state)
    VALUES ('linux-primary', 'linux', 'worker', 'cantrip-os', '/home/a/checkouts/linux', 'Primary', 'linux', true, true, 'cantrip', 'creating');
`;
const binding = (
  id: string,
  source: string,
  worktree: string,
  profile: string,
  mode: string,
  path: string,
) => `
  INSERT INTO cantrip_os_source_bindings(id, owner_id, project_id, worker_id, project_source_id,
    worktree_id, workspace_id, mode, linked_worker_path, guest_path, binding_generation, state)
    VALUES ('${id}', 'owner', 'project', 'worker', '${source}', '${worktree}', '${profile}', '${mode}', ${mode === "linked" ? "'/host/local'" : "NULL"}, '${path}', '${id}-1', 'provisioning');
`;

describe("CantripOS source identity migration", { timeout: 60_000 }, () => {
  it("backfills old IDs and preserves old source writers, path repair and delete cascades", async () => {
    const db = await fixture();
    try {
      expect(
        (await db.query("SELECT * FROM project_source_identities")).rows,
      ).toEqual([
        {
          id: "local",
          project_id: "project",
          worker_id: "worker",
          location_kind: "worker-local",
        },
      ]);
      await db.exec(
        "UPDATE project_sources SET absolute_path = '/repaired' WHERE id = 'local'",
      );
      await expect(
        db.exec(
          "UPDATE project_sources SET worker_id = 'worker2' WHERE id = 'local'",
        ),
      ).rejects.toThrow(/identity/iu);
      await db.exec("DELETE FROM project_sources WHERE id = 'local'");
      expect((await db.query("SELECT * FROM project_worktrees")).rows).toEqual(
        [],
      );
      expect(
        (await db.query("SELECT * FROM project_source_identities")).rows,
      ).toEqual([]);
      await db.exec(local("new-local", "new-primary"));
      await db.exec(
        "DELETE FROM project_source_identities WHERE id = 'new-local'",
      );
      expect((await db.query("SELECT * FROM project_sources")).rows).toEqual(
        [],
      );
      expect((await db.query("SELECT * FROM project_worktrees")).rows).toEqual(
        [],
      );
      await db.exec(local("cascade", "cascade-primary"));
      await db.exec("DELETE FROM projects WHERE id = 'project'");
      expect(
        (await db.query("SELECT * FROM project_source_identities")).rows,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("separates physical Linux paths, rejects wrong workers and preserves legacy local queries", async () => {
    const db = await fixture();
    try {
      await db.exec(profiles + linux);
      expect(
        (
          await db.query(
            "SELECT absolute_path, guest_path, location_kind FROM project_worktrees WHERE id = 'linux-primary'",
          )
        ).rows,
      ).toEqual([
        {
          absolute_path: null,
          guest_path: "/home/a/checkouts/linux",
          location_kind: "cantrip-os",
        },
      ]);
      expect(
        (
          await db.query(
            "SELECT t.id FROM project_worktrees t JOIN project_sources s ON s.id = t.project_source_id",
          )
        ).rows,
      ).toEqual([{ id: "local-primary" }]);
      await expect(
        db.exec(
          "UPDATE project_worktrees SET absolute_path = guest_path WHERE id = 'linux-primary'",
        ),
      ).rejects.toThrow(/shape/iu);
      await expect(
        db.exec(
          "UPDATE project_worktrees SET guest_path = NULL WHERE id = 'linux-primary'",
        ),
      ).rejects.toThrow(/shape/iu);
      await expect(
        db.exec(
          "UPDATE project_worktrees SET worker_id = 'worker2' WHERE id = 'linux-primary'",
        ),
      ).rejects.toThrow(/mismatch/iu);
      await expect(
        db.exec(
          "UPDATE cantrip_os_project_sources SET workspace_id = 'profile2' WHERE id = 'linux'",
        ),
      ).rejects.toThrow(/immutable/iu);
      await expect(
        db.exec(
          "INSERT INTO project_source_identities VALUES ('foreign', 'project', 'foreign-worker', 'cantrip-os')",
        ),
      ).rejects.toThrow(/owner/iu);
      await db.exec(
        "DELETE FROM cantrip_os_project_sources WHERE id = 'linux'",
      );
      expect(
        (await db.query("SELECT id FROM project_worktrees ORDER BY id")).rows,
      ).toEqual([{ id: "local-primary" }]);
    } finally {
      await db.close();
    }
  });

  it("binds an exact source/worktree/profile and never reactivates an old generation", async () => {
    const db = await fixture();
    try {
      await db.exec(profiles + linux);
      await db.exec(
        binding(
          "linked-a",
          "local",
          "local-primary",
          "profile",
          "linked",
          "/workspace/linked-a",
        ),
      );
      await db.exec(
        binding(
          "linked-b",
          "local",
          "local-primary",
          "profile2",
          "linked",
          "/workspace/linked-b",
        ),
      );
      await expect(
        db.exec(`
        INSERT INTO cantrip_os_source_bindings(id, owner_id, project_id, worker_id, project_source_id,
          worktree_id, workspace_id, mode, linked_worker_path, guest_path, binding_generation, state, retired_at)
          VALUES ('forged-retired', 'other', 'project', 'worker', 'local', 'local-primary', 'profile',
            'linked', '/host/local', '/workspace/forged', 'forged-1', 'retired', now());
      `),
      ).rejects.toThrow(/mismatch/iu);
      await db.exec(
        binding(
          "linux-a",
          "linux",
          "linux-primary",
          "profile",
          "linux-owned",
          "/home/a/checkouts/linux",
        ),
      );
      await expect(
        db.exec(
          binding(
            "wrong-worker",
            "local",
            "local-primary",
            "profile3",
            "linked",
            "/workspace/wrong",
          ),
        ),
      ).rejects.toThrow(/mismatch/iu);
      await expect(
        db.exec(
          binding(
            "wrong-mode",
            "local",
            "local-primary",
            "profile",
            "linux-owned",
            "/workspace/wrong",
          ),
        ),
      ).rejects.toThrow(/mismatch/iu);
      await expect(
        db.exec(
          binding(
            "wrong-profile",
            "linux",
            "linux-primary",
            "profile2",
            "linux-owned",
            "/home/a/checkouts/linux",
          ),
        ),
      ).rejects.toThrow(/mismatch/iu);
      await expect(
        db.exec(
          "UPDATE cantrip_os_source_bindings SET guest_path = '/moved' WHERE id = 'linked-a'",
        ),
      ).rejects.toThrow(/immutable/iu);
      await expect(
        db.exec(
          "UPDATE cantrip_os_workspaces SET uid = 20002 WHERE id = 'profile'",
        ),
      ).rejects.toThrow(/immutable/iu);
      await db.exec(
        "UPDATE cantrip_os_instances SET status = 'connected', runtime_generation = 'runtime-1' WHERE id = 'os'; UPDATE cantrip_os_source_bindings SET state = 'ready', provisioned_attachment_generation = 'attachment-1', provisioned_runtime_generation = 'runtime-1' WHERE id = 'linked-a'",
      );
      await db.exec(
        "UPDATE cantrip_os_source_bindings SET state = 'retired', retired_at = now() WHERE id = 'linked-a'",
      );
      await expect(
        db.exec(
          "UPDATE cantrip_os_source_bindings SET state = 'ready', retired_at = NULL WHERE id = 'linked-a'",
        ),
      ).rejects.toThrow(/reactivated/iu);
      await db.exec(
        binding(
          "linked-new",
          "local",
          "local-primary",
          "profile",
          "linked",
          "/workspace/new",
        ),
      );
      await db.exec("DELETE FROM projects WHERE id = 'project'");
      expect(
        (await db.query("SELECT * FROM cantrip_os_source_bindings")).rows,
      ).toEqual([]);
      expect(
        (await db.query("SELECT * FROM cantrip_os_project_sources")).rows,
      ).toEqual([]);
      expect(
        (await db.query("SELECT id FROM cantrip_os_workspaces ORDER BY id"))
          .rows,
      ).toHaveLength(3);
      await db.exec("DELETE FROM users WHERE id = 'owner'");
      expect(
        (await db.query("SELECT * FROM cantrip_os_instances")).rows,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("allows owner deletion to cascade through live Linux source details", async () => {
    const db = await fixture();
    try {
      await db.exec(profiles + linux);
      await db.exec(
        binding(
          "linux-a",
          "linux",
          "linux-primary",
          "profile",
          "linux-owned",
          "/home/a/checkouts/linux",
        ),
      );
      await db.exec("DELETE FROM users WHERE id = 'owner'");
      for (const table of [
        "cantrip_os_instances",
        "cantrip_os_workspaces",
        "project_source_identities",
        "cantrip_os_project_sources",
        "cantrip_os_source_bindings",
        "project_worktrees",
      ])
        expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("admits canonical source identities and rejects stale attachment/workspace observations", async () => {
    const db = await fixture();
    const repository = new CantripOsRepository(
      drizzle(db, { schema }) as unknown as RepositoryDatabase,
    );
    try {
      const os = await repository.attach("owner", {
        workerId: "worker",
        guestInstanceId: "11111111-1111-4111-8111-111111111111",
        name: "Fixture",
        transport: { kind: "docker", container: "fixture" },
        expectedAttachmentGeneration: null,
      });
      expect(await repository.list("other")).toEqual([]);
      await expect(
        repository.attach("other", {
          workerId: "worker",
          guestInstanceId: os.guestInstanceId,
          name: "Wrong owner",
          transport: { kind: "docker", container: "fixture" },
          expectedAttachmentGeneration: os.attachmentGeneration,
        }),
      ).rejects.toThrow(/worker/iu);
      const profile = await repository.recordWorkspace(
        "owner",
        os.id,
        os.attachmentGeneration,
        {
          guestWorkspaceId: "fixture-a",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/home/fixture-a",
        },
      );
      expect(await repository.listWorkspaces("owner", os.id)).toEqual([
        profile,
      ]);
      await expect(
        repository.recordWorkspace("owner", os.id, os.attachmentGeneration, {
          guestWorkspaceId: "fixture-a",
          uid: 20001,
          gid: 20001,
          homeGuestPath: "/home/fixture-a",
        }),
      ).rejects.toThrow(/identity changed/iu);
      const link = await repository.createLinkedBinding("owner", {
        workspaceId: profile.id,
        worktreeId: "local-primary",
        dependencyOverlays: [{ path: "node_modules" }],
      });
      const provisioned = await repository.createLinuxSource("owner", {
        projectId: "project",
        workspaceId: profile.id,
        sourceKind: "git",
      });
      expect(provisioned.source.id).not.toBe("local");
      expect(provisioned.source.guestPath).toBe(
        `/home/fixture-a/checkouts/${provisioned.source.id}`,
      );
      expect(provisioned.source).not.toHaveProperty("path");
      expect(
        (await repository.bindingContext("owner", link.id))?.physicalLocation,
      ).toEqual({ kind: "worker-local", workerPath: "/host/local" });
      expect(
        (await repository.bindingContext("owner", provisioned.binding.id))
          ?.physicalLocation,
      ).toEqual({
        kind: "cantrip-os",
        instanceId: os.id,
        workspaceId: profile.id,
        guestPath: provisioned.source.guestPath,
      });
      expect(await repository.bindingContext("other", link.id)).toBeNull();
      expect(await repository.listBindings("owner", "project")).toHaveLength(2);
      const epochs = {
        bindingGeneration: provisioned.binding.bindingGeneration,
        attachmentGeneration: os.attachmentGeneration,
        runtimeGeneration: "first-runtime",
      };
      await expect(
        repository.executionContext("owner", provisioned.binding.id, epochs),
      ).rejects.toThrow(/unavailable/iu);
      await repository.observe("owner", os.id, os.attachmentGeneration, {
        status: "connected",
        runtimeGeneration: epochs.runtimeGeneration,
        lastError: null,
      });
      await repository.recordBindingOutcome(
        "owner",
        link.id,
        { ...epochs, bindingGeneration: link.bindingGeneration },
        { state: "ready", lastError: null },
      );
      await db.exec(
        "UPDATE project_worktrees SET absolute_path = '/host/moved' WHERE id = 'local-primary'",
      );
      const movedLink = await repository.bindingContext("owner", link.id);
      expect(movedLink?.physicalLocation).toEqual({
        kind: "worker-local",
        workerPath: "/host/local",
      });
      expect(movedLink?.available).toBe(false);
      await repository.recordBindingOutcome(
        "owner",
        provisioned.binding.id,
        epochs,
        { state: "ready", lastError: null },
      );
      expect(
        (
          await repository.executionContext(
            "owner",
            provisioned.binding.id,
            epochs,
          )
        ).available,
      ).toBe(true);
      await repository.observe("owner", os.id, os.attachmentGeneration, {
        status: "connected",
        runtimeGeneration: "after-reboot",
        lastError: null,
      });
      await expect(
        repository.executionContext("owner", provisioned.binding.id, epochs),
      ).rejects.toThrow(/changed/iu);
      await expect(
        repository.recordBindingOutcome(
          "owner",
          provisioned.binding.id,
          epochs,
          { state: "ready", lastError: null },
        ),
      ).rejects.toThrow(/changed/iu);
      expect(await repository.retireBinding("owner", link.id, "stale")).toBe(
        false,
      );
      expect(
        await repository.retireBinding(
          "owner",
          link.id,
          link.bindingGeneration,
        ),
      ).toBe(true);
      expect(await repository.bindingContext("owner", link.id)).toBeNull();
      const replacement = await repository.attach("owner", {
        workerId: "worker",
        guestInstanceId: os.guestInstanceId,
        name: "Fixture",
        transport: { kind: "docker", container: "replacement" },
        expectedAttachmentGeneration: os.attachmentGeneration,
      });
      expect(replacement.id).toBe(os.id);
      expect(replacement.attachmentGeneration).not.toBe(
        os.attachmentGeneration,
      );
      await expect(
        repository.observe("owner", os.id, os.attachmentGeneration, {
          status: "connected",
          runtimeGeneration: "old",
          lastError: null,
        }),
      ).rejects.toThrow(/changed/iu);
      expect(
        (
          await repository.observe(
            "owner",
            os.id,
            replacement.attachmentGeneration,
            { status: "connected", runtimeGeneration: "new", lastError: null },
          )
        ).runtimeGeneration,
      ).toBe("new");
      expect(await repository.listWorkspaces("owner", os.id)).toEqual([
        profile,
      ]);
      // Even with the same files and workspace IDs, the old receipt cannot
      // authorize execution on a new attachment/runtime.
      await expect(
        repository.executionContext("owner", provisioned.binding.id, {
          ...epochs,
          attachmentGeneration: replacement.attachmentGeneration,
          runtimeGeneration: "new",
        }),
      ).rejects.toThrow(/changed/iu);
      await db.exec(
        "UPDATE workers SET unlinked_at = now() WHERE id = 'worker'",
      );
      expect(
        await repository.bindingContext("owner", provisioned.binding.id),
      ).toBeNull();
    } finally {
      await db.close();
    }
  });
});
