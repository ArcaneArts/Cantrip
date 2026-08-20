import {
  browserSummarySchema,
  codeTabSummarySchema,
  explorerSummarySchema,
  projectViewSummarySchema,
  remoteDesktopFleetSchema,
  remoteDesktopSummarySchema,
  remoteSurfaceSummarySchema,
  terminalSummarySchema,
  type BrowserSummary,
  type BrowserWireSummary,
  type CodeTabSummary,
  type CodeTabWireSummary,
  type ExplorerSummary,
  type ExplorerWireSummary,
  type ProjectViewSummary,
  type ProjectViewWireSummary,
  type RemoteDesktopFleet,
  type RemoteDesktopFleetWire,
  type RemoteDesktopSummary,
  type RemoteDesktopWireSummary,
  type RemoteSurfaceSummary,
  type RemoteSurfaceWireSummary,
  type TerminalSummary,
  type TerminalWireSummary,
} from "@cantrip/protocol";
import type {
  PrivateDisplayLabelOpaque,
  PrivateDisplayLabelRecordKind,
} from "@cantrip/protocol/private-labels";
import {
  browserPrivateStateProtectedContentSchema,
  explorerPrivateStateProtectedContentSchema,
  terminalPrivateStateProtectedContentSchema,
  type SurfacePrivateStateOpaque,
} from "@cantrip/protocol/surface-private-state";

import type { ClientEncryptionService } from "./client-encryption";
import { clientEncryption } from "./client-encryption";
import { getClientSession } from "./client-session";
import {
  decodePrivateDisplayLabelForClient,
  encodePrivateDisplayLabelForClient,
} from "./private-label-encryption";
import {
  decodeSurfacePrivateStateForClient,
  encodeSurfacePrivateStateForClient,
} from "./surface-private-state-encryption";

export class SurfaceTitleEncryptionAdapter {
  constructor(
    private readonly options: {
      service?: ClientEncryptionService;
      session?: typeof getClientSession;
    } = {},
  ) {}

  private get service(): ClientEncryptionService {
    return this.options.service ?? clientEncryption;
  }

  private identity() {
    const session = (this.options.session ?? getClientSession)();
    if (!session) {
      throw new Error(
        "An authenticated session is required for surface titles.",
      );
    }
    return { ownerId: session.user.id, serverId: session.serverId };
  }

  protect(
    rowId: string,
    title: string,
    recordKind: PrivateDisplayLabelRecordKind,
  ): Promise<PrivateDisplayLabelOpaque> {
    return encodePrivateDisplayLabelForClient({
      identity: this.identity(),
      label: title.trim(),
      recordKind,
      rowId,
      service: this.service,
    });
  }

  protectTerminalState(
    terminalId: string,
    directoryPath: string | null | undefined,
    serviceCommand: string,
  ): Promise<SurfacePrivateStateOpaque> {
    const identity = this.identity();
    return encodeSurfacePrivateStateForClient({
      identity,
      context: {
        serverId: identity.serverId,
        resource: "terminal-row",
        resourceId: terminalId,
        operationId: null,
        recordKind: "terminal-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "terminal-state" },
        directory: directoryPath
          ? { kind: "relative-path", path: directoryPath }
          : { kind: "project-root" },
        serviceCommand,
      },
      service: this.service,
    });
  }

  protectExplorerState(
    explorerId: string,
    selectedPath: string | null,
  ): Promise<SurfacePrivateStateOpaque> {
    const identity = this.identity();
    return encodeSurfacePrivateStateForClient({
      identity,
      context: {
        serverId: identity.serverId,
        resource: "explorer-row",
        resourceId: explorerId,
        operationId: null,
        recordKind: "explorer-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "explorer-state" },
        selectedPath,
      },
      service: this.service,
    });
  }

  protectBrowserState(
    browserId: string,
    url: string,
    revision: number,
  ): Promise<SurfacePrivateStateOpaque> {
    const identity = this.identity();
    return encodeSurfacePrivateStateForClient({
      identity,
      context: {
        serverId: identity.serverId,
        resource: "browser-row",
        resourceId: browserId,
        operationId: null,
        recordKind: "browser-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision,
        url,
      },
      service: this.service,
    });
  }

  protectBrowserOperation(
    browserId: string,
    operationId: string,
    url: string,
    revision: number,
  ): Promise<SurfacePrivateStateOpaque> {
    const identity = this.identity();
    return encodeSurfacePrivateStateForClient({
      identity,
      context: {
        serverId: identity.serverId,
        resource: "browser-operation",
        resourceId: browserId,
        operationId,
        recordKind: "browser-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision,
        url,
      },
      service: this.service,
    });
  }

  protectBrowserRemoteSurfaceState(
    surfaceId: string,
    url: string,
    revision: number,
  ): Promise<SurfacePrivateStateOpaque> {
    const identity = this.identity();
    return encodeSurfacePrivateStateForClient({
      identity,
      context: {
        serverId: identity.serverId,
        resource: "browser-remote-surface",
        resourceId: surfaceId,
        operationId: null,
        recordKind: "browser-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision,
        url,
      },
      service: this.service,
    });
  }

  async openBrowserOperation(input: {
    browserId: string;
    operationId: string;
    stateProtection: SurfacePrivateStateOpaque;
  }) {
    const identity = this.identity();
    return browserPrivateStateProtectedContentSchema.parse(
      await decodeSurfacePrivateStateForClient({
        identity,
        context: {
          serverId: identity.serverId,
          resource: "browser-operation",
          resourceId: input.browserId,
          operationId: input.operationId,
          recordKind: "browser-state",
        },
        opaque: input.stateProtection,
        service: this.service,
      }),
    );
  }

  private async openLabel(
    rowId: string,
    titleProtection: PrivateDisplayLabelOpaque,
    recordKind: PrivateDisplayLabelRecordKind,
  ): Promise<string> {
    return decodePrivateDisplayLabelForClient({
      identity: this.identity(),
      opaque: titleProtection,
      recordKind,
      rowId,
      service: this.service,
    });
  }

  async openTerminal(terminal: TerminalWireSummary): Promise<TerminalSummary> {
    const identity = this.identity();
    const state = terminalPrivateStateProtectedContentSchema.parse(
      await decodeSurfacePrivateStateForClient({
        identity,
        context: {
          serverId: identity.serverId,
          resource: "terminal-row",
          resourceId: terminal.id,
          operationId: null,
          recordKind: "terminal-state",
        },
        opaque: terminal.stateProtection,
        service: this.service,
      }),
    );
    const {
      serviceEnabled,
      stateProtection: _stateProtection,
      titleProtection,
      ...publicTerminal
    } = terminal;
    return terminalSummarySchema.parse({
      ...publicTerminal,
      title: await this.openLabel(terminal.id, titleProtection, "terminal"),
      directoryPath:
        state.directory.kind === "relative-path" ? state.directory.path : null,
      service: {
        enabled: serviceEnabled,
        command: state.serviceCommand,
      },
    });
  }

  async openExplorer(explorer: ExplorerWireSummary): Promise<ExplorerSummary> {
    const identity = this.identity();
    const state = explorerPrivateStateProtectedContentSchema.parse(
      await decodeSurfacePrivateStateForClient({
        identity,
        context: {
          serverId: identity.serverId,
          resource: "explorer-row",
          resourceId: explorer.id,
          operationId: null,
          recordKind: "explorer-state",
        },
        opaque: explorer.stateProtection,
        service: this.service,
      }),
    );
    const {
      stateProtection: _stateProtection,
      titleProtection,
      ...publicExplorer
    } = explorer;
    return explorerSummarySchema.parse({
      ...publicExplorer,
      title: await this.openLabel(explorer.id, titleProtection, "explorer"),
      selectedPath: state.selectedPath,
    });
  }

  async openCodeTab(codeTab: CodeTabWireSummary): Promise<CodeTabSummary> {
    const { titleProtection, ...publicCodeTab } = codeTab;
    return codeTabSummarySchema.parse({
      ...publicCodeTab,
      title: await this.openLabel(codeTab.id, titleProtection, "code-tab"),
    });
  }

  async openBrowser(browser: BrowserWireSummary): Promise<BrowserSummary> {
    const identity = this.identity();
    const state = browserPrivateStateProtectedContentSchema.parse(
      await decodeSurfacePrivateStateForClient({
        identity,
        context: {
          serverId: identity.serverId,
          resource: "browser-row",
          resourceId: browser.id,
          operationId: null,
          recordKind: "browser-state",
        },
        opaque: browser.stateProtection,
        service: this.service,
      }),
    );
    if (state.revision !== browser.stateRevision) {
      throw new Error("Browser private state revision is stale.");
    }
    const {
      stateProtection: _stateProtection,
      titleProtection,
      ...publicBrowser
    } = browser;
    return browserSummarySchema.parse({
      ...publicBrowser,
      title: await this.openLabel(browser.id, titleProtection, "browser"),
      url: state.url,
    });
  }

  async openRemoteDesktop(
    desktop: RemoteDesktopWireSummary,
  ): Promise<RemoteDesktopSummary> {
    const { titleProtection, ...publicDesktop } = desktop;
    return remoteDesktopSummarySchema.parse({
      ...publicDesktop,
      title: await this.openLabel(desktop.id, titleProtection, "project-view"),
    });
  }

  async openRemoteDesktopFleet(
    fleet: RemoteDesktopFleetWire,
  ): Promise<RemoteDesktopFleet> {
    return remoteDesktopFleetSchema.parse({
      ...fleet,
      workers: await Promise.all(
        fleet.workers.map(async (worker) => ({
          ...worker,
          desktops: await Promise.all(
            worker.desktops.map((desktop) => this.openRemoteDesktop(desktop)),
          ),
        })),
      ),
    });
  }

  async openRemoteSurface(
    surface: RemoteSurfaceWireSummary,
  ): Promise<RemoteSurfaceSummary> {
    let url: string | null = null;
    if (
      surface.kind === "browser" &&
      surface.stateProtection &&
      surface.stateRevision
    ) {
      const identity = this.identity();
      const managed =
        surface.titleProtection.classification.recordKind === "browser";
      const state = browserPrivateStateProtectedContentSchema.parse(
        await decodeSurfacePrivateStateForClient({
          identity,
          context: {
            serverId: identity.serverId,
            resource: managed ? "browser-row" : "browser-remote-surface",
            resourceId: surface.id,
            operationId: null,
            recordKind: "browser-state",
          },
          opaque: surface.stateProtection,
          service: this.service,
        }),
      );
      if (state.revision !== surface.stateRevision) {
        throw new Error("Remote Surface private state revision is stale.");
      }
      url = state.url;
    }
    const {
      stateProtection: _stateProtection,
      titleProtection,
      ...publicSurface
    } = surface;
    return remoteSurfaceSummarySchema.parse({
      ...publicSurface,
      title: await this.openLabel(
        surface.id,
        titleProtection,
        titleProtection.classification.recordKind,
      ),
      url,
    });
  }

  async openProjectView(
    view: ProjectViewWireSummary,
  ): Promise<ProjectViewSummary> {
    const { titleProtection, ...publicView } = view;
    return projectViewSummarySchema.parse({
      ...publicView,
      title: await this.openLabel(view.id, titleProtection, "project-view"),
    });
  }
}

export const surfaceTitleEncryption = new SurfaceTitleEncryptionAdapter();
