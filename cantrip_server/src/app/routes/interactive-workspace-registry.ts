import type { FastifyInstance } from "fastify";

import { installBrowserServiceDiscoveryRoutes } from "./browser-service-discovery.js";
import {
  installBrowserListRoute,
  installBrowserManagementRoutes,
} from "./browser-management.js";
import {
  installCodeTabDeleteRoute,
  installCodeTabWorktreeRoute,
} from "./code-tab-lifecycle.js";
import { installCodeTabManagementRoutes } from "./code-tab-management.js";
import {
  installExplorerBasicManagementRoutes,
  installExplorerListRoute,
  installExplorerViewStateRoute,
} from "./explorer-management.js";
import {
  installExplorerDeleteRoute,
  installExplorerOperationRoute,
  installExplorerWorktreeRoute,
} from "./explorer-runtime.js";
import { installProjectExportRoutes } from "./project-exports.js";
import { installProjectExternalChatHistoryRoute } from "./project-external-chat-history.js";
import { installProjectViewRoutes } from "./project-views.js";
import { installRemoteDesktopManagementRoutes } from "./remote-desktop-management.js";
import { installRemoteDesktopReadRoutes } from "./remote-desktop-read.js";
import { installRemoteSurfaceConnectionRoute } from "./remote-surface-connection.js";
import { installRemoteSurfaceManagementRoutes } from "./remote-surface-management.js";
import { installRunConfigurationSecretRoutes } from "./run-configuration-secrets.js";
import { installTabLayoutRoutes } from "./tab-layouts.js";
import {
  installChatLinkedConsoleRoute,
  installProtectedScriptCommandRoutes,
  installTerminalWorktreeLifecycleRoutes,
} from "./terminal-context.js";
import { installTerminalDirectAttachmentRoute } from "./terminal-direct-attachments.js";
import {
  installTerminalCreateRoute,
  installTerminalListRoute,
  installTerminalManagementRoutes,
} from "./terminal-management.js";
import { installTerminalRelayWebSocketRoute } from "./terminal-relay-websocket.js";
import { installWorkerLinkObservationGrantRoute } from "./worker-link-observation-grants.js";
import { installWorkerLinkRemoteSurfaceGrantRoute } from "./worker-link-remote-surface-grants.js";
import { installWorkerLinkTerminalGrantRoute } from "./worker-link-terminal-grants.js";
import { installWorkerLinkTunnelAttachmentGrantRoute } from "./worker-link-tunnel-attachment-grants.js";

type TerminalCreateDependencies = Parameters<
  typeof installTerminalCreateRoute
>[1];
type TerminalManagementDependencies = Parameters<
  typeof installTerminalManagementRoutes
>[1];
type CodeTabManagementDependencies = Parameters<
  typeof installCodeTabManagementRoutes
>[1];
type ExplorerManagementDependencies = Parameters<
  typeof installExplorerBasicManagementRoutes
>[1];

export type InteractiveWorkspaceRouteDependencies = Parameters<
  typeof installChatLinkedConsoleRoute
>[1] &
  Parameters<typeof installProtectedScriptCommandRoutes>[1] &
  Parameters<typeof installTerminalWorktreeLifecycleRoutes>[1] &
  Parameters<typeof installTerminalListRoute>[1] &
  Parameters<typeof installRunConfigurationSecretRoutes>[1] &
  Omit<TerminalCreateDependencies, "runtime"> &
  Omit<TerminalManagementDependencies, "runtime"> &
  Parameters<typeof installExplorerListRoute>[1] &
  Omit<CodeTabManagementDependencies, "runtime"> &
  Parameters<typeof installCodeTabWorktreeRoute>[1] &
  Parameters<typeof installCodeTabDeleteRoute>[1] &
  Parameters<typeof installBrowserListRoute>[1] &
  Parameters<typeof installProjectExportRoutes>[1] &
  Parameters<typeof installProjectExternalChatHistoryRoute>[1] &
  Parameters<typeof installBrowserServiceDiscoveryRoutes>[1] &
  Parameters<typeof installBrowserManagementRoutes>[1] &
  Parameters<typeof installRemoteDesktopReadRoutes>[1] &
  Parameters<typeof installRemoteDesktopManagementRoutes>[1] &
  Parameters<typeof installRemoteSurfaceManagementRoutes>[1] &
  Parameters<typeof installRemoteSurfaceConnectionRoute>[1] &
  Parameters<typeof installProjectViewRoutes>[1] &
  Omit<ExplorerManagementDependencies, "runtime"> &
  Parameters<typeof installExplorerWorktreeRoute>[1] &
  Parameters<typeof installExplorerViewStateRoute>[1] &
  Parameters<typeof installExplorerDeleteRoute>[1] &
  Parameters<typeof installExplorerOperationRoute>[1] &
  Parameters<typeof installWorkerLinkObservationGrantRoute>[1] &
  Parameters<typeof installWorkerLinkTunnelAttachmentGrantRoute>[1] &
  Parameters<typeof installWorkerLinkRemoteSurfaceGrantRoute>[1] &
  Parameters<typeof installWorkerLinkTerminalGrantRoute>[1] &
  Parameters<typeof installTerminalDirectAttachmentRoute>[1] &
  Omit<
    Parameters<typeof installTerminalRelayWebSocketRoute>[1],
    "appOrigins" | "usageRecorder"
  > &
  Parameters<typeof installTabLayoutRoutes>[1] & {
    installProjectRunConfigurationRoutes: (app: FastifyInstance) => void;
    isWorkerConnected: CodeTabManagementDependencies["runtime"]["isWorkerConnected"] &
      ExplorerManagementDependencies["runtime"]["isWorkerConnected"];
    relayCoordinationEnabled: boolean;
    terminalServiceRuntime: TerminalCreateDependencies["runtime"] &
      TerminalManagementDependencies["runtime"];
  };

/** Registers the contiguous terminal, Code, Browser, and remote surface tranche. */
export function installInteractiveWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: InteractiveWorkspaceRouteDependencies,
): void {
  const terminalContextRouteDependencies = dependencies;
  installChatLinkedConsoleRoute(app, terminalContextRouteDependencies);

  installTerminalListRoute(app, dependencies);

  installRunConfigurationSecretRoutes(app, dependencies);

  dependencies.installProjectRunConfigurationRoutes(app);

  installTerminalCreateRoute(app, {
    ...dependencies,
    runtime: dependencies.terminalServiceRuntime,
  });

  installProtectedScriptCommandRoutes(app, terminalContextRouteDependencies);

  installTerminalManagementRoutes(app, {
    ...dependencies,
    runtime: dependencies.terminalServiceRuntime,
  });

  installTerminalWorktreeLifecycleRoutes(app, terminalContextRouteDependencies);

  installExplorerListRoute(app, dependencies);

  installCodeTabManagementRoutes(app, {
    ...dependencies,
    runtime: { isWorkerConnected: dependencies.isWorkerConnected },
  });

  const codeTabAttachmentRouteDependencies = dependencies;
  installCodeTabWorktreeRoute(app, codeTabAttachmentRouteDependencies);

  installCodeTabDeleteRoute(app, codeTabAttachmentRouteDependencies);

  installBrowserListRoute(app, dependencies);

  installProjectExportRoutes(app, dependencies);

  installProjectExternalChatHistoryRoute(app, dependencies);

  installBrowserServiceDiscoveryRoutes(app, dependencies);

  installBrowserManagementRoutes(app, dependencies);

  installRemoteDesktopReadRoutes(app, dependencies);

  installRemoteDesktopManagementRoutes(app, dependencies);

  installRemoteSurfaceManagementRoutes(app, dependencies);

  installRemoteSurfaceConnectionRoute(app, dependencies);

  installProjectViewRoutes(app, dependencies);

  installExplorerBasicManagementRoutes(app, {
    ...dependencies,
    runtime: { isWorkerConnected: dependencies.isWorkerConnected },
  });

  installExplorerWorktreeRoute(app, dependencies);

  installExplorerViewStateRoute(app, dependencies);

  installExplorerDeleteRoute(app, dependencies);

  installExplorerOperationRoute(app, dependencies);

  installWorkerLinkObservationGrantRoute(app, dependencies);

  installWorkerLinkTunnelAttachmentGrantRoute(app, dependencies);

  installWorkerLinkRemoteSurfaceGrantRoute(app, dependencies);

  installWorkerLinkTerminalGrantRoute(app, dependencies);

  installTerminalDirectAttachmentRoute(app, dependencies);

  installTerminalRelayWebSocketRoute(app, {
    ...dependencies,
    appOrigins: dependencies.config.appOrigins,
    usageRecorder: dependencies.accountUsageMeter,
  });

  installTabLayoutRoutes(app, dependencies);
}
