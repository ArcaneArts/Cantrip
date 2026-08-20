import type {
  ArchivedChatWireSummary,
  ChatWireSummary,
  ProjectTabLayoutWireSummary,
} from "@cantrip/protocol";
import type { PrivateDisplayLabelOpaque } from "@cantrip/protocol/private-labels";
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
    const defaultGroupId = "00000000-0000-4000-8000-000000000014";
    const customGroupId = "00000000-0000-4000-8000-000000000015";
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

    const tabLayout: ProjectTabLayoutWireSummary = {
      projectId: "project-a",
      revision: 1,
      groups: [
        {
          id: defaultGroupId,
          projectId: "project-a",
          titleProtection: null,
          position: 0,
          anchorTabKey: `chat:${chatId}`,
          members: [
            {
              tabKey: `chat:${chatId}`,
              groupId: defaultGroupId,
              projectId: "project-a",
              tabKind: "chat",
              tabId: chatId,
              titleProtection: chat.titleProtection,
              position: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: customGroupId,
          projectId: "project-a",
          titleProtection: await adapter.protectTabGroup(
            customGroupId,
            "Private group",
          ),
          position: 1,
          anchorTabKey: `terminal:${terminalId}`,
          members: [
            {
              tabKey: `terminal:${terminalId}`,
              groupId: customGroupId,
              projectId: "project-a",
              tabKind: "terminal",
              tabId: terminalId,
              titleProtection: terminalProtection,
              position: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              tabKey: `chat:${taskId}`,
              groupId: customGroupId,
              projectId: "project-a",
              tabKind: "chat",
              tabId: taskId,
              titleProtection: task.titleProtection,
              position: 2,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
    const expectedLayout = {
      groups: [
        {
          title: "Private agent",
          members: [{ title: "Private agent" }],
        },
        {
          title: "Private group",
          members: [{ title: "Private terminal" }, { title: "Private task" }],
        },
      ],
    };
    await expect(adapter.openTabLayout(tabLayout)).resolves.toMatchObject(
      expectedLayout,
    );
    await expect(
      fixture().adapter.openTabLayout(tabLayout),
    ).resolves.toMatchObject(expectedLayout);
  });

  it("rejects locked writes, stale revisions, wrong-row replay, and tampering", async () => {
    const locked = new ChatTitleEncryptionAdapter({
      service: new ClientEncryptionService(),
      session,
    });
    await expect(
      locked.protect("00000000-0000-4000-8000-000000000021", "Blocked"),
    ).rejects.toMatchObject({ state: "locked" });
    await expect(
      locked.protectTabGroup(
        "00000000-0000-4000-8000-000000000024",
        "Blocked group",
      ),
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

  it("rejects swapped, wrong-row, and tampered custom group envelopes", async () => {
    const { adapter, service } = fixture();
    const surfaceAdapter = new SurfaceTitleEncryptionAdapter({
      service,
      session,
    });
    const chatId = "00000000-0000-4000-8000-000000000031";
    const terminalId = "00000000-0000-4000-8000-000000000032";
    const groupId = "00000000-0000-4000-8000-000000000033";
    const chat = await wire(adapter, chatId, "Private chat");
    const terminalProtection = await surfaceAdapter.protect(
      terminalId,
      "Private terminal",
      "terminal",
    );
    const groupProtection = await adapter.protectTabGroup(
      groupId,
      "Private group",
    );
    const layout = (
      titleProtection: PrivateDisplayLabelOpaque,
    ): ProjectTabLayoutWireSummary => ({
      projectId: "project-a",
      revision: 1,
      groups: [
        {
          id: groupId,
          projectId: "project-a",
          titleProtection,
          position: 0,
          anchorTabKey: `chat:${chatId}`,
          members: [
            {
              tabKey: `chat:${chatId}`,
              groupId,
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
              groupId,
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
    });

    await expect(
      adapter.openTabLayout(layout(groupProtection)),
    ).resolves.toMatchObject({ groups: [{ title: "Private group" }] });
    await expect(
      adapter.openTabLayout({
        ...layout(groupProtection),
        groups: [
          {
            ...layout(groupProtection).groups[0]!,
            id: "00000000-0000-4000-8000-000000000034",
          },
        ],
      }),
    ).rejects.toMatchObject({ state: "corrupt" });
    await expect(
      adapter.openTabLayout(layout(chat.titleProtection)),
    ).rejects.toMatchObject({ state: "corrupt" });

    const tampered = structuredClone(groupProtection);
    tampered.protectedLabel.envelope.ciphertext =
      (tampered.protectedLabel.envelope.ciphertext.startsWith("A")
        ? "B"
        : "A") + tampered.protectedLabel.envelope.ciphertext.slice(1);
    await expect(adapter.openTabLayout(layout(tampered))).rejects.toMatchObject(
      {
        state: "corrupt",
      },
    );
  });
});
