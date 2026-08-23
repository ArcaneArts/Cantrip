import type {
  CodeAppearance,
  CodeAttachment,
  ExplorerFile,
  ExplorerFileMode,
  ExplorerSummary,
} from "@cantrip/protocol";

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
      type: "editor.ready";
    }
  | {
      error: string;
      launchId: string;
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
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = filename.split(".").at(-1);
  const visual =
    filename === ".env" ||
    extension === "env" ||
    extension === "json" ||
    extension === "toml" ||
    extension === "yaml" ||
    extension === "yml" ||
    extension === "csv" ||
    extension === "properties";
  return visual ? ["preview", "visual", "edit"] : ["preview", "edit"];
}

export function isDesktopExplorerWindowRequest(
  value: unknown,
): value is DesktopExplorerWindowRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.launchId !== "string") return false;
  if (message.type === "launch.request") return true;
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
  if (message.type === "editor.ready") {
    return (
      Boolean(message.attachment) &&
      typeof message.attachment === "object" &&
      typeof message.preparedAtMs === "number"
    );
  }
  if (message.type === "editor.failed") {
    return typeof message.error === "string";
  }
  if (typeof message.requestId !== "string") return false;
  if (message.type === "request.failed") {
    return typeof message.error === "string";
  }
  if (message.type === "media.result") return message.blob instanceof Blob;
  return message.type === "file.result" && typeof message.file === "object";
}
