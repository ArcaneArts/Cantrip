import { z } from "zod";

export const explorerEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string(),
  kind: z.enum(["directory", "file", "other"]),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().datetime(),
  viewable: z.boolean(),
  markdown: z.boolean(),
  symbolicLink: z.boolean().default(false),
});

export const explorerDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(explorerEntrySchema).max(1_000),
  truncated: z.boolean(),
});

export const explorerFileSearchResultSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(8_192),
});

export const explorerFileSearchSchema = z.object({
  query: z.string().trim().min(1).max(200),
  results: z.array(explorerFileSearchResultSchema).max(100),
  truncated: z.boolean(),
});

export const explorerLastCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string().max(10_000),
  authorName: z.string().min(1).max(1_000),
  authorEmail: z.string().max(1_000),
  authoredAt: z.string().datetime({ offset: true }),
});

export const explorerDirectoryCommitEntrySchema = z.object({
  path: explorerEntrySchema.shape.path,
  tracked: z.boolean(),
  lastCommit: explorerLastCommitSchema.nullable(),
});

export const explorerDirectoryCommitsSchema = z.object({
  path: z.string(),
  available: z.boolean(),
  entries: z.array(explorerDirectoryCommitEntrySchema).max(1_000),
});

export const explorerFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  size: z.number().int().nonnegative(),
  markdown: z.boolean(),
  version: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const explorerMediaKindSchema = z.enum(["image", "audio", "video"]);

export const explorerMediaFileSchema = z.object({
  path: z.string().min(1),
  kind: explorerMediaKindSchema,
  mimeType: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
});

export const explorerMediaFileChunkSchema = explorerMediaFileSchema.extend({
  offset: z.number().int().nonnegative(),
  data: z.string().max(400_000),
  eof: z.boolean(),
});

const explorerTextLanguagesByExtension: Readonly<Record<string, string>> = {
  adoc: "plaintext",
  astro: "html",
  bash: "shell",
  bat: "bat",
  c: "cpp",
  cc: "cpp",
  cfg: "ini",
  clj: "clojure",
  cmd: "bat",
  conf: "ini",
  config: "ini",
  cpp: "cpp",
  cs: "csharp",
  csproj: "xml",
  css: "css",
  csv: "plaintext",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  editorconfig: "ini",
  env: "ini",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  fish: "shell",
  fs: "fsharp",
  fsi: "fsharp",
  fsproj: "xml",
  fsx: "fsharp",
  go: "go",
  gradle: "plaintext",
  graphql: "graphql",
  groovy: "groovy",
  h: "cpp",
  hcl: "plaintext",
  hpp: "cpp",
  hrl: "erlang",
  htm: "html",
  html: "html",
  http: "plaintext",
  ignore: "plaintext",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lock: "plaintext",
  log: "plaintext",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  nuspec: "xml",
  patch: "diff",
  php: "php",
  pl: "perl",
  plist: "xml",
  properties: "ini",
  props: "xml",
  proto: "protobuf",
  ps1: "powershell",
  psd1: "powershell",
  psm1: "powershell",
  py: "python",
  r: "r",
  rb: "ruby",
  reg: "plaintext",
  rest: "plaintext",
  resx: "xml",
  rs: "rust",
  rst: "plaintext",
  scala: "scala",
  scss: "scss",
  sh: "shell",
  sln: "plaintext",
  slnx: "xml",
  sol: "sol",
  sql: "sql",
  svelte: "html",
  swift: "swift",
  targets: "xml",
  tex: "latex",
  tf: "plaintext",
  tfvars: "plaintext",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  vb: "vb",
  vbproj: "xml",
  vbs: "vb",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const explorerTextLanguagesByFilename: Readonly<Record<string, string>> = {
  ".babelrc": "json",
  ".dockerignore": "plaintext",
  ".editorconfig": "ini",
  ".eslintrc": "json",
  ".gitattributes": "plaintext",
  ".gitignore": "plaintext",
  ".gitmodules": "ini",
  ".node-version": "plaintext",
  ".npmrc": "ini",
  ".nvmrc": "plaintext",
  ".prettierignore": "plaintext",
  ".prettierrc": "json",
  ".python-version": "plaintext",
  ".tool-versions": "plaintext",
  authors: "plaintext",
  changelog: "plaintext",
  cmakelists: "plaintext",
  "cmakelists.txt": "plaintext",
  copying: "plaintext",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  gradlew: "shell",
  justfile: "plaintext",
  license: "plaintext",
  makefile: "plaintext",
  notice: "plaintext",
  procfile: "plaintext",
  rakefile: "ruby",
  readme: "plaintext",
};

function explorerFilename(filePath: string): string {
  return filePath.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

export function explorerTextLanguageForPath(filePath: string): string | null {
  const filename = explorerFilename(filePath);
  const languageForFilename = explorerTextLanguagesByFilename[filename];
  if (languageForFilename) return languageForFilename;
  const extension = filename.includes(".") ? filename.split(".").at(-1) : null;
  return extension
    ? (explorerTextLanguagesByExtension[extension] ?? null)
    : null;
}

export function explorerTextFileForPath(filePath: string): boolean {
  return explorerTextLanguageForPath(filePath) !== null;
}

export function explorerMarkdownFileForPath(filePath: string): boolean {
  const language = explorerTextLanguageForPath(filePath);
  return language === "markdown" || language === "mdx";
}

const explorerMediaTypesByExtension: Readonly<
  Record<
    string,
    {
      kind: z.infer<typeof explorerMediaKindSchema>;
      mimeType: string;
    }
  >
> = {
  apng: { kind: "image", mimeType: "image/apng" },
  avif: { kind: "image", mimeType: "image/avif" },
  bmp: { kind: "image", mimeType: "image/bmp" },
  gif: { kind: "image", mimeType: "image/gif" },
  ico: { kind: "image", mimeType: "image/x-icon" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  png: { kind: "image", mimeType: "image/png" },
  svg: { kind: "image", mimeType: "image/svg+xml" },
  webp: { kind: "image", mimeType: "image/webp" },
  aac: { kind: "audio", mimeType: "audio/aac" },
  flac: { kind: "audio", mimeType: "audio/flac" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  oga: { kind: "audio", mimeType: "audio/ogg" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  opus: { kind: "audio", mimeType: "audio/ogg" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  weba: { kind: "audio", mimeType: "audio/webm" },
  m4v: { kind: "video", mimeType: "video/mp4" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  ogv: { kind: "video", mimeType: "video/ogg" },
  webm: { kind: "video", mimeType: "video/webm" },
};

export function explorerMediaTypeForPath(
  filePath: string,
): Pick<z.infer<typeof explorerMediaFileSchema>, "kind" | "mimeType"> | null {
  const filename = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = filename.includes(".") ? filename.split(".").at(-1) : null;
  return extension ? (explorerMediaTypesByExtension[extension] ?? null) : null;
}

export const explorerFileWriteSchema = z.object({
  path: z.string().min(1).max(8_192),
  content: z.string().max(2 * 1024 * 1024),
  version: explorerFileSchema.shape.version,
});

export const explorerEntryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "Expected a single file or folder name.",
  );

export const explorerEntryRenameSchema = z
  .object({
    path: explorerFileWriteSchema.shape.path,
    name: explorerEntryNameSchema,
  })
  .strict();

export const explorerDirectoryCreateSchema = z
  .object({
    path: z.string().max(8_192),
  })
  .strict();

export const explorerEntryDeleteSchema = z
  .object({ path: explorerFileWriteSchema.shape.path })
  .strict();

export const explorerEntryMutationResultSchema = z
  .object({
    path: explorerFileWriteSchema.shape.path,
    newPath: explorerFileWriteSchema.shape.path.nullable(),
  })
  .strict();

export type ExplorerEntry = z.infer<typeof explorerEntrySchema>;
export type ExplorerEntryName = z.infer<typeof explorerEntryNameSchema>;
export type ExplorerDirectoryCreate = z.infer<
  typeof explorerDirectoryCreateSchema
>;
export type ExplorerEntryRename = z.infer<typeof explorerEntryRenameSchema>;
export type ExplorerEntryDelete = z.infer<typeof explorerEntryDeleteSchema>;
export type ExplorerEntryMutationResult = z.infer<
  typeof explorerEntryMutationResultSchema
>;
export type ExplorerDirectory = z.infer<typeof explorerDirectorySchema>;
export type ExplorerFileSearch = z.infer<typeof explorerFileSearchSchema>;
export type ExplorerFileSearchResult = z.infer<
  typeof explorerFileSearchResultSchema
>;
export type ExplorerLastCommit = z.infer<typeof explorerLastCommitSchema>;
export type ExplorerDirectoryCommitEntry = z.infer<
  typeof explorerDirectoryCommitEntrySchema
>;
export type ExplorerDirectoryCommits = z.infer<
  typeof explorerDirectoryCommitsSchema
>;
export type ExplorerFile = z.infer<typeof explorerFileSchema>;
export type ExplorerMediaKind = z.infer<typeof explorerMediaKindSchema>;
export type ExplorerMediaFile = z.infer<typeof explorerMediaFileSchema>;
export type ExplorerMediaFileChunk = z.infer<
  typeof explorerMediaFileChunkSchema
>;
export type ExplorerFileWrite = z.infer<typeof explorerFileWriteSchema>;
