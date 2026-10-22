import type { LanguageCatalog, LanguageDefinition, LanguageId } from "./types";

const extensions: Record<string, LanguageId> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  rs: "rust",
  dart: "dart",
  py: "python",
  pyw: "python",
  go: "go",
  java: "java",
  gradle: "groovy",
  groovy: "groovy",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  rake: "ruby",
  php: "php",
  lua: "lua",
  html: "html",
  htm: "html",
  vue: "html",
  xml: "xml",
  svg: "xml",
  xhtml: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "scss",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  bat: "batch",
  cmd: "batch",
  sql: "sql",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "properties",
  env: "env",
  mk: "makefile",
};

export function languageForFile(path: string, prefix = ""): LanguageId {
  const name =
    path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (/^(?:dockerfile|containerfile)(?:\..*)?$/u.test(name))
    return "dockerfile";
  if (/^(?:gnumakefile|makefile)(?:\..*)?$/u.test(name)) return "makefile";
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if (["gemfile", "rakefile", "podfile"].includes(name)) return "ruby";
  if (name === "cargo.lock") return "toml";
  const extension = extensions[name.split(".").at(-1) ?? ""];
  if (extension) return extension;
  const shebang = prefix.slice(0, 256).split("\n", 1)[0] ?? "";
  if (shebang.startsWith("#!")) {
    if (/\bpython[\d.]*(?:\s|$)/u.test(shebang)) return "python";
    if (/\b(?:node|deno|bun)(?:\s|$)/u.test(shebang)) return "javascript";
    if (/\bruby(?:\s|$)/u.test(shebang)) return "ruby";
    if (/\b(?:ba|z|fi|k)?sh(?:\s|$)/u.test(shebang)) return "shell";
    if (/\blua[\d.]*(?:\s|$)/u.test(shebang)) return "lua";
  }
  return "plain";
}

export function languageForFence(name: string): LanguageId {
  const aliases: Record<string, LanguageId> = {
    js: "javascript",
    ts: "typescript",
    bash: "shell",
    bat: "batch",
    cmd: "batch",
    gradle: "groovy",
    sh: "shell",
    yml: "yaml",
    md: "markdown",
    "c++": "cpp",
    "c#": "csharp",
    csharp: "csharp",
    docker: "dockerfile",
  };
  const lower = name.toLowerCase();
  return (
    aliases[lower] ??
    (Object.values(extensions).includes(lower as LanguageId)
      ? (lower as LanguageId)
      : languageForFile(`file.${lower}`))
  );
}

const loaded: LanguageCatalog = {};
const pending = new Map<string, Promise<void>>();
function groupFor(language: LanguageId): "programming" | "data" {
  return [
    "html",
    "xml",
    "css",
    "scss",
    "json",
    "jsonc",
    "yaml",
    "toml",
    "markdown",
    "shell",
    "batch",
    "sql",
    "dockerfile",
    "makefile",
    "env",
    "ini",
    "properties",
  ].includes(language)
    ? "data"
    : "programming";
}

export async function loadLanguage(
  language: LanguageId,
): Promise<LanguageCatalog> {
  if (language === "plain") return loaded;
  const group = groupFor(language);
  if (!pending.has(group)) {
    const request = (
      group === "programming"
        ? import("./programming-languages")
        : import("./data-languages")
    )
      .then((module) => {
        Object.assign(loaded, module.definitions);
      })
      .catch((error: unknown) => {
        pending.delete(group);
        throw error;
      });
    pending.set(group, request);
  }
  await pending.get(group);
  // Mixed markup and fenced documents can enter either grammar family.
  if (["html", "markdown", "jsx", "tsx"].includes(language)) {
    const other: LanguageId = group === "data" ? "javascript" : "html";
    await loadLanguage(other);
  }
  return loaded;
}

export const plainDefinition: LanguageDefinition = { keywords: new Set() };
