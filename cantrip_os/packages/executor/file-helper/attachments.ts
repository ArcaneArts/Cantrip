import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { safeAttachmentFileName } from "../../../../cantrip_worker/src/attachment-paths.js";
import {
  osAttachmentReceiptSchema,
  type OsFileRequest,
} from "../../../../cantrip_worker/src/os-executor/file-requests.js";

export async function verifyAttachment(receipt: unknown) {
  const value = osAttachmentReceiptSchema.parse(receipt);
  const metadata = await stat(value.path);
  if (!metadata.isFile() || metadata.size !== value.sizeBytes)
    throw new Error("The materialized Linux attachment changed.");
  const bytes = await readFile(value.path);
  try {
    if (createHash("sha256").update(bytes).digest("hex") !== value.sha256)
      throw new Error("The materialized Linux attachment changed.");
  } finally {
    bytes.fill(0);
  }
  return value;
}
export async function materializeAttachment(
  home: string,
  request: Extract<OsFileRequest, { type: "chat.attachment.materialize" }>,
) {
  if (safeAttachmentFileName(request.fileName) !== request.fileName)
    throw new Error("Invalid Linux attachment file name.");
  const directory = path.join(
    home,
    ".local/share/cantrip-os-executor/attachments",
    request.chatId,
    request.attachmentId,
    request.sha256,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalHome = await realpath(home),
    canonicalDirectory = await realpath(directory);
  if (!canonicalDirectory.startsWith(canonicalHome + path.sep))
    throw new Error(
      "The Linux attachment directory escaped its workspace home.",
    );
  const target = path.join(canonicalDirectory, request.fileName);
  const bytes = Buffer.from(request.dataBase64, "base64");
  try {
    if (
      bytes.length !== request.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== request.sha256
    )
      throw new Error("Linux attachment content verification failed.");
    let file;
    try {
      file = await open(
        target,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o400,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (file) {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const parent = await open(canonicalDirectory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    return await verifyAttachment({
      path: target,
      sha256: request.sha256,
      sizeBytes: request.sizeBytes,
    });
  } finally {
    bytes.fill(0);
  }
}
