import { NbtFileViewer } from "@/components/nbt/file-viewer";
import type { ComponentType } from "react";
import {
  explorerMarkdownFileForPath,
  explorerMediaTypeForPath,
  type ExplorerFileMode,
  type CodeAppearance,
  type ExplorerMediaKind,
} from "@cantrip/protocol";
import { isLogFile } from "@/components/editor/log-file";
import { isLicenseFile } from "@/components/editor/license-file";
import type { FileAccess } from "@/lib/file-access";
import type { FileIconKind } from "./file-type";

export type VisualFileFormat =
  "json" | "toml" | "yaml" | "csv" | "env" | "properties";
export interface FileViewerSession {
  readonly revision: number;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly pending: boolean;
  save(): Promise<boolean>;
  /** Explicitly approved discard; must reconcile an uncertain save first. */
  discard(): Promise<void>;
  /** Load and validate the replacement before retiring an approved draft. */
  reload(): Promise<void>;
  /** Flush format-specific durable recovery before a handoff or quit. */
  checkpoint?(): Promise<void>;
}
export interface FileViewerProps {
  path: string;
  explorerId: string;
  documentId?: string;
  projectId: string;
  worktreeId: string;
  workerId: string;
  appearance: CodeAppearance;
  fileAccess?: FileAccess;
  active: boolean;
  revision: number;
  readOnly?: boolean;
  onSessionChange?(session: FileViewerSession | null): void;
  onOpenDocument?(path: string): void | Promise<void>;
  onReady?(): void;
  onError?(error: unknown): void;
}
/** Add a format once here; detection and Open As share the same definition.
 * Custom viewers own their I/O through the protected FileAccess boundary. */
export interface FileViewerDefinition {
  id: string;
  label: string;
  icon: FileIconKind;
  defaultMode: ExplorerFileMode;
  openMode?: ExplorerFileMode;
  matches(path: string): boolean;
  syntaxExtension?: string;
  structuredFormat?: VisualFileFormat;
  media?: { kind: ExplorerMediaKind; mimeType: string };
  Component?: ComponentType<FileViewerProps>;
}
const extension = (path: string) =>
  path.split("/").at(-1)?.toLowerCase().split(".").at(-1);
const structured = (
  id: VisualFileFormat,
  label: string,
  extensions: string[],
): FileViewerDefinition => ({
  id,
  label,
  icon:
    id === "env" || id === "properties"
      ? "config"
      : id === "csv"
        ? "table"
        : id,
  defaultMode: "edit",
  openMode: "visual",
  syntaxExtension: id,
  structuredFormat: id,
  matches: (path) => extensions.includes(extension(path) ?? ""),
});
export const FILE_VIEWERS: readonly FileViewerDefinition[] = [
  {
    id: "nbt",
    label: "NBT",
    icon: "database",
    defaultMode: "preview",
    matches: (path) =>
      ["nbt", "schematic", "litematic", "structure", "mcstructure"].includes(
        extension(path) ?? "",
      ) ||
      /\.nbt\.(?:gz|zlib)$/iu.test(path) ||
      /^(?:level|playerdata)\.dat(?:_old)?$/iu.test(
        path.split("/").at(-1) ?? "",
      ),
    Component: NbtFileViewer,
  },
  {
    id: "image",
    label: "Image",
    icon: "image",
    defaultMode: "preview",
    matches: (path) => explorerMediaTypeForPath(path)?.kind === "image",
    media: { kind: "image", mimeType: "image/png" },
  },
  {
    id: "audio",
    label: "Audio",
    icon: "audio",
    defaultMode: "preview",
    matches: (path) => explorerMediaTypeForPath(path)?.kind === "audio",
    media: { kind: "audio", mimeType: "audio/mpeg" },
  },
  {
    id: "video",
    label: "Video",
    icon: "video",
    defaultMode: "preview",
    matches: (path) => explorerMediaTypeForPath(path)?.kind === "video",
    media: { kind: "video", mimeType: "video/mp4" },
  },
  {
    id: "license",
    label: "License",
    icon: "license",
    defaultMode: "preview",
    matches: isLicenseFile,
  },
  {
    id: "markdown",
    label: "Markdown",
    icon: "markdown",
    defaultMode: "preview",
    syntaxExtension: "md",
    matches: explorerMarkdownFileForPath,
  },
  {
    id: "log",
    label: "Log",
    icon: "text",
    defaultMode: "preview",
    matches: isLogFile,
  },
  structured("json", "JSON", ["json"]),
  structured("toml", "TOML", ["toml"]),
  structured("yaml", "YAML", ["yaml", "yml"]),
  structured("csv", "CSV", ["csv"]),
  structured("env", "Environment variables", ["env"]),
  structured("properties", "Properties", ["properties"]),
  {
    id: "text",
    label: "Text",
    icon: "text",
    defaultMode: "edit",
    syntaxExtension: "txt",
    matches: () => true,
  },
];
export function resolveFileViewer(
  path: string,
  override?: string | null,
  viewers = FILE_VIEWERS,
) {
  const automatic =
    viewers.find((viewer) => viewer.matches(path)) ?? FILE_VIEWERS.at(-1)!;
  const definition = override
    ? viewers.find((viewer) => viewer.id === override)
    : automatic;
  const selected = definition ?? automatic;
  const detectedMedia = explorerMediaTypeForPath(path);
  return {
    definition: selected,
    unavailable: override && !definition ? override : null,
    mode: override
      ? (selected.openMode ?? selected.defaultMode)
      : selected.defaultMode,
    media: selected.media
      ? detectedMedia?.kind === selected.media.kind
        ? detectedMedia
        : selected.media
      : null,
    structuredFormat: selected.structuredFormat ?? null,
    syntaxPath:
      override && selected.syntaxExtension
        ? `viewer.${selected.syntaxExtension}`
        : undefined,
    markdown: selected.id === "markdown",
    license: selected.id === "license",
    log: selected.id === "log",
    custom: selected.Component,
  };
}
