import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import { AppLiveClient, appLiveWebSocketUrl } from "@/lib/app-live-client";
import { AppLiveQueryBridge } from "@/lib/app-live-query";
import { AppLiveProvider } from "@/lib/app-live-react";
import { router } from "@/router";
import {
  getActiveServerConnection,
  initializeServerConnections,
} from "@/lib/server-connections";
import { parseDesktopTabDragPreview } from "@/lib/desktop-window-coordinator";

import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

async function start(): Promise<void> {
  await initializeServerConnections();
  const server = getActiveServerConnection();
  const queryBridge = new AppLiveQueryBridge(queryClient);
  const clientIdKey = "cantrip.app-live.client-id.v1";
  let clientId = window.localStorage.getItem(clientIdKey);
  if (!clientId) {
    clientId = crypto.randomUUID();
    window.localStorage.setItem(clientIdKey, clientId);
  }
  const liveClient = new AppLiveClient({
    client: { id: clientId, name: "Cantrip App", version: "0.0.0" },
    onEvent: (event) => queryBridge.handleEvent(event),
    onResync: (scopes, reason) => queryBridge.recoverScopes(scopes, reason),
    storage: window.localStorage,
    storageKey: `cantrip.app-live.resume.v1.${server.id}`,
    url: appLiveWebSocketUrl(server.url, window.location.origin),
  });
  liveClient.retainScope({ kind: "current-user" });
  liveClient.start();
  window.addEventListener("online", () => liveClient.reconnectNow());
  window.addEventListener("beforeunload", () => liveClient.stop(), {
    once: true,
  });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppLiveProvider client={liveClient}>
          <RouterProvider router={router} />
        </AppLiveProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

const dragPreview = parseDesktopTabDragPreview(window.location.search);
if (dragPreview) {
  document.documentElement.classList.toggle(
    "dark",
    dragPreview.theme === "dark",
  );
  createRoot(document.getElementById("root")!).render(
    <div className="flex h-full items-center gap-2 overflow-hidden border bg-popover px-3 text-xs text-popover-foreground shadow-xl">
      <ProjectSurfaceIcon kind={dragPreview.kind} className="size-4 shrink-0" />
      <span className="truncate">{dragPreview.title}</span>
    </div>,
  );
} else {
  void start();
}
