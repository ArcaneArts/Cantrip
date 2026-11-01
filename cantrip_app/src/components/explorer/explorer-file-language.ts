import {
  explorerTextLanguageForPath,
  explorerMarkdownFileForPath,
  explorerMediaTypeForPath,
  type ExplorerFileMode,
} from "@cantrip/protocol";
import { isLogFile } from "@/components/editor/log-file";
import { isLicenseFile } from "@/components/editor/license-file";

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
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = filename.split(".").at(-1);
  if (extension === "json" || extension === "toml") return extension;
  if (extension === "yaml" || extension === "yml") return "yaml";
  if (extension === "csv" || extension === "properties") return extension;
  return filename === ".env" || extension === "env" ? "env" : null;
}

export function defaultExplorerFileMode(path: string): ExplorerFileMode {
  return explorerMediaTypeForPath(path) ||
    explorerMarkdownFileForPath(path) ||
    isLicenseFile(path) ||
    isLogFile(path)
    ? "preview"
    : "edit";
}

export function markdownPreviewUsesPlainText(path: string): boolean {
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  return /^(?:copying|licen[cs]e)(?:[-_.](?:apache|bsd|gpl|lgpl|mit|mpl|v?\d+(?:\.\d+)*))*\.md$/u.test(
    filename,
  );
}
