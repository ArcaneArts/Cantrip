import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApplicationSession } from "@/components/auth/application-session";
import {
  clientLogger,
  installClientLogCapture,
  operationalErrorMetadata,
} from "@/lib/client-log-relay";
import { initializeServerConnections } from "@/lib/server-connections";

import "./index.css";

installClientLogCapture();

async function start(): Promise<void> {
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
  await initializeServerConnections();
  clientLogger.debug("Cantrip server state hydrated", {
    durationMs: Math.round(performance.now() - connectionsStartedAt),
    event: "client.boot.server-state-ready",
    operation: "hydrate",
    subsystem: "bootstrap",
  });
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
