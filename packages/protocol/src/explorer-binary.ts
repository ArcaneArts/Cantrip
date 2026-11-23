import { z } from "zod";

export const BINARY_FILE_PAGE_BYTES = 256 * 1024;
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const binaryFileVersionSchema = z
  .string()
  .regex(/^binary-v1:[a-f0-9]{64}$/u);
export const explorerBinaryReadSchema = z
  .object({
    path: z.string().min(1).max(8192),
    offset,
    limit: z.number().int().min(1).max(BINARY_FILE_PAGE_BYTES),
    version: binaryFileVersionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.offset > 0 && !value.version)
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "A binary range requires its snapshot version.",
      });
  });
export const explorerBinaryPageSchema = z
  .object({
    path: z.string().min(1).max(8192),
    size: offset,
    offset,
    nextOffset: offset,
    eof: z.boolean(),
    version: binaryFileVersionSchema,
    data: z
      .string()
      .max(Math.ceil(BINARY_FILE_PAGE_BYTES / 3) * 4)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
  })
  .strict()
  .superRefine((page, context) => {
    const bytes =
      (page.data.length / 4) * 3 -
      (page.data.endsWith("==") ? 2 : page.data.endsWith("=") ? 1 : 0);
    if (
      page.offset > page.size ||
      page.nextOffset < page.offset ||
      page.nextOffset > page.size ||
      page.nextOffset - page.offset !== bytes ||
      bytes > BINARY_FILE_PAGE_BYTES ||
      page.eof !== (page.nextOffset === page.size) ||
      (!page.eof && bytes === 0)
    )
      context.addIssue({
        code: "custom",
        message: "Binary page bounds do not match its content.",
      });
  });
export type ExplorerBinaryPage = z.infer<typeof explorerBinaryPageSchema>;
