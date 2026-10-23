import { explorerMediaTypeForPath } from "@cantrip/protocol";
import type {
  CodeAppearance,
  ExplorerFile,
  ExplorerFileMode,
  ExplorerSummary,
} from "@cantrip/protocol";

import {
  defaultExplorerFileMode,
  structuredFileFormatForPath,
} from "@/components/explorer/explorer-file-language";

export const desktopExplorerWindowLaunchParameter = "cantrip-explorer-launch";

export interface DesktopExplorerWindowContext {
  serverId?: string;
  ownerId?: string;
  appearance: CodeAppearance;
  explorer: ExplorerSummary;
  path: string;
  projectTitle?: string;
  requestedAtMs: number;
}

export type DesktopExplorerWindowRequest = (
  | { launchId: string; type: "launch.request" }
  | { launchId: string; requestId: string; type: "file.read" }
  | { launchId: string; requestId: string; type: "media.read" }
  | {
      content: string;
      launchId: string;
      requestId: string;
      type: "file.save";
      version: string;
    }
) & { path?: string; requestedAtMs?: number };

export type DesktopExplorerWindowResponse =
  | { type: "context.revoked"; launchId: string; error: string }
  | {
      context: DesktopExplorerWindowContext;
      launchId: string;
      type: "launch.ready";
    }
  | {
      file: ExplorerFile;
      launchId: string;
      requestId: string;
      type: "file.result";
    }
  | { blob: Blob; launchId: string; requestId: string; type: "media.result" }
  | {
      error: string;
      launchId: string;
      requestId: string;
      type: "request.failed";
    };

export function desktopExplorerWindowChannelName(launchId: string): string {
  return `cantrip.explorer-window.v1.${launchId}`;
}

export function desktopExplorerWindowModes(path: string): ExplorerFileMode[] {
  const modes: ExplorerFileMode[] = ["preview"];
  if (structuredFileFormatForPath(path)) modes.push("visual");
  if (!explorerMediaTypeForPath(path)) modes.push("edit");
  return modes;
}

export function desktopExplorerWindowInitialMode(
  path: string,
): ExplorerFileMode {
  return defaultExplorerFileMode(path);
}

export function isDesktopExplorerWindowRequest(
  value: unknown,
): value is DesktopExplorerWindowRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.launchId !== "string") return false;
  if (message.type === "launch.request") return true;
  if (typeof message.requestId !== "string") return false;
  if (message.type === "file.read" || message.type === "media.read")
    return true;
  return (
    message.type === "file.save" &&
    typeof message.content === "string" &&
    typeof message.version === "string"
  );
}

export function isDesktopExplorerWindowResponse(
  value: unknown,
): value is DesktopExplorerWindowResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.launchId !== "string" || typeof message.type !== "string")
    return false;
  if (message.type === "context.revoked")
    return typeof message.error === "string";
  if (message.type === "launch.ready") {
    if (!message.context || typeof message.context !== "object") return false;
    const context = message.context as Record<string, unknown>;
    return (
      typeof context.path === "string" &&
      typeof context.requestedAtMs === "number" &&
      Boolean(context.explorer) &&
      typeof context.explorer === "object"
    );
  }
  if (typeof message.requestId !== "string") return false;
  if (message.type === "request.failed")
    return typeof message.error === "string";
  if (message.type === "media.result") return message.blob instanceof Blob;
  return message.type === "file.result" && typeof message.file === "object";
}
