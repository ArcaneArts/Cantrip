import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DesktopExplorerWindowLoadingShell } from "@/components/explorer/desktop-explorer-window-shell";
import {
  clientLogger,
  installClientLogCapture,
  initializeClientLogPersistence,
  operationalErrorMetadata,
} from "@/lib/client-log-relay";
import {
  desktopPopoutTitlebarLeftInset,
  desktopWindowThemeOverride,
  isMacosDesktopRuntime,
  isSyntheticBuildProgressWindow,
  parseDesktopExplorerFileTarget,
  updateDesktopWindowTheme,
} from "@/lib/desktop-popout";
import { readStartupThemePreference } from "@/lib/startup-theme";

import "./index.css";

installClientLogCapture();

async function start(): Promise<void> {
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
        <SyntheticBuildProgressWindow />
      </StrictMode>,
    );
    return;
  }
  const explorerWindowTarget = parseDesktopExplorerFileTarget(
    window.location.search,
  );
  if (explorerWindowTarget?.launchId) {
    void initializeClientLogPersistence().catch(() => undefined);
    const root = createRoot(document.getElementById("root")!);
    const overlayTitlebar = isMacosDesktopRuntime();
    const titlebarLeftInset = desktopPopoutTitlebarLeftInset(
      true,
      overlayTitlebar,
    );
    root.render(
      <DesktopExplorerWindowLoadingShell
        path={explorerWindowTarget.path}
        titlebarLeftInset={titlebarLeftInset}
      />,
    );
    const { DesktopExplorerFileWindow } =
      await import("@/components/explorer/desktop-explorer-file-window");
    root.render(
      <DesktopExplorerFileWindow
        initialPath={explorerWindowTarget.path}
        launchId={explorerWindowTarget.launchId}
      />,
    );
    return;
  }
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
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ApplicationSession />
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
