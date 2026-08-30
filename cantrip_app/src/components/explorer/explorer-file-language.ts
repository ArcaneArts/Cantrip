import {
  explorerTextLanguageForPath,
  type ExplorerFileMode,
} from "@cantrip/protocol";

export function monacoLanguageForPath(path: string): string | null {
  return explorerTextLanguageForPath(path);
}

export function monacoModelPath(explorerId: string, path: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `cantrip://explorer/${encodeURIComponent(explorerId)}/${encodedPath}`;
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
  const language = monacoLanguageForPath(path);
  if (language === "markdown" || language === "mdx") return "preview";
  if (language) return "edit";
  return structuredFileFormatForPath(path) ? "visual" : "preview";
}

export function markdownPreviewUsesPlainText(path: string): boolean {
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  return /^(?:copying|licen[cs]e)(?:[-_.](?:apache|bsd|gpl|lgpl|mit|mpl|v?\d+(?:\.\d+)*))*\.md$/u.test(
    filename,
  );
}

export function usesCantripCodeEditor(
  path: string,
  mode: ExplorerFileMode,
): boolean {
  return mode === "edit" && monacoLanguageForPath(path) !== null;
}
