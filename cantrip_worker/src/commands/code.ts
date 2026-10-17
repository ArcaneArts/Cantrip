import { type CodeSettingsWorkerStatus } from "@cantrip/protocol/code-settings";
import type { WorkerCommand } from "@cantrip/protocol";
import type { CodeSettingsSynchronizer } from "../code-settings-sync.js";
import type { CodeSupervisor } from "../code/supervisor.js";
import type { CodeDirectEndpointManager } from "../code/direct-endpoint.js";

export type CodeCommand = Extract<
  WorkerCommand,
  {
    type:
      | "code.settings.synchronize"
      | "code.settings.invalidate"
      | "code.settings.status"
      | "code.settings.resolve"
      | "code.settings.workbench.open"
      | "code.probe"
      | "code.open"
      | "code.status"
      | "code.stop"
      | "code.endpoint.revoke"
      | "code.transport.route.authorize"
      | "code.transport.route.revoke"
      | "code.transport.revoke"
      | "code.saveAll"
      | "code.openFile"
      | "code.getDirtyEditors"
      | "code.setTheme"
      | "code.prepareAgentTurn"
      | "code.agentTurnState";
  }
>;
export interface CodeCommandDependencies {
  ensureCodeSettingsSynchronizer: (options?: {
    forceAuthorizationResume?: boolean;
  }) => Promise<CodeSettingsSynchronizer | null>;
  unavailableCodeSettingsStatus: () => CodeSettingsWorkerStatus;
  getCodeSettingsSynchronizer: () => CodeSettingsSynchronizer | null;
  getDefaultCodeProfileId: () => string | null;
  code: Pick<
    CodeSupervisor,
    | "openSettingsWorkbench"
    | "probe"
    | "open"
    | "status"
    | "claimStop"
    | "saveAll"
    | "openFile"
    | "dirtyEditors"
    | "setTheme"
    | "prepareAgentTurn"
    | "agentTurnState"
  >;
  codeDirectEndpoints: Pick<
    CodeDirectEndpointManager,
    | "serverControlPlaneGeneration"
    | "closeSession"
    | "revoke"
    | "authorizeSharedRoute"
    | "revokeSharedRoute"
    | "revokeSharedTransport"
  >;
  activeCodeTransportSecurityIdentity: () => Parameters<
    CodeDirectEndpointManager["authorizeSharedRoute"]
  >[1];
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleCodeCommand(
  command: CodeCommand,
  dependencies: CodeCommandDependencies,
  context: { codeTransportLifecycleGeneration?: number },
): Promise<unknown> {
  const {
    ensureCodeSettingsSynchronizer,
    unavailableCodeSettingsStatus,
    getCodeSettingsSynchronizer,
    getDefaultCodeProfileId,
    code,
    codeDirectEndpoints,
    activeCodeTransportSecurityIdentity,
  } = dependencies;
  switch (command.type) {
    case "code.settings.synchronize": {
      const synchronizer = await ensureCodeSettingsSynchronizer({
        forceAuthorizationResume: true,
      });
      return synchronizer
        ? synchronizer.synchronize({
            initializeIfMissing: command.initializeIfMissing,
          })
        : unavailableCodeSettingsStatus();
    }
    case "code.settings.invalidate": {
      const synchronizer = await ensureCodeSettingsSynchronizer();
      return synchronizer
        ? synchronizer.invalidate(command.revision)
        : unavailableCodeSettingsStatus();
    }
    case "code.settings.status":
      return (
        (await ensureCodeSettingsSynchronizer())?.status() ??
        getCodeSettingsSynchronizer()?.status() ??
        unavailableCodeSettingsStatus()
      );
    case "code.settings.resolve": {
      const synchronizer = await ensureCodeSettingsSynchronizer({
        forceAuthorizationResume: true,
      });
      return synchronizer
        ? synchronizer.resolve(command.resolution)
        : unavailableCodeSettingsStatus();
    }
    case "code.settings.workbench.open": {
      const synchronizer = await ensureCodeSettingsSynchronizer({
        forceAuthorizationResume: true,
      });
      if (!synchronizer || !getDefaultCodeProfileId()) {
        throw new Error(
          "Code settings authorization is unavailable on this worker.",
        );
      }
      if (command.profileId !== getDefaultCodeProfileId()) {
        throw new Error("Code settings workbench profile binding is invalid.");
      }
      const synchronization = await synchronizer.synchronize({
        initializeIfMissing: true,
      });
      if (!["ready", "conflict"].includes(synchronization.state)) {
        throw new Error(
          synchronization.error ??
            "Global Code settings are not ready on this worker.",
        );
      }
      return {
        synchronization,
        runtime: await code.openSettingsWorkbench(command),
      };
    }
    case "code.probe":
      return {
        ...code.probe(),
        ...(codeDirectEndpoints.serverControlPlaneGeneration()
          ? {
              serverControlPlaneGeneration:
                codeDirectEndpoints.serverControlPlaneGeneration()!,
            }
          : {}),
      };
    case "code.open":
      return code.open(command);
    case "code.status":
      return code.status(command.sessionId);
    case "code.stop": {
      const claim = code.claimStop(
        command.sessionId,
        command.expectedSessionIncarnationId,
      );
      if (!claim.accepted) return claim.status;
      await codeDirectEndpoints.closeSession(
        command.sessionId,
        command.expectedSessionIncarnationId,
      );
      return claim.retire();
    }
    case "code.endpoint.revoke":
      codeDirectEndpoints.revoke(
        `protected:${command.tunnelId}`,
        "Code attachment released",
      );
      return { tunnelId: command.tunnelId };
    case "code.transport.route.authorize":
      return codeDirectEndpoints.authorizeSharedRoute(
        command,
        activeCodeTransportSecurityIdentity(),
        context.codeTransportLifecycleGeneration,
      );
    case "code.transport.route.revoke":
      return codeDirectEndpoints.revokeSharedRoute(
        command,
        activeCodeTransportSecurityIdentity(),
        context.codeTransportLifecycleGeneration,
      );
    case "code.transport.revoke":
      return codeDirectEndpoints.revokeSharedTransport(
        command,
        activeCodeTransportSecurityIdentity(),
        context.codeTransportLifecycleGeneration,
      );
    case "code.saveAll":
      return code.saveAll(command.sessionId);
    case "code.openFile":
      return code.openFile(command.sessionId, command.path);
    case "code.getDirtyEditors":
      return code.dirtyEditors(command.sessionId);
    case "code.setTheme":
      return code.setTheme(
        command.sessionId,
        command.themeMode,
        command.appearance,
      );
    case "code.prepareAgentTurn":
      return code.prepareAgentTurn(command.cwd);
    case "code.agentTurnState":
      return code.agentTurnState(command.cwd, command.phase, command.paths);
  }
}
