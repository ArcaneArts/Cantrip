import type {
  ArchivedChatWireSummary,
  ChatWireSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { ChatTitleEncryptionAdapter } from "./chat-title-encryption";
import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import { SurfaceTitleEncryptionAdapter } from "./surface-title-encryption";

const identity = { ownerId: "owner-a", serverId: "server-a" } as const;
const timestamp = "2026-08-20T12:00:00.000Z";

function session(): ClientSessionContext {
  return {
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: "2026-08-20T13:00:00.000Z",
    serverId: identity.serverId,
    user: {
      id: identity.ownerId,
      kind: "account",
      displayName: "Owner A",
      email: "owner-a@example.com",
      role: "owner",
    },
  };
}

function fixture() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: new Uint8Array(32).fill(29),
    identity,
    masterKeyRevision: 1,
  });
  return {
    adapter: new ChatTitleEncryptionAdapter({ service, session }),
    service,
  };
}

async function wire(
  adapter: ChatTitleEncryptionAdapter,
  id: string,
  title: string,
  experience: "agent" | "task" = "agent",
): Promise<ChatWireSummary> {
  return {
    id,
    projectId: "project-a",
    titleProtection: await adapter.protect(id, title),
    experience,
    position: 0,
    status: "idle",
    activeWorkerId: "worker-a",
    activeWorktreeId: "worktree-a",
    placementRevision: 1,
    worktreeMode: "agent-managed",
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    automationPaused: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("chat title encryption adapter", () => {
  it("opens ordinary, Task, archived, catalog, and tab-layout title copies", async () => {
    const { adapter, service } = fixture();
    const surfaceAdapter = new SurfaceTitleEncryptionAdapter({
      service,
      session,
    });
    const chatId = "00000000-0000-4000-8000-000000000011";
    const taskId = "00000000-0000-4000-8000-000000000012";
    const terminalId = "00000000-0000-4000-8000-000000000013";
    const chat = await wire(adapter, chatId, "Private agent");
    const task = await wire(adapter, taskId, "Private task", "task");
    const terminalProtection = await surfaceAdapter.protect(
      terminalId,
      "Private terminal",
      "terminal",
    );

    await expect(adapter.open(chat)).resolves.toMatchObject({
      title: "Private agent",
    });
    await expect(adapter.open(task)).resolves.toMatchObject({
      experience: "task",
      title: "Private task",
    });

    const archived: ArchivedChatWireSummary = {
      id: chat.id,
      projectId: chat.projectId,
      titleProtection: chat.titleProtection,
      experience: chat.experience,
      messageCount: 3,
      archivedAt: timestamp,
      expiresAt: "2026-11-18T12:00:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await expect(adapter.openArchived(archived)).resolves.toMatchObject({
      title: "Private agent",
    });

    await expect(
      adapter.openExecutionTargetCatalog({
        projectId: "project-a",
        truncated: false,
        targets: [
          {
            target: {
              kind: "surface",
              projectId: "project-a",
              surfaceKind: "chat",
              surfaceId: chatId,
            },
            placement: {
              projectId: "project-a",
              workerId: "worker-a",
              projectReplicaId: "replica-a",
              worktreeId: "worktree-a",
              surface: { kind: "chat", id: chatId },
            },
            worker: { workerId: "worker-a", name: "Worker", online: true },
            availability: "available",
            unavailableReason: null,
            resourceKind: "chat",
            title: null,
            titleProtection: chat.titleProtection,
            status: "idle",
          },
          {
            target: {
              kind: "surface",
              projectId: "project-a",
              surfaceKind: "terminal",
              surfaceId: terminalId,
            },
            placement: {
              projectId: "project-a",
              workerId: "worker-a",
              projectReplicaId: "replica-a",
              worktreeId: "worktree-a",
              surface: { kind: "terminal", id: terminalId },
            },
            worker: { workerId: "worker-a", name: "Worker", online: true },
            availability: "available",
            unavailableReason: null,
            resourceKind: "terminal",
            title: null,
            titleProtection: terminalProtection,
            status: "idle",
          },
        ],
      }),
    ).resolves.toMatchObject({
      targets: [{ title: "Private agent" }, { title: "Private terminal" }],
    });

    await expect(
      adapter.openTabLayout({
        projectId: "project-a",
        revision: 1,
        groups: [
          {
            id: "group-a",
            projectId: "project-a",
            title: null,
            position: 0,
            anchorTabKey: `chat:${chatId}`,
            members: [
              {
                tabKey: `chat:${chatId}`,
                groupId: "group-a",
                projectId: "project-a",
                tabKind: "chat",
                tabId: chatId,
                titleProtection: chat.titleProtection,
                position: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              {
                tabKey: `terminal:${terminalId}`,
                groupId: "group-a",
                projectId: "project-a",
                tabKind: "terminal",
                tabId: terminalId,
                titleProtection: terminalProtection,
                position: 1,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      }),
    ).resolves.toMatchObject({
      groups: [
        {
          title: "Private agent",
          members: [{ title: "Private agent" }, { title: "Private terminal" }],
        },
      ],
    });
  });

  it("rejects locked writes, stale revisions, wrong-row replay, and tampering", async () => {
    const locked = new ChatTitleEncryptionAdapter({
      service: new ClientEncryptionService(),
      session,
    });
    await expect(
      locked.protect("00000000-0000-4000-8000-000000000021", "Blocked"),
    ).rejects.toMatchObject({ state: "locked" });

    const { adapter } = fixture();
    const chat = await wire(
      adapter,
      "00000000-0000-4000-8000-000000000022",
      "Authenticated title",
    );
    const stale = structuredClone(chat);
    stale.titleProtection.protectedLabel.keyRevision = 2;
    stale.titleProtection.protectedLabel.envelope.keyRevision = 2;
    await expect(adapter.open(stale)).rejects.toMatchObject({ state: "stale" });

    await expect(
      adapter.open({
        ...chat,
        id: "00000000-0000-4000-8000-000000000023",
      }),
    ).rejects.toMatchObject({ state: "corrupt" });

    chat.titleProtection.protectedLabel.envelope.ciphertext =
      (chat.titleProtection.protectedLabel.envelope.ciphertext.startsWith("A")
        ? "B"
        : "A") +
      chat.titleProtection.protectedLabel.envelope.ciphertext.slice(1);
    await expect(adapter.open(chat)).rejects.toMatchObject({
      state: "corrupt",
    });
  });
});
