import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApplicationSession } from "@/components/auth/application-session";
import { installDesktopClientLogRelay } from "@/lib/client-log-relay";
import { initializeServerConnections } from "@/lib/server-connections";

import "./index.css";

installDesktopClientLogRelay();

async function start(): Promise<void> {
  await initializeServerConnections();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ApplicationSession />
    </StrictMode>,
  );
}

void start();
