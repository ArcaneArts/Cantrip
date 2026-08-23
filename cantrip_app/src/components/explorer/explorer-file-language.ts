const languageByExtension: Record<string, string> = {
  bat: "bat",
  c: "cpp",
  cc: "cpp",
  conf: "ini",
  config: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "plaintext",
  dart: "dart",
  env: "ini",
  go: "go",
  gradle: "plaintext",
  graphql: "graphql",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  ignore: "plaintext",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  log: "plaintext",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  properties: "ini",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sol: "sol",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const languageByFilename: Record<string, string> = {
  ".dockerignore": "plaintext",
  ".editorconfig": "ini",
  ".gitattributes": "plaintext",
  ".gitignore": "plaintext",
  ".npmrc": "ini",
  dockerfile: "dockerfile",
  gradlew: "shell",
  license: "plaintext",
  makefile: "plaintext",
  readme: "plaintext",
};

export function monacoLanguageForPath(path: string): string | null {
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  const languageForFilename = languageByFilename[filename];
  if (languageForFilename) return languageForFilename;
  const extension = filename.includes(".") ? filename.split(".").at(-1) : null;
  return extension ? (languageByExtension[extension] ?? null) : null;
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
import type { ExplorerFileMode } from "@cantrip/protocol";
