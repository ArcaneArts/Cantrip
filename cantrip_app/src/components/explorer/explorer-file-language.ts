import {
  explorerTextLanguageForPath,
  type ExplorerFileMode,
} from "@cantrip/protocol";
import { resolveFileViewer } from "@/components/files/file-viewers";

export function textLanguageForPath(path: string): string | null {
  return explorerTextLanguageForPath(path);
}

export type { ExplorerFileMode } from "@cantrip/protocol";

export type StructuredFileFormat = "json" | "toml" | "yaml";
export type TabularFileFormat = "csv" | "env" | "properties";
export type VisualFileFormat = StructuredFileFormat | TabularFileFormat;

export function structuredFileFormatForPath(
  path: string,
): VisualFileFormat | null {
  return resolveFileViewer(path).structuredFormat;
}

export function defaultExplorerFileMode(path: string): ExplorerFileMode {
  return resolveFileViewer(path).mode;
}

export function markdownPreviewUsesPlainText(path: string): boolean {
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  return /^(?:copying|licen[cs]e)(?:[-_.](?:apache|bsd|gpl|lgpl|mit|mpl|v?\d+(?:\.\d+)*))*\.md$/u.test(
    filename,
  );
}
