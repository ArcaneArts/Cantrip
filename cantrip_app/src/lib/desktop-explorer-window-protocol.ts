import type {
  CodeAppearance,
  CodeAttachment,
  ExplorerFile,
  ExplorerFileMode,
  ExplorerSummary,
} from "@cantrip/protocol";

import {
  defaultExplorerFileMode,
  monacoLanguageForPath,
  structuredFileFormatForPath,
} from "@/components/explorer/explorer-file-language";

export const desktopExplorerWindowLaunchParameter = "cantrip-explorer-launch";

export interface DesktopExplorerWindowContext {
  appearance: CodeAppearance;
  explorer: ExplorerSummary;
  path: string;
  projectTitle?: string;
  requestedAtMs: number;
}

export type DesktopExplorerWindowRequest =
  | { launchId: string; type: "launch.request" }
  | { launchId: string; nonce: string; type: "editor.workbench-mounted" }
  | { launchId: string; nonce: string; type: "editor.workbench-ready" }
  | {
      error: string;
      launchId: string;
      nonce: string;
      stage: "frame" | "workbench";
      type: "editor.workbench-failed";
    }
  | { launchId: string; requestId: string; type: "file.read" }
  | { launchId: string; requestId: string; type: "media.read" }
  | {
      content: string;
      launchId: string;
      requestId: string;
      type: "file.save";
      version: string;
    };

export type DesktopExplorerWindowResponse =
  | {
      context: DesktopExplorerWindowContext;
      launchId: string;
      type: "launch.ready";
    }
  | {
      attachment: CodeAttachment;
      launchId: string;
      preparedAtMs: number;
      type: "editor.endpoint-ready";
    }
  | {
      configuredAtMs: number;
      launchId: string;
      nonce: string;
      path: string;
      requestedAtMs: number;
      type: "editor.ready";
    }
  | {
      error: string;
      launchId: string;
      stage: "endpoint" | "file" | "frame" | "presentation" | "workbench";
      type: "editor.failed";
    }
  | {
      file: ExplorerFile;
      launchId: string;
      requestId: string;
      type: "file.result";
    }
  | {
      blob: Blob;
      launchId: string;
      requestId: string;
      type: "media.result";
    }
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
  if (monacoLanguageForPath(path)) modes.push("edit");
  return modes;
}

export function desktopExplorerWindowInitialMode(
  path: string,
): ExplorerFileMode {
  const preferred = defaultExplorerFileMode(path);
  return desktopExplorerWindowModes(path).includes(preferred)
    ? preferred
    : "preview";
}

export function isDesktopExplorerWindowRequest(
  value: unknown,
): value is DesktopExplorerWindowRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.launchId !== "string") return false;
  if (message.type === "launch.request") return true;
  if (
    message.type === "editor.workbench-mounted" ||
    message.type === "editor.workbench-ready"
  ) {
    return typeof message.nonce === "string";
  }
  if (message.type === "editor.workbench-failed") {
    return (
      typeof message.nonce === "string" &&
      typeof message.error === "string" &&
      (message.stage === "frame" || message.stage === "workbench")
    );
  }
  if (
    (message.type === "file.read" || message.type === "media.read") &&
    typeof message.requestId === "string"
  ) {
    return true;
  }
  return (
    message.type === "file.save" &&
    typeof message.requestId === "string" &&
    typeof message.content === "string" &&
    typeof message.version === "string"
  );
}

export function isDesktopExplorerWindowResponse(
  value: unknown,
): value is DesktopExplorerWindowResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (
    typeof message.launchId !== "string" ||
    typeof message.type !== "string"
  ) {
    return false;
  }
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
  if (message.type === "editor.endpoint-ready") {
    return (
      Boolean(message.attachment) &&
      typeof message.attachment === "object" &&
      typeof message.preparedAtMs === "number"
    );
  }
  if (message.type === "editor.ready") {
    return (
      typeof message.configuredAtMs === "number" &&
      typeof message.nonce === "string" &&
      typeof message.path === "string" &&
      typeof message.requestedAtMs === "number"
    );
  }
  if (message.type === "editor.failed") {
    return (
      typeof message.error === "string" &&
      ["endpoint", "file", "frame", "presentation", "workbench"].includes(
        String(message.stage),
      )
    );
  }
  if (typeof message.requestId !== "string") return false;
  if (message.type === "request.failed") {
    return typeof message.error === "string";
  }
  if (message.type === "media.result") return message.blob instanceof Blob;
  return message.type === "file.result" && typeof message.file === "object";
}
