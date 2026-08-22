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
