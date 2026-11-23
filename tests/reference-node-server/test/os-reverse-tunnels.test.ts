import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { TunnelUserWireCreate } from "@cantrip/protocol";
import { CantripOsRepository } from "../src/db/repository/cantrip-os.js";
import { TunnelRepository } from "../src/db/repository/tunnels.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import * as schema from "../src/db/schema.js";
function record(revision = 1) {
  return {
    operationId: randomUUID(),
    revision,
    protectedContent: {
      formatVersion: 1 as const,
      domain: "tunnel-content" as const,
      keyRevision: 1,
      envelope: {
        version: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}
async function fixture() {
  const db = new PGlite();
  const migrations = fileURLToPath(
    new URL("../../../cantrip_server/drizzle", import.meta.url),
  );
  for (const name of (await readdir(migrations)).sort())
    if (/^\d{4}_.+\.sql$/u.test(name))
      for (const statement of (
        await readFile(`${migrations}/${name}`, "utf8")
      ).split("--> statement-breakpoint"))
        if (statement.trim()) await db.query(statement);
  await db.exec(`INSERT INTO users(id,kind,display_name) VALUES ('owner','anonymous','Owner'),('other','anonymous','Other');
    INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('worker','owner','Worker','darwin','arm64',now(),now());
    INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES ('project','owner','{}','managed-folder','external','direct',true,false);`);
  const database = drizzle(db, { schema }) as unknown as RepositoryDatabase;
  const os = new CantripOsRepository(database);
  const instance = await os.attach("owner", {
    workerId: "worker",
    guestInstanceId: randomUUID(),
    name: "Fixture",
    transport: { kind: "docker", container: "fixture" },
    expectedAttachmentGeneration: null,
  });
  const workspace = await os.recordWorkspace(
    "owner",
    instance.id,
    instance.attachmentGeneration,
    {
      guestWorkspaceId: "fixture-a",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/home/fixture-a",
    },
  );
  const provisioned = await os.createLinuxSource("owner", {
    projectId: "project",
    workspaceId: workspace.id,
    sourceKind: "git",
  });
  const epochs = {
    bindingGeneration: provisioned.binding.bindingGeneration,
    attachmentGeneration: instance.attachmentGeneration,
    runtimeGeneration: randomUUID(),
  };
  await os.observe("owner", instance.id, instance.attachmentGeneration, {
    status: "connected",
    runtimeGeneration: epochs.runtimeGeneration,
    lastError: null,
  });
  await os.recordBindingOutcome("owner", provisioned.binding.id, epochs, {
    state: "ready",
    lastError: null,
  });
  const repo: TunnelRepository = new TunnelRepository(database, {
    getTunnel: (...args) => repo.getTunnel(...args),
    stopDesktopTunnelAttachment: (...args) =>
      repo.stopDesktopTunnelAttachment(...args),
  });
  const input: TunnelUserWireCreate = {
    id: randomUUID(),
    projectId: "project",
    protocolHint: "tcp",
    source: { kind: "worker-listener", workerId: "worker" },
    destination: { kind: "worker-tcp", workerId: "worker" },
    osSource: {
      ...epochs,
      bindingId: provisioned.binding.id,
      worktreeId: provisioned.binding.worktreeId,
    },
    protectedRecord: record(),
  };
  const attach = (overrides = {}) =>
    repo.createDesktopTunnelAttachment("owner", input.id, {
      kind: "worker-listener",
      expectedRevision: 1,
      clientId: randomUUID(),
      expiresAt: new Date(Date.now() + 120000),
      secretExpiresAt: new Date(Date.now() + 120000),
      secretHash: "a".repeat(64),
      ...overrides,
    });
  return { db, repo, input, attach };
}
describe("saved Guest-to-Host authority", { timeout: 60000 }, () => {
  it("requires explicit listener admission, pins the captured source, and keeps legacy secrets out of reverse routes", async () => {
    const { db, repo, input, attach } = await fixture();
    try {
      const saved = await repo.createUserTunnel("owner", input);
      expect(saved?.source).toEqual(input.source);
      await expect(attach({ kind: undefined })).rejects.toThrow(
        "saved tunnel changed",
      );
      await expect(attach({ expectedRevision: 2 })).rejects.toThrow(
        "saved tunnel changed",
      );
      const attached = (await attach())!;
      const auth = (await repo.getDesktopTunnelAttachment(
        "owner",
        attached.attachmentId,
      ))!;
      expect(auth.source).toEqual(input.source);
      expect(
        await repo.getDesktopTunnelAttachment("other", attached.attachmentId),
      ).toBeNull();
      expect(
        await repo.authorizeDesktopTunnelAttachment(
          attached.attachmentId,
          "a".repeat(64),
        ),
      ).toBeNull();
      expect((await repo.resolveOsExecution(auth))?.scope.bindingId).toBe(
        input.osSource!.bindingId,
      );
      expect(await repo.pinOsServiceIdentity(auth, "b".repeat(64))).toBe(true);
      expect(await repo.pinOsServiceIdentity(auth, "c".repeat(64))).toBe(false);
      await expect(
        repo.updateUserTunnel("owner", input.id, {
          protectedRecord: record(2),
        }),
      ).rejects.toThrow("Stop every");
      await expect(repo.deleteUserTunnel("owner", input.id)).rejects.toThrow(
        "Stop every",
      );
      await repo.stopDesktopTunnelAttachment("owner", attached.attachmentId);
      await repo.updateUserTunnel("owner", input.id, {
        projectId: null,
        source: { kind: "desktop-loopback" },
        protectedRecord: record(2),
      });
      expect(
        (await repo.getTunnel("owner", input.id))?.osSource,
      ).toBeUndefined();
      const ordinary = await repo.createDesktopTunnelAttachment(
        "owner",
        input.id,
        {
          clientId: randomUUID(),
          expiresAt: new Date(Date.now() + 120000),
          secretExpiresAt: new Date(Date.now() + 120000),
          secretHash: "d".repeat(64),
        },
      );
      expect(ordinary).not.toBeNull();
    } finally {
      await db.close();
    }
  });
  it("rejects stale ownership and SQL rows that would confuse an OS source with Host loopback", async () => {
    const { db, repo, input } = await fixture();
    try {
      await expect(repo.createUserTunnel("other", input)).rejects.toThrow();
      await expect(
        repo.createUserTunnel("owner", {
          ...input,
          osSource: { ...input.osSource!, runtimeGeneration: randomUUID() },
        }),
      ).rejects.toThrow();
      await repo.createUserTunnel("owner", input);
      await expect(
        db.query(
          "UPDATE tunnels SET source_kind='desktop-loopback',source_worker_id=NULL WHERE id=$1",
          [input.id],
        ),
      ).rejects.toThrow(/tunnels_os_source_check/);
      await expect(
        db.query(
          "UPDATE tunnels SET source_worker_id='other-worker' WHERE id=$1",
          [input.id],
        ),
      ).rejects.toThrow();
      const edits = await Promise.allSettled([
        repo.updateUserTunnel("owner", input.id, {
          protectedRecord: record(2),
        }),
        repo.updateUserTunnel("owner", input.id, {
          protectedRecord: record(2),
        }),
      ]);
      expect(
        edits.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        edits.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
