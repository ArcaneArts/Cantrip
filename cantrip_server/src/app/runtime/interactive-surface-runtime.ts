import type {
  AppLiveResource,
  CodeRuntimeStatus,
  CodeThemeUpdate,
  EncryptedBrowserUpdate,
  WorkerSummary,
} from "@cantrip/protocol";

import type { CodeTunnelBroker } from "../../code/tunnel.js";
import {
  WORKER_ONLINE_WINDOW_MS,
  type ServerRepository,
} from "../../db/repository.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import { workerPresenceFingerprint } from "../../workers/presence.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";

export interface CodeTabWorkerRuntime {
  isWorkerConnected: (workerId: string) => boolean;
  readStatus: (workerId: string, sessionId: string) => Promise<unknown>;
  saveAll: (workerId: string, sessionId: string) => Promise<unknown>;
  stop: (workerId: string, sessionId: string) => Promise<unknown>;
  setTheme: (
    workerId: string,
    sessionId: string,
    appearance: CodeThemeUpdate["appearance"],
  ) => Promise<unknown>;
  revokeTunnelSession: (sessionId: string) => Promise<void>;
  revokeDirectSession: (ownerId: string, sessionId: string) => Promise<void>;
  recordSessionRuntime: (
    ownerId: string,
    codeTabId: string,
    sessionId: string,
    runtime: CodeRuntimeStatus,
  ) => Promise<unknown>;
}

export interface InteractiveSurfaceRuntimeDependencies {
  bridge: WorkerCommandBus;
  codeTunnel: Pick<CodeTunnelBroker, "revokeSession">;
  directAttachments: Pick<DirectAttachmentCoordinator, "revokeResource">;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
  serverId: string;
}

/** Owns shared state and operations for browser, terminal, Code, and worker-presence surfaces. */
export function createInteractiveSurfaceRuntime({
  bridge,
  codeTunnel,
  directAttachments,
  publishLiveInvalidation,
  repository,
  runAsOwner,
  serverId,
}: InteractiveSurfaceRuntimeDependencies) {
  const surfaceAttachmentCounts = new Map<string, number>();
  const workerOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const workerPresenceFingerprints = new Map<string, string>();

  const publishWorkerPresence = (
    ownerId: string,
    worker: WorkerSummary,
  ): void => {
    runAsOwner(ownerId, () => {
      const fingerprint = workerPresenceFingerprint(worker);
      if (workerPresenceFingerprints.get(worker.workerId) === fingerprint)
        return;
      workerPresenceFingerprints.set(worker.workerId, fingerprint);
      publishLiveInvalidation("worker", { entityId: worker.workerId });
    });
  };
  const scheduleWorkerOfflineInvalidation = (
    ownerId: string,
    workerId: string,
  ): void => {
    const existing = workerOfflineTimers.get(workerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      workerOfflineTimers.delete(workerId);
      workerPresenceFingerprints.delete(workerId);
      runAsOwner(ownerId, () =>
        publishLiveInvalidation("worker-availability", { entityId: workerId }),
      );
    }, WORKER_ONLINE_WINDOW_MS + 50);
    timer.unref();
    workerOfflineTimers.set(workerId, timer);
  };
  const updateRemoteSurfaceStatus = async (
    surfaceId: string,
    status: Parameters<typeof repository.setRemoteSurfaceStatus>[1],
    error: string | null = null,
  ) => {
    const result = await repository.setRemoteSurfaceStatus(
      surfaceId,
      status,
      error,
    );
    publishLiveInvalidation("browser", { entityId: surfaceId });
    publishLiveInvalidation("remote-desktop", { entityId: surfaceId });
    publishLiveInvalidation("project-view", { entityId: surfaceId });
    return result;
  };
  const applyBrowserUpdate = async (
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
    options: { expectedWorkerId?: string; requireOnline?: boolean } = {},
  ) => {
    const context = await repository.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    if (
      !context ||
      context.surface.kind !== "browser" ||
      (options.expectedWorkerId &&
        context.workerId !== options.expectedWorkerId)
    ) {
      return null;
    }
    const browser = await repository.updateBrowser(ownerId, browserId, input);
    if (!browser || input.stateProtection === undefined) return browser;
    publishLiveInvalidation("browser", {
      entityId: browserId,
      projectId: browser.projectId,
    });
    const updatedContext = await repository.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    if (
      !updatedContext ||
      updatedContext.workerId !== context.workerId ||
      updatedContext.surface.configuration.kind !== "browser"
    ) {
      throw new Error("Browser placement changed before configuration.");
    }
    if (!bridge.isConnected(context.workerId)) {
      await updateRemoteSurfaceStatus(
        browserId,
        "offline",
        "Worker is offline. The saved URL will be restored when it reconnects.",
      );
      if (options.requireOnline) {
        throw new WorkerUnavailableError("Browser worker is offline.");
      }
      return browser;
    }
    try {
      await bridge.request(
        context.workerId,
        {
          type: "surface.configure",
          surfaceId: browserId,
          serverId,
          configuration: updatedContext.surface.configuration,
          stateResource: "browser-row",
          stateRevision: updatedContext.surface.stateRevision,
          stateProtection: updatedContext.surface.stateProtection,
        },
        { timeoutMs: 20_000 },
      );
    } catch (error) {
      await updateRemoteSurfaceStatus(
        browserId,
        "error",
        "Browser private state could not be applied.",
      );
      if (options.requireOnline) throw error;
    }
    return browser;
  };
  const updateTerminalStatus = async (
    terminalId: string,
    status: Parameters<typeof repository.setTerminalStatus>[1],
  ) => {
    const result = await repository.setTerminalStatus(terminalId, status);
    publishLiveInvalidation("terminal", { entityId: terminalId });
    return result;
  };
  const synchronizeTerminalServicesForWorker = async (
    workerId: string,
  ): Promise<void> => {
    if (!bridge.isConnected(workerId)) return;
    const services = await repository.listTerminalServicesForWorker(
      workerId,
      serverId,
    );
    await bridge.request(
      workerId,
      { type: "terminal.services.reconcile", services },
      { timeoutMs: 30_000 },
    );
    await Promise.all(
      services.map(({ terminalId }) =>
        updateTerminalStatus(terminalId, "running"),
      ),
    );
  };
  const terminalServiceRuntime = {
    isWorkerConnected: (workerId: string): boolean =>
      bridge.isConnected(workerId),
    reconcileServicesForWorker: synchronizeTerminalServicesForWorker,
    recordStatus: updateTerminalStatus,
    restartService: async (
      workerId: string,
      terminalId: string,
    ): Promise<void> => {
      await bridge.request(
        workerId,
        { type: "terminal.service.restart", terminalId },
        { timeoutMs: 30_000 },
      );
    },
  };
  const updateCodeSessionRuntime = async (
    ...input: Parameters<typeof repository.updateCodeSessionRuntime>
  ) => {
    const result = await repository.updateCodeSessionRuntime(...input);
    publishLiveInvalidation("code-tab");
    return result;
  };
  const codeTabWorkerRuntime: CodeTabWorkerRuntime = {
    isWorkerConnected: (workerId) => bridge.isConnected(workerId),
    readStatus: (workerId, sessionId) =>
      bridge.request(workerId, { type: "code.status", sessionId }),
    saveAll: (workerId, sessionId) =>
      bridge.request(workerId, { type: "code.saveAll", sessionId }),
    stop: (workerId, sessionId) =>
      bridge.request(workerId, { type: "code.stop", sessionId }),
    setTheme: (workerId, sessionId, appearance) =>
      bridge.request(workerId, {
        type: "code.setTheme",
        sessionId,
        themeMode: "follow-cantrip",
        appearance,
      }),
    revokeTunnelSession: (sessionId) => codeTunnel.revokeSession(sessionId),
    revokeDirectSession: async (ownerId, sessionId) => {
      await directAttachments.revokeResource(ownerId, "code", sessionId);
    },
    recordSessionRuntime: updateCodeSessionRuntime,
  };

  return {
    applyBrowserUpdate,
    close: (): void => {
      for (const timer of workerOfflineTimers.values()) clearTimeout(timer);
      workerOfflineTimers.clear();
    },
    codeTabWorkerRuntime,
    publishWorkerPresence,
    scheduleWorkerOfflineInvalidation,
    surfaceAttachmentCounts,
    synchronizeTerminalServicesForWorker,
    terminalServiceRuntime,
    updateCodeSessionRuntime,
    updateRemoteSurfaceStatus,
    updateTerminalStatus,
    workerPresenceFingerprints,
  };
}
