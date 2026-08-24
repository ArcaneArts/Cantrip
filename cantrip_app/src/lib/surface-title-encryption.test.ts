import type {
  BrowserWireSummary,
  CodeTabWireSummary,
  ExplorerWireSummary,
  ProjectViewWireSummary,
  RemoteDesktopWireSummary,
  RemoteSurfaceWireSummary,
  TerminalWireSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

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

function fixture(): SurfaceTitleEncryptionAdapter {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: new Uint8Array(32).fill(31),
    identity,
    masterKeyRevision: 1,
  });
  return new SurfaceTitleEncryptionAdapter({ service, session });
}

describe("surface title encryption adapter", () => {
  it("round-trips every encrypted surface and project-view title", async () => {
    const adapter = fixture();
    const ids = {
      terminal: "00000000-0000-4000-8000-000000000101",
      explorer: "00000000-0000-4000-8000-000000000102",
      code: "00000000-0000-4000-8000-000000000103",
      browser: "00000000-0000-4000-8000-000000000104",
      desktop: "00000000-0000-4000-8000-000000000105",
      surface: "00000000-0000-4000-8000-000000000106",
      view: "00000000-0000-4000-8000-000000000107",
    } as const;
    const common = {
      projectId: "project-a",
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;

    const terminal: TerminalWireSummary = {
      ...common,
      id: ids.terminal,
      kind: "interactive",
      titleProtection: await adapter.protect(
        ids.terminal,
        "Private terminal",
        "terminal",
      ),
      status: "idle",
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      linkedChatId: null,
      runConfigurationId: null,
      runConfigurationRuntimeId: null,
      stateProtection: await adapter.protectTerminalState(
        ids.terminal,
        "packages/app",
        "pnpm dev",
      ),
      serviceEnabled: true,
    };
    const explorer: ExplorerWireSummary = {
      ...common,
      id: ids.explorer,
      titleProtection: await adapter.protect(
        ids.explorer,
        "Private explorer",
        "explorer",
      ),
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      stateProtection: await adapter.protectExplorerState(
        ids.explorer,
        "src/private.ts",
      ),
      fileMode: "preview",
    };
    const code: CodeTabWireSummary = {
      ...common,
      id: ids.code,
      titleProtection: await adapter.protect(
        ids.code,
        "Private code",
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
      titleProtection: await adapter.protect(
        ids.browser,
        "Private browser",
        "browser",
      ),
      stateProtection: await adapter.protectBrowserState(
        ids.browser,
        "https://example.com",
        1,
      ),
      stateRevision: 1,
      workerId: "worker-a",
    };
    const desktop: RemoteDesktopWireSummary = {
      ...common,
      id: ids.desktop,
      titleProtection: await adapter.protect(
        ids.desktop,
        "Private desktop",
        "project-view",
      ),
      workerId: "worker-a",
      stateProtection: await adapter.protectRemoteDesktopState(
        ids.desktop,
        { kind: "monitor", id: null, name: null },
        1,
      ),
      stateRevision: 1,
      status: "idle",
      lastError: null,
    };
    const surface: RemoteSurfaceWireSummary = {
      id: ids.surface,
      projectId: "project-a",
      titleProtection: await adapter.protect(
        ids.surface,
        "Private surface",
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
      stateProtection: await adapter.protectBrowserRemoteSurfaceState(
        ids.surface,
        "https://example.com",
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
      titleProtection: await adapter.protect(
        ids.view,
        "Private history",
        "project-view",
      ),
      kind: "history",
      worktreeId: "worktree-a",
    };

    await expect(adapter.openTerminal(terminal)).resolves.toMatchObject({
      title: "Private terminal",
      directoryPath: "packages/app",
      service: { enabled: true, command: "pnpm dev" },
    });
    await expect(adapter.openExplorer(explorer)).resolves.toMatchObject({
      title: "Private explorer",
      selectedPath: "src/private.ts",
    });
    await expect(adapter.openCodeTab(code)).resolves.toMatchObject({
      title: "Private code",
    });
    await expect(adapter.openBrowser(browser)).resolves.toMatchObject({
      title: "Private browser",
    });
    await expect(adapter.openRemoteDesktop(desktop)).resolves.toMatchObject({
      title: "Private desktop",
      target: { kind: "monitor", id: null, name: null },
    });
    await expect(
      adapter.openRemoteDesktop({ ...desktop, stateRevision: 2 }),
    ).rejects.toThrow(/stale/u);
    await expect(adapter.openRemoteSurface(surface)).resolves.toMatchObject({
      title: "Private surface",
    });
    await expect(adapter.openProjectView(view)).resolves.toMatchObject({
      title: "Private history",
    });
  });

  it("opens a Run configuration terminal without interactive encryption", async () => {
    const adapter = fixture();
    const runtimeId = "00000000-0000-4000-8000-000000000119";
    const terminal: TerminalWireSummary = {
      id: runtimeId,
      projectId: "project-a",
      kind: "run-configuration",
      titleProtection: null,
      position: 0,
      status: "running",
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      linkedChatId: null,
      runConfigurationId: "00000000-0000-4000-8000-000000000118",
      runConfigurationRuntimeId: runtimeId,
      stateProtection: null,
      serviceEnabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await expect(adapter.openTerminal(terminal)).resolves.toMatchObject({
      kind: "run-configuration",
      title: "Run configuration",
      directoryPath: null,
      service: { enabled: false, command: "" },
    });
  });

  it("rejects a title replayed under another row id", async () => {
    const adapter = fixture();
    const protectedId = "00000000-0000-4000-8000-000000000111";
    const replayedId = "00000000-0000-4000-8000-000000000112";
    const terminal: TerminalWireSummary = {
      id: replayedId,
      projectId: "project-a",
      kind: "interactive",
      titleProtection: await adapter.protect(
        protectedId,
        "Bound title",
        "terminal",
      ),
      position: 0,
      status: "idle",
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      linkedChatId: null,
      runConfigurationId: null,
      runConfigurationRuntimeId: null,
      stateProtection: await adapter.protectTerminalState(replayedId, null, ""),
      serviceEnabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await expect(adapter.openTerminal(terminal)).rejects.toMatchObject({
      state: "corrupt",
    });
  });

  it("rejects Explorer state replayed under another row id", async () => {
    const adapter = fixture();
    const protectedId = "00000000-0000-4000-8000-000000000121";
    const replayedId = "00000000-0000-4000-8000-000000000122";
    const explorer: ExplorerWireSummary = {
      id: replayedId,
      projectId: "project-a",
      titleProtection: await adapter.protect(
        replayedId,
        "Bound Explorer",
        "explorer",
      ),
      position: 0,
      activeWorkerId: "worker-a",
      worktreeId: "worktree-a",
      stateProtection: await adapter.protectExplorerState(
        protectedId,
        "private/replayed.ts",
      ),
      fileMode: "edit",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await expect(adapter.openExplorer(explorer)).rejects.toMatchObject({
      state: "corrupt",
    });
  });
});
