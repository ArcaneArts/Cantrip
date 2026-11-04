import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import {
  encryptedChatCreateSchema,
  cantripOsSourceReceiptSchema,
} from "@cantrip/protocol";
import { ServerRepository } from "../src/db/repository.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import type { SecretVault } from "../src/security/secret-vault.js";
import * as schema from "../src/db/schema.js";
import {
  protectedChatFields,
  protectedExplorerFields,
} from "./private-label-fixture.js";

it("captures an OS binding before native preparation and preserves lane identity without a host fallback", async () => {
  const db = new PGlite();
  try {
    const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
    for (const name of (await readdir(directory)).sort()) {
      if (!/^\d{4}_.+\.sql$/u.test(name)) continue;
      const sql = await readFile(`${directory}/${name}`, "utf8");
      if (Number(name.slice(0, 4)) >= 243) {
        for (const part of sql.split("--> statement-breakpoint"))
          if (part.trim()) await db.query(part);
      } else await db.exec(sql);
    }
    await db.exec(`INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other');
  INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','darwin','arm64',now(),now());
  INSERT INTO user_settings(user_id,computer_use_enabled) VALUES('owner',true);
  INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES('project','owner','{}','managed-folder','external','direct',false,false);`);
    const repository = new ServerRepository(
      drizzle(db, { schema }) as RepositoryDatabase,
      {} as SecretVault,
    );
    const os = repository.cantripOs;
    const attached = await os.attach("owner", {
      workerId: "worker",
      guestInstanceId: randomUUID(),
      name: "Fixture",
      transport: { kind: "docker", container: "fixture" },
      expectedAttachmentGeneration: null,
    });
    const generation = randomUUID();
    await os.observe("owner", attached.id, attached.attachmentGeneration, {
      status: "connected",
      runtimeGeneration: generation,
      lastError: null,
    });
    const workspace = await os.recordWorkspace(
      "owner",
      attached.id,
      attached.attachmentGeneration,
      {
        guestWorkspaceId: "alpha",
        uid: 20000,
        gid: 20000,
        homeGuestPath: "/home/alpha",
      },
    );
    const { binding } = await os.createLinuxSource("owner", {
      projectId: "project",
      workspaceId: workspace.id,
      sourceKind: "folder",
    });
    await os.recordBindingOutcome(
      "owner",
      binding.id,
      {
        bindingGeneration: binding.bindingGeneration,
        attachmentGeneration: attached.attachmentGeneration,
        runtimeGeneration: generation,
      },
      {
        state: "ready",
        lastError: null,
        sourceReceipt: cantripOsSourceReceiptSchema.parse({
          bindingId: binding.id,
          workspaceId: workspace.id,
          guestWorkspaceId: "alpha",
          mode: "linux-owned",
          guestPath: binding.guestPath,
          runtimeGeneration: generation,
          uid: 20000,
          homeGuestPath: "/home/alpha",
          head: null,
          branch: null,
          detached: false,
          repositoryFingerprint: null,
          gitCommonGuestPath: null,
          recreated: false,
          interruptedGuestWorkspaces: [],
          dependencyOverlays: [],
          cleanupWarnings: [],
        }),
      },
    );
    const input = encryptedChatCreateSchema.parse({
      ...protectedChatFields(),
      attachToTabLayout: false,
      worktreeMode: "pinned",
      cantripOsBindingId: binding.id,
    });
    const chat = await repository.createChat("owner", "project", input);
    expect(chat).toMatchObject({
      id: input.id,
      activeWorktreeId: binding.worktreeId,
      activeWorkerId: "worker",
    });
    expect(chat).toMatchObject({
      cantripOsBindingId: binding.id,
      cantripOsRuntimeGeneration: generation,
    });
    const placement = {
      cantripOsBindingId: binding.id,
      cantripOsRuntimeGeneration: generation,
    };
    const explorer = await repository.createExplorer("owner", "project", {
      ...protectedExplorerFields(),
      ...placement,
      worktreeId: binding.worktreeId,
      attachToTabLayout: false,
    });
    expect(explorer).toMatchObject(placement);
    expect(
      await repository.getExplorerExecutionContext("owner", explorer!.id),
    ).toMatchObject({
      root: {
        kind: "cantrip-os",
        scope: { bindingId: binding.id, runtimeGeneration: generation },
      },
    });
    const fileInput = {
      id: randomUUID(),
      worktreeId: binding.worktreeId,
      ...placement,
      stateProtection: {
        classification: { recordKind: "file-document-state" as const },
        protectedState: {
          formatVersion: 1 as const,
          keyRevision: 1,
          envelope: {
            version: 1 as const,
            algorithm: "AES-256-GCM" as const,
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    };
    const file = await repository.fileDocuments.create(
      "owner",
      "project",
      fileInput,
    );
    expect(file).toMatchObject(placement);
    expect(
      await repository.fileDocuments.create("owner", "project", fileInput),
    ).toEqual(file);
    expect(
      await repository.fileDocuments.executionContext("owner", file!.id),
    ).toMatchObject({
      root: { kind: "cantrip-os", scope: { bindingId: binding.id } },
    });
    expect(await repository.fileDocuments.get("other", file!.id)).toBeNull();
    await expect(
      repository.fileDocuments.create("other", "project", {
        ...fileInput,
        id: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      repository.fileDocuments.create("owner", "project", {
        ...fileInput,
        id: randomUUID(),
        cantripOsRuntimeGeneration: randomUUID(),
      }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      db.query(
        "UPDATE file_documents SET os_runtime_generation=$1 WHERE id=$2",
        [randomUUID(), file!.id],
      ),
    ).rejects.toThrow(/cannot be retargeted/);
    await expect(
      repository.fileDocuments.create("owner", "project", {
        ...fileInput,
        id: randomUUID(),
        cantripOsBindingId: undefined,
        cantripOsRuntimeGeneration: undefined,
      }),
    ).resolves.toBeNull();
    const context = await repository.getChatExecutionContext("owner", input.id);
    expect(context).toMatchObject({
      cwd: binding.guestPath,
      computerUseEnabled: false,
      osExecution: {
        kind: "cantrip-os",
        scope: {
          bindingId: binding.id,
          worktreeId: binding.worktreeId,
          uid: 20000,
          runtimeGeneration: generation,
        },
      },
    });
    expect(
      (
        await db.query(
          "SELECT absolute_path,guest_path FROM project_worktrees WHERE id=$1",
          [binding.worktreeId],
        )
      ).rows[0],
    ).toEqual({ absolute_path: null, guest_path: binding.guestPath });
    const lane = await repository.startChatExecutionLane(
      "owner",
      input.id,
      "user",
      "OS acceptance",
    );
    expect(lane).toMatchObject({
      worktreeId: binding.worktreeId,
      cwd: binding.guestPath,
      osExecution: context!.osExecution,
    });
    expect(
      (
        await db.query(
          "SELECT worktree_id FROM chat_execution_lanes WHERE id=$1",
          [lane!.executionLaneId],
        )
      ).rows[0],
    ).toEqual({ worktree_id: binding.worktreeId });
    const hostSource = randomUUID(),
      hostWorktree = randomUUID();
    await db.query(
      "INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path,source_kind) VALUES($1,'project','worker','/host/project','host','folder')",
      [hostSource],
    );
    await db.query(
      "INSERT INTO project_worktrees(id,project_source_id,worker_id,root_kind,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state) VALUES($1,$2,'worker','folder-root','Primary','/host/project','host',true,true,'cantrip','ready')",
      [hostWorktree, hostSource],
    );
    const linked = await os.createLinkedBinding("owner", {
      workspaceId: workspace.id,
      worktreeId: hostWorktree,
      dependencyOverlays: [],
    });
    await os.recordBindingOutcome(
      "owner",
      linked.id,
      {
        bindingGeneration: linked.bindingGeneration,
        attachmentGeneration: attached.attachmentGeneration,
        runtimeGeneration: generation,
      },
      {
        state: "ready",
        lastError: null,
        sourceReceipt: cantripOsSourceReceiptSchema.parse({
          bindingId: linked.id,
          workspaceId: workspace.id,
          guestWorkspaceId: "alpha",
          mode: "linked",
          guestPath: linked.guestPath,
          runtimeGeneration: generation,
          uid: 20000,
          homeGuestPath: "/home/alpha",
          head: null,
          branch: null,
          detached: false,
          repositoryFingerprint: null,
          gitCommonGuestPath: null,
          recreated: false,
          interruptedGuestWorkspaces: [],
          dependencyOverlays: [],
          cleanupWarnings: [],
        }),
      },
    );
    const linkedInput = encryptedChatCreateSchema.parse({
      ...protectedChatFields(),
      attachToTabLayout: false,
      worktreeMode: "pinned",
      cantripOsBindingId: linked.id,
    });
    await repository.createChat("owner", "project", linkedInput);
    expect(
      await repository.getChatExecutionContext("owner", linkedInput.id),
    ).toMatchObject({
      cwd: linked.guestPath,
      osExecution: {
        scope: {
          mode: "linked",
          linkedWorkerPath: "/host/project",
          worktreeId: hostWorktree,
        },
      },
    });
    expect(
      (
        await db.query(
          "SELECT absolute_path FROM project_sources WHERE id=$1",
          [hostSource],
        )
      ).rows[0],
    ).toEqual({ absolute_path: "/host/project" });
    await expect(
      db.query(
        "UPDATE cantrip_os_chat_placements SET runtime_generation=$1 WHERE chat_id=$2",
        [randomUUID(), input.id],
      ),
    ).rejects.toThrow(/cannot be retargeted/);
    await expect(
      repository.createChat("other", "project", { ...input, id: randomUUID() }),
    ).rejects.toThrow(/unavailable/);
    await os.observe(
      "owner",
      attached.id,
      attached.attachmentGeneration,
      { status: "connected", runtimeGeneration: randomUUID(), lastError: null },
      generation,
    );
    await expect(
      repository.getChatExecutionContext("owner", input.id),
    ).rejects.toThrow(/unavailable or changed/);
    await expect(
      repository.getExplorerExecutionContext("owner", explorer!.id),
    ).rejects.toThrow(/unavailable or changed/);
    await expect(
      repository.fileDocuments.executionContext("owner", file!.id),
    ).rejects.toThrow(/unavailable or changed/);
    await db.query("DELETE FROM projects WHERE id='project'");
  } finally {
    await db.close();
  }
}, 60000);
