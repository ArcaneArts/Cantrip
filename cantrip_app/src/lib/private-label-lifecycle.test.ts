import { clearSensitiveBytes, generateAccountMasterKey } from "@cantrip/crypto";
import type {
  BrowserWireSummary,
  ChatWireSummary,
  CodeTabWireSummary,
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  ExplorerWireSummary,
  ProjectPreferredWorkerUpdate,
  ProjectTabLayoutWireSummary,
  ProjectViewWireSummary,
  ProjectWireSummary,
  RemoteDesktopWireSummary,
  RemoteSurfaceWireSummary,
  TerminalWireSummary,
  WorktreePolicy,
} from "@cantrip/protocol";
import type { PrivateDisplayLabelOpaque } from "@cantrip/protocol/private-labels";
import type {
  ClientMasterKeyWrapper,
  EncryptionKeyGrant,
  EncryptionPrincipal,
} from "@cantrip/protocol/encryption";
import { describe, expect, it } from "vitest";

import { ChatTitleEncryptionAdapter } from "./chat-title-encryption";
import {
  ClientEncryptionService,
  type ClientDeviceKeyStore,
  type ClientEncryptionIdentity,
  type StoredClientDeviceRecord,
} from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import {
  ProjectEncryptionAdapter,
  type ProjectWireApi,
} from "./project-encryption";
import { SurfaceTitleEncryptionAdapter } from "./surface-title-encryption";

const identity = {
  ownerId: "owner-private-label-lifecycle",
  serverId: "server-private-label-lifecycle",
} as const;
const timestamp = "2026-08-20T12:00:00.000Z";
const sentinel = "PROTECTED-APP-LIFECYCLE-SENTINEL";

class MemoryDeviceKeyStore implements ClientDeviceKeyStore {
  private readonly records = new Map<string, unknown>();

  delete(target: ClientEncryptionIdentity): Promise<void> {
    this.records.delete(this.key(target));
    return Promise.resolve();
  }

  load(target: ClientEncryptionIdentity): Promise<unknown | null> {
    return Promise.resolve(this.records.get(this.key(target)) ?? null);
  }

  save(record: StoredClientDeviceRecord): Promise<void> {
    this.records.set(this.key(record), record);
    return Promise.resolve();
  }

  private key(target: ClientEncryptionIdentity): string {
    return `${target.serverId}:${target.ownerId}`;
  }
}

function session(): ClientSessionContext {
  return {
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: "2026-08-20T13:00:00.000Z",
    serverId: identity.serverId,
    user: {
      id: identity.ownerId,
      kind: "account",
      displayName: "Lifecycle Owner",
      email: "lifecycle@example.com",
      role: "owner",
    },
  };
}

function authorization(
  device: Omit<StoredClientDeviceRecord, "privateKey">,
  wrappedKey: ClientMasterKeyWrapper,
): { grant: EncryptionKeyGrant; principal: EncryptionPrincipal } {
  return {
    principal: {
      id: device.clientId,
      ownerId: identity.ownerId,
      kind: "client",
      workerId: null,
      label: "Lifecycle browser",
      publicKey: device.publicKey,
      state: "approved",
      revision: 1,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    grant: {
      id: "89a82258-bebf-4cd8-b7d4-7069bf8f54c1",
      ownerId: identity.ownerId,
      principalId: device.clientId,
      component: "account-master-key",
      keyRevision: 1,
      wrappedKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function projectWire(
  id: string,
  nameProtection: PrivateDisplayLabelOpaque,
): ProjectWireSummary {
  return {
    id,
    nameProtection,
    position: 0,
    originKind: "managed-folder",
    folderManagement: "managed",
    capabilities: {
      git: false,
      worktrees: false,
      github: false,
      replicas: false,
      relocation: false,
    },
    setupStatus: "preparing",
    setupError: null,
    worktreePolicy: "direct",
    preferredWorkerId: "worker-a",
    github: null,
    source: null,
    replicas: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class MemoryProjectApi implements ProjectWireApi {
  readonly rows: ProjectWireSummary[] = [];

  createGithub(
    _input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary> {
    throw new Error("Not used by this lifecycle.");
  }

  async createManagedFolder(
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<ProjectWireSummary> {
    const row = projectWire(input.id, input.nameProtection);
    this.rows.push(row);
    return structuredClone(row);
  }

  list(): Promise<ProjectWireSummary[]> {
    return Promise.resolve(structuredClone(this.rows));
  }

  updatePreferredWorker(
    projectId: string,
    input: ProjectPreferredWorkerUpdate,
  ): Promise<ProjectWireSummary> {
    const row = this.rows.find(({ id }) => id === projectId)!;
    row.preferredWorkerId = input.workerId;
    return Promise.resolve(structuredClone(row));
  }

  updateWorktreePolicy(
    projectId: string,
    policy: WorktreePolicy,
  ): Promise<ProjectWireSummary> {
    const row = this.rows.find(({ id }) => id === projectId)!;
    row.worktreePolicy = policy;
    return Promise.resolve(structuredClone(row));
  }
}

function chatWire(
  id: string,
  projectId: string,
  titleProtection: PrivateDisplayLabelOpaque,
  experience: "agent" | "task",
): ChatWireSummary {
  return {
    id,
    projectId,
    titleProtection,
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

describe("protected app-facing label and surface-state lifecycle", () => {
  it("reopens every app-facing record through the same authorized device after restart", async () => {
    const store = new MemoryDeviceKeyStore();
    const first = new ClientEncryptionService(store);
    const device = await first.ensureDevice(identity);
    const accountMasterKey = generateAccountMasterKey();
    first.setAccountMasterKey({
      accountMasterKey,
      identity,
      masterKeyRevision: 1,
    });
    const wrapper = await first.createDeviceWrapper(identity);
    const projectApi = new MemoryProjectApi();
    const projects = new ProjectEncryptionAdapter({
      api: projectApi,
      service: first,
      session,
    });
    const chats = new ChatTitleEncryptionAdapter({ service: first, session });
    const surfaces = new SurfaceTitleEncryptionAdapter({
      service: first,
      session,
    });
    const project = await projects.createManagedFolder({
      name: `${sentinel}-project`,
      workerId: "worker-a",
    });
    const ids = {
      chat: "00000000-0000-4000-8000-000000000201",
      task: "00000000-0000-4000-8000-000000000202",
      terminal: "00000000-0000-4000-8000-000000000203",
      explorer: "00000000-0000-4000-8000-000000000204",
      code: "00000000-0000-4000-8000-000000000205",
      browser: "00000000-0000-4000-8000-000000000206",
      desktop: "00000000-0000-4000-8000-000000000207",
      surface: "00000000-0000-4000-8000-000000000208",
      view: "00000000-0000-4000-8000-000000000209",
      group: "00000000-0000-4000-8000-000000000210",
    } as const;
    const common = {
      projectId: project.id,
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const chat = chatWire(
      ids.chat,
      project.id,
      await chats.protect(ids.chat, `${sentinel}-chat`),
      "agent",
    );
    const task = chatWire(
      ids.task,
      project.id,
      await chats.protect(ids.task, `${sentinel}-task`),
      "task",
    );
    const terminal: TerminalWireSummary = {
      ...common,
      id: ids.terminal,
      titleProtection: await surfaces.protect(
        ids.terminal,
        `${sentinel}-terminal`,
        "terminal",
      ),
      status: "idle",
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      linkedChatId: null,
      stateProtection: await surfaces.protectTerminalState(
        ids.terminal,
        `${sentinel}/terminal-directory`,
        `${sentinel}-service-command`,
      ),
      serviceEnabled: false,
    };
    const explorer: ExplorerWireSummary = {
      ...common,
      id: ids.explorer,
      titleProtection: await surfaces.protect(
        ids.explorer,
        `${sentinel}-explorer`,
        "explorer",
      ),
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      stateProtection: await surfaces.protectExplorerState(
        ids.explorer,
        `${sentinel}/selected-file.ts`,
      ),
      fileMode: "preview",
    };
    const code: CodeTabWireSummary = {
      ...common,
      id: ids.code,
      titleProtection: await surfaces.protect(
        ids.code,
        `${sentinel}-code`,
        "code-tab",
      ),
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      profileId: "default",
      themeMode: "follow-cantrip",
      status: "idle",
      lastError: null,
    };
    const browser: BrowserWireSummary = {
      ...common,
      id: ids.browser,
      titleProtection: await surfaces.protect(
        ids.browser,
        `${sentinel}-browser`,
        "browser",
      ),
      stateProtection: await surfaces.protectBrowserState(
        ids.browser,
        `https://example.com/${sentinel}/browser`,
        1,
      ),
      stateRevision: 1,
      workerId: "worker-a",
    };
    const desktop: RemoteDesktopWireSummary = {
      ...common,
      id: ids.desktop,
      titleProtection: await surfaces.protect(
        ids.desktop,
        `${sentinel}-desktop`,
        "project-view",
      ),
      workerId: "worker-a",
      stateProtection: await surfaces.protectRemoteDesktopState(
        ids.desktop,
        {
          kind: "window",
          id: "private-window",
          application: `${sentinel}-application`,
          title: `${sentinel}-window-title`,
        },
        1,
      ),
      stateRevision: 1,
      status: "idle",
      lastError: null,
    };
    const surface: RemoteSurfaceWireSummary = {
      id: ids.surface,
      projectId: project.id,
      titleProtection: await surfaces.protect(
        ids.surface,
        `${sentinel}-surface`,
        "remote-surface",
      ),
      workerId: "worker-a",
      kind: "browser",
      status: "idle",
      preferredTransport: "webrtc",
      configuration: {
        kind: "browser",
        profileId: null,
      },
      stateProtection: await surfaces.protectBrowserRemoteSurfaceState(
        ids.surface,
        `https://example.com/${sentinel}/surface`,
        1,
      ),
      stateRevision: 1,
      lastError: null,
      lastConnectedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const view: ProjectViewWireSummary = {
      ...common,
      id: ids.view,
      titleProtection: await surfaces.protect(
        ids.view,
        `${sentinel}-view`,
        "project-view",
      ),
      kind: "history",
      worktreeId: "worktree-a",
    };
    const layout: ProjectTabLayoutWireSummary = {
      projectId: project.id,
      revision: 1,
      groups: [
        {
          id: ids.group,
          projectId: project.id,
          titleProtection: await chats.protectTabGroup(
            ids.group,
            `${sentinel}-group`,
          ),
          position: 0,
          anchorTabKey: `chat:${ids.chat}`,
          members: [
            {
              tabKey: `chat:${ids.chat}`,
              groupId: ids.group,
              projectId: project.id,
              tabKind: "chat",
              tabId: ids.chat,
              titleProtection: chat.titleProtection,
              position: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              tabKey: `terminal:${ids.terminal}`,
              groupId: ids.group,
              projectId: project.id,
              tabKind: "terminal",
              tabId: ids.terminal,
              titleProtection: terminal.titleProtection,
              position: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
    const wireState = {
      projects: projectApi.rows,
      chats: [chat, task],
      surfaces: [terminal, explorer, code, browser, desktop, surface, view],
      layout,
    };
    expect(JSON.stringify(wireState)).not.toContain(sentinel);
    expect(projectApi.rows.every((row) => !("name" in row))).toBe(true);

    first.lock();
    const restarted = new ClientEncryptionService(store);
    await restarted.loadDevice(identity);
    await restarted.unlockWithDevice({
      identity,
      ...authorization(device, wrapper),
    });
    const reopenedProjects = new ProjectEncryptionAdapter({
      api: projectApi,
      service: restarted,
      session,
    });
    const reopenedChats = new ChatTitleEncryptionAdapter({
      service: restarted,
      session,
    });
    const reopenedSurfaces = new SurfaceTitleEncryptionAdapter({
      service: restarted,
      session,
    });

    await expect(reopenedProjects.list()).resolves.toMatchObject([
      { name: `${sentinel}-project` },
    ]);
    await expect(
      Promise.all([reopenedChats.open(chat), reopenedChats.open(task)]),
    ).resolves.toMatchObject([
      { title: `${sentinel}-chat` },
      { experience: "task", title: `${sentinel}-task` },
    ]);
    await expect(
      Promise.all([
        reopenedSurfaces.openTerminal(terminal),
        reopenedSurfaces.openExplorer(explorer),
        reopenedSurfaces.openCodeTab(code),
        reopenedSurfaces.openBrowser(browser),
        reopenedSurfaces.openRemoteDesktop(desktop),
        reopenedSurfaces.openRemoteSurface(surface),
        reopenedSurfaces.openProjectView(view),
      ]),
    ).resolves.toMatchObject([
      {
        title: `${sentinel}-terminal`,
        directoryPath: `${sentinel}/terminal-directory`,
        service: { command: `${sentinel}-service-command` },
      },
      {
        title: `${sentinel}-explorer`,
        selectedPath: `${sentinel}/selected-file.ts`,
      },
      { title: `${sentinel}-code` },
      {
        title: `${sentinel}-browser`,
        url: `https://example.com/${sentinel}/browser`,
      },
      {
        title: `${sentinel}-desktop`,
        target: {
          application: `${sentinel}-application`,
          title: `${sentinel}-window-title`,
        },
      },
      {
        title: `${sentinel}-surface`,
        url: `https://example.com/${sentinel}/surface`,
      },
      { title: `${sentinel}-view` },
    ]);
    await expect(reopenedChats.openTabLayout(layout)).resolves.toMatchObject({
      groups: [{ title: `${sentinel}-group` }],
    });

    clearSensitiveBytes(accountMasterKey);
    restarted.lock();
  });
});
