import { FileOperationError } from "@/lib/file-operation-error";
import type {
  NbtDocumentClient,
  NbtSerializationReceipt,
} from "@cantrip/nbt/document";
import {
  BINARY_WRITE_CHUNK_BYTES,
  type BinaryWriteReceipt,
  type BinaryWriteRequest,
} from "@cantrip/protocol/surface-stream";
export type NbtBinaryTransport = (
  request: BinaryWriteRequest,
  signal?: AbortSignal,
) => Promise<BinaryWriteReceipt>;
export interface NbtSaveProgress {
  phase:
    | "idle"
    | "preparing"
    | "uploading"
    | "committing"
    | "interrupted"
    | "uncertain"
    | "conflict"
    | "saved";
  uploaded: number;
  error?: string;
}
interface Pending {
  id: string;
  version: string;
  revision: number;
  metadata?: NbtSerializationReceipt;
  commitAttempted: boolean;
  recovered?: boolean;
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
/** A failed acknowledgement never clears a draft. Retry reconciles the same frozen save/upload ID. */
export class NbtSaveController {
  private pending: Pending | undefined;
  private active: Promise<BinaryWriteReceipt> | undefined;
  private lastProgress = 0;
  constructor(
    private client: NbtDocumentClient,
    private path: string,
    private transport: NbtBinaryTransport,
    private progress: (value: NbtSaveProgress) => void = () => {},
    private options: { copy?: boolean } = {},
  ) {}
  private notify(value: NbtSaveProgress, force = false) {
    const now = performance.now();
    if (force || now - this.lastProgress >= 100) {
      this.lastProgress = now;
      this.progress(value);
    }
  }
  save(signal = new AbortController().signal) {
    if (this.active) return this.active;
    const operation = this.run(signal);
    this.active = operation;
    void operation
      .finally(() => {
        if (this.active === operation) this.active = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private async command(content: BinaryWriteRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await this.transport(content, signal);
    if (result.uploadId !== content.uploadId || result.path !== this.path)
      throw new Error("The binary save returned another document's receipt.");
    return result;
  }
  private async accepted(receipt: BinaryWriteReceipt, pending: Pending) {
    if (
      receipt.state !== "committed" ||
      !pending.metadata ||
      receipt.sha256 !== pending.metadata.sha256 ||
      receipt.size !== pending.metadata.size ||
      !receipt.version
    )
      throw new Error(
        "The committed receipt does not match this saved snapshot.",
      );
    if (this.options.copy) await this.client.failSave(pending.id, false);
    else await this.client.acknowledgeSave(pending.id, receipt.version);
    if (this.pending === pending) this.pending = undefined;
    this.notify({ phase: "saved", uploaded: receipt.size }, true);
    return receipt;
  }
  private async status(pending: Pending, signal?: AbortSignal) {
    return this.command(
      {
        type: "explorer.binary.write.status",
        path: this.path,
        uploadId: pending.id,
      },
      signal,
    );
  }
  private adoptRetained() {
    if (this.pending) return;
    const retained = this.client.getEditSnapshot()?.pendingSave;
    if (!retained) return;
    if (
      retained.target?.path !== this.path ||
      retained.target.copy !== Boolean(this.options.copy)
    )
      return;
    this.pending = {
      id: retained.id,
      version: retained.version,
      revision: retained.revision,
      metadata: retained.metadata,
      commitAttempted: Boolean(retained.metadata),
      recovered: true,
    };
  }
  private async run(signal: AbortSignal): Promise<BinaryWriteReceipt> {
    let pending = this.pending,
      uploaded = 0;
    try {
      if (!pending) {
        const retained = this.client.getEditSnapshot()?.pendingSave,
          id = retained?.id ?? crypto.randomUUID(),
          snapshot = await this.client.beginSave(id, signal, {
            path: this.path,
            copy: Boolean(this.options.copy),
          });
        pending = {
          id,
          version: snapshot.version,
          revision: snapshot.revision,
          metadata: snapshot.metadata,
          commitAttempted: Boolean(snapshot.metadata),
          recovered: Boolean(retained),
        };
        this.pending = pending;
      } else await this.client.beginSave(pending.id, signal);
      let receipt = await this.status(pending, signal);
      if (receipt.state === "committed")
        return await this.accepted(receipt, pending);
      if (receipt.state === "conflict" || receipt.state === "aborted")
        throw new NbtSaveConflict(
          receipt.error ??
            "This upload cannot be committed. Keep the draft and choose Reload or Save As.",
        );
      if (receipt.state === "prepared")
        throw new Error("The worker has not finished reconciling this save.");
      if (pending.recovered && !pending.metadata) {
        // Publication is only requested after save.ready is durable. A crash
        // before that record can leave a partial compressed upload whose bytes
        // need not be identical in another browser engine. Abort it and start
        // a fresh upload of the recovered draft instead of trusting its prefix.
        const cancelled = await this.command(
          {
            type: "explorer.binary.write.abort",
            path: this.path,
            uploadId: pending.id,
          },
          signal,
        );
        if (cancelled.state !== "aborted")
          throw new Error(
            "The interrupted NBT upload could not be reconciled.",
          );
        await this.client.failSave(pending.id, false);
        this.pending = undefined;
        return await this.run(signal);
      }
      if (receipt.state === "unknown") {
        if (pending.commitAttempted)
          throw new Error(
            "The save receipt is unavailable. The draft has been retained.",
          );
        receipt = await this.command(
          {
            type: "explorer.binary.write.begin",
            path: this.path,
            uploadId: pending.id,
            version: this.options.copy ? null : pending.version,
          },
          signal,
        );
      }
      if (receipt.state !== "uploading")
        throw new Error("The worker did not open the binary upload.");
      uploaded = receipt.offset;
      this.notify({ phase: "uploading", uploaded }, true);
      if (!pending.commitAttempted) {
        let offset = 0,
          buffer = new Uint8Array(BINARY_WRITE_CHUNK_BYTES),
          used = 0;
        const send = async (final: boolean) => {
          signal.throwIfAborted();
          if (
            offset + used > uploaded ||
            (final && used === 0 && offset === uploaded)
          ) {
            if (offset !== uploaded)
              throw new Error(
                "The worker's uploaded prefix does not match a serialized page.",
              );
            const receipt = await this.command(
              {
                type: "explorer.binary.write.chunk",
                path: this.path,
                uploadId: pending!.id,
                offset,
                data: base64(buffer.subarray(0, used)),
                final,
              },
              signal,
            );
            if (
              receipt.state !== "uploading" ||
              receipt.offset !== offset + used
            )
              throw new Error(
                "The worker acknowledged a different upload prefix.",
              );
            uploaded = receipt.offset;
            this.notify({ phase: "uploading", uploaded });
          }
          offset += used;
          buffer.fill(0);
          used = 0;
        };
        const stream = this.client.serialize(false, signal, pending.id);
        try {
          for (;;) {
            const part = await stream.next();
            if (part.done) {
              pending.metadata = part.value;
              break;
            }
            const bytes = part.value;
            try {
              let at = 0;
              while (at < bytes.length) {
                if (used === buffer.length) await send(false);
                const count = Math.min(bytes.length - at, buffer.length - used);
                buffer.set(bytes.subarray(at, at + count), used);
                used += count;
                at += count;
              }
            } finally {
              bytes.fill(0);
            }
          }
          await send(true);
        } finally {
          buffer.fill(0);
          await stream.return({ size: 0, sha256: "" }).catch(() => {});
        }
        if (offset !== pending.metadata!.size)
          throw new Error("Serialized size does not match the upload.");
        await this.client.prepareSave(pending.id, pending.metadata!);
      } else if (!pending.metadata || uploaded !== pending.metadata.size) {
        throw new Error(
          "The recovered NBT upload does not match its durable serialized receipt.",
        );
      }
      pending.commitAttempted = true;
      this.notify({ phase: "committing", uploaded }, true);
      receipt = await this.command(
        {
          type: "explorer.binary.write.commit",
          path: this.path,
          uploadId: pending.id,
          ...pending.metadata!,
        },
        signal,
      );
      if (receipt.state === "conflict")
        throw new NbtSaveConflict(
          receipt.error ??
            "The file changed on disk. The draft has been retained.",
        );
      return await this.accepted(receipt, pending);
    } catch (error) {
      if (
        error instanceof FileOperationError &&
        error.code === "file-version-changed"
      )
        error = new NbtSaveConflict(error.message);
      const message =
        error instanceof Error ? error.message : "NBT save failed.";
      if (pending) {
        if (pending.commitAttempted) {
          try {
            const receipt = await this.status(
              pending,
              AbortSignal.timeout(15000),
            );
            if (receipt.state === "committed")
              return await this.accepted(receipt, pending);
            if (receipt.state === "conflict" || receipt.state === "aborted")
              error = new NbtSaveConflict(receipt.error ?? message);
          } catch {}
        }
        const conflict = error instanceof NbtSaveConflict;
        await this.client
          .failSave(pending.id, pending.commitAttempted && !conflict, !conflict)
          .catch(() => {});
        if (conflict) this.pending = undefined;
        this.notify(
          {
            phase: conflict
              ? "conflict"
              : pending.commitAttempted
                ? "uncertain"
                : "interrupted",
            uploaded,
            error: error instanceof Error ? error.message : message,
          },
          true,
        );
      } else
        this.notify({ phase: "interrupted", uploaded, error: message }, true);
      throw error;
    }
  }
  async abandon() {
    if (this.active)
      throw new Error("Wait for the active save before abandoning its upload.");
    this.adoptRetained();
    const pending = this.pending;
    if (!pending) return;
    const receipt = await this.status(pending, AbortSignal.timeout(15000));
    if (receipt.state === "committed") {
      await this.accepted(receipt, pending);
      return;
    }
    const cancelled = await this.command({
      type: "explorer.binary.write.abort",
      path: this.path,
      uploadId: pending.id,
    });
    if (cancelled.state === "committed") {
      await this.accepted(cancelled, pending);
      return;
    }
    if (cancelled.state !== "aborted")
      throw new Error("The worker could not confirm upload cancellation.");
    await this.client.failSave(pending.id, false);
    this.pending = undefined;
  }
}
export class NbtSaveConflict extends Error {}
