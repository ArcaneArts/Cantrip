import { retireLegacyEditorWorker } from "@/lib/retire-legacy-editor-worker";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  clientLogger,
  installClientLogCapture,
  initializeClientLogPersistence,
  operationalErrorMetadata,
} from "@/lib/client-log-relay";
import {
  desktopWindowThemeOverride,
  isSyntheticBuildProgressWindow,
  parseDesktopStandaloneChatFileTarget,
  updateDesktopWindowTheme,
} from "@/lib/desktop-popout";
import { installNativeTooltipSuppression } from "@/lib/native-tooltip-suppression";
import { readStartupThemePreference } from "@/lib/startup-theme";

import "./index.css";

installClientLogCapture();
installNativeTooltipSuppression(document);

async function start(): Promise<void> {
  void retireLegacyEditorWorker().catch(() => undefined);
  const startupThemePreference = readStartupThemePreference();
  if (startupThemePreference) {
    void updateDesktopWindowTheme(
      desktopWindowThemeOverride(startupThemePreference),
    ).catch((error: unknown) => {
      clientLogger.warn("Cached desktop window theme could not be restored", {
        ...operationalErrorMetadata(error),
        event: "window.theme.startup.failed",
        operation: "restore-theme",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }
  if (isSyntheticBuildProgressWindow(window.location.search)) {
    await initializeClientLogPersistence();
    const { SyntheticBuildProgressWindow } =
      await import("@/components/settings/synthetic-build-progress-window");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <TooltipProvider>
          <SyntheticBuildProgressWindow />
        </TooltipProvider>
      </StrictMode>,
    );
    return;
  }
  // Legacy file links (including old broker launch IDs) use authenticated
  // startup. Their project/Explorer/path route is imported into ownership by
  // ExplorerFilePopout; a launch token is not resource authority.
  const standaloneChatFileTarget = parseDesktopStandaloneChatFileTarget(
    window.location.search,
  );
  await initializeClientLogPersistence();
  const startedAt = performance.now();
  const tauriRuntime = "__TAURI_INTERNALS__" in window;
  clientLogger.info("Cantrip client boot started", {
    event: "client.boot.started",
    operation: "boot",
    runtime: tauriRuntime ? "tauri" : "browser",
    subsystem: "bootstrap",
  });
  if (tauriRuntime) {
    void import("@tauri-apps/api/app")
      .then(async ({ getVersion }) => {
        clientLogger.info("Cantrip desktop runtime identified", {
          event: "client.runtime.identified",
          operation: "identify-runtime",
          runtime: "tauri",
          subsystem: "bootstrap",
          version: await getVersion(),
        });
      })
      .catch(() => {
        clientLogger.warn("Cantrip desktop version could not be resolved", {
          event: "client.runtime.identification.failed",
          operation: "identify-runtime",
          reasonCode: "version-unavailable",
          runtime: "tauri",
          subsystem: "bootstrap",
        });
      });
  }
  const connectionsStartedAt = performance.now();
  const { initializeServerConnections } =
    await import("@/lib/server-connections");
  await initializeServerConnections();
  clientLogger.debug("Cantrip server state hydrated", {
    durationMs: Math.round(performance.now() - connectionsStartedAt),
    event: "client.boot.server-state-ready",
    operation: "hydrate",
    subsystem: "bootstrap",
  });
  const { ApplicationSession } =
    await import("@/components/auth/application-session");
  let authenticatedContent: ReactNode;
  if (standaloneChatFileTarget) {
    const { StandaloneChatFileWindow } =
      await import("@/components/chat/standalone-chat-files-panel");
    authenticatedContent = (
      <StandaloneChatFileWindow
        chatId={standaloneChatFileTarget.chatId}
        path={standaloneChatFileTarget.path}
      />
    );
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <ApplicationSession authenticatedContent={authenticatedContent} />
      </TooltipProvider>
    </StrictMode>,
  );
  requestAnimationFrame(() => {
    clientLogger.info("Cantrip client shell rendered", {
      durationMs: Math.round(performance.now() - startedAt),
      event: "client.boot.rendered",
      operation: "boot",
      status: "ready",
      subsystem: "bootstrap",
    });
  });
}

void start().catch((error: unknown) => {
  clientLogger.fatal("Cantrip client boot failed", {
    ...operationalErrorMetadata(error),
    event: "client.boot.failed",
    operation: "boot",
    status: "failed",
    subsystem: "bootstrap",
  });
});
