import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { NbtDocumentSession, serializeNbtEdits } from "../edit/index.js";
import { NbtDocumentSearch } from "../search/search.js";
import { nbtTreePage, nbtAncestors } from "../view/tree.js";
import { nbtTablePage } from "../view/table.js";
import { blobNbtSource } from "../source.js";
import { assertRange, NbtError, type NbtByteSource } from "../types.js";
import { NbtDocumentEngine, nbtDocumentError } from "./engine.js";
import type {
  NbtDocumentRequest,
  NbtDocumentResponse,
  NbtMessageEndpoint,
} from "./types.js";

/** Install once in a dedicated worker. Source replies bypass long-running document commands. */
export function installNbtDocumentWorker(
  endpoint: NbtMessageEndpoint<NbtDocumentRequest, NbtDocumentResponse>,
) {
  let session: NbtDocumentSession | undefined;
  let search: NbtDocumentSearch | undefined;
  let engine: NbtDocumentEngine | undefined,
    opening = false,
    sourceSequence = 0,
    closed = false;
  let serialization:
    | {
        id: string;
        iterator: AsyncGenerator<Uint8Array>;
        controller: AbortController;
        busy: boolean;
        hash: ReturnType<typeof sha256.create>;
        size: number;
        request?: number;
      }
    | undefined;
  const requests = new Map<number, AbortController>();
  const reads = new Map<
    number,
    {
      resolve: (bytes: Uint8Array) => void;
      reject: (error: unknown) => void;
      cleanup: () => void;
      limit: number;
    }
  >();
  const send = (message: NbtDocumentResponse, transfer?: Transferable[]) =>
    endpoint.postMessage(message, transfer);
  function remoteSource(size: number): NbtByteSource {
    assertRange(size, 0);
    return {
      size,
      read(offset, length, signal) {
        assertRange(offset, length);
        signal?.throwIfAborted();
        if (length > 256 * 1024)
          throw new NbtError(offset, "Source ranges are limited to 256 KiB");
        if (closed)
          return Promise.reject(new NbtError(0, "NBT worker is closed"));
        if (reads.size >= 16)
          return Promise.reject(
            new NbtError(0, "NBT source read concurrency exceeded"),
          );
        return new Promise<Uint8Array>((resolve, reject) => {
          const id = ++sourceSequence;
          const abort = () => {
            reads.delete(id);
            signal?.removeEventListener("abort", abort);
            send({ type: "source.cancel", id });
            reject(signal?.reason);
          };
          reads.set(id, {
            resolve,
            reject,
            limit: length,
            cleanup: () => signal?.removeEventListener("abort", abort),
          });
          signal?.addEventListener("abort", abort, { once: true });
          send({ type: "source.read", id, offset, length });
        });
      },
    };
  }
  const listener = (event: MessageEvent<NbtDocumentRequest>) => {
    const message = event.data;
    if (message.type === "source.result") {
      const pending = reads.get(message.id);
      if (!pending) {
        message.bytes?.fill(0);
        return;
      }
      reads.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(new Error(message.error));
      else if (
        !(message.bytes instanceof Uint8Array) ||
        message.bytes.length > pending.limit
      )
        pending.reject(new NbtError(0, "Invalid source byte reply"));
      else pending.resolve(message.bytes);
      return;
    }
    if (message.type === "cancel") {
      requests.get(message.id)?.abort(new Error("NBT request cancelled."));
      if (serialization?.request === message.id)
        serialization.controller.abort(new Error("NBT export cancelled."));
      return;
    }
    const id = message.id;
    if (!Number.isSafeInteger(id) || id < 0 || requests.has(id)) return;
    if (
      requests.size >= 64 &&
      !["close", "pause", "serialize.cancel", "search.cancel"].includes(
        message.command.type,
      )
    ) {
      send({
        type: "result",
        id,
        value: null,
        error: { message: "NBT request queue is full." },
      });
      return;
    }
    const controller = new AbortController();
    requests.set(id, controller);
    void (async () => {
      let value: unknown, transfer: Transferable[] | undefined;
      const command = message.command;
      if (command.type === "open") {
        if (engine || opening || closed)
          throw new Error("NBT worker already opened a document.");
        opening = true;
        try {
          const source =
            command.input.kind === "blob"
              ? blobNbtSource(command.input.blob)
              : remoteSource(command.input.size);
          engine = await NbtDocumentEngine.open(
            source,
            command.options,
            (status) => send({ type: "status", status }),
          );
          if (controller.signal.aborted) {
            await engine.close();
            throw controller.signal.reason;
          }
          session = await NbtDocumentSession.open(
            engine,
            command.options.version ?? "local",
            (status) => {
              send({ type: "edit.status", status });
              send({
                type: "status",
                status: {
                  ...session!.view().snapshot(),
                  revision: status.revision,
                },
              });
            },
          );
          if (controller.signal.aborted || closed) {
            await session.close();
            await engine.close();
            throw (
              controller.signal.reason ??
              new Error("NBT worker closed while opening")
            );
          }
          send({ type: "edit.status", status: session.snapshot() });
          search = new NbtDocumentSearch(
            () => session!.view(),
            engine.binding,
            (status) => send({ type: "search.status", status }),
          );
          value = engine.snapshot();
        } finally {
          opening = false;
        }
      } else {
        if (!engine) throw new Error("NBT worker has no open document.");
        const model = session?.view() ?? engine;
        switch (command.type) {
          case "rows": {
            assertRange(command.offset, command.limit);
            if (command.limit > 128)
              throw new NbtError(0, "Display pages are limited to 128 rows");
            const nodes =
              command.parent === null
                ? command.offset === 0 && command.limit && model.snapshot().root
                  ? [await model.getNode(model.snapshot().root!)]
                  : []
                : await model.getChildren(
                    command.parent,
                    command.offset,
                    command.limit,
                  );
            value = await Promise.all(
              nodes
                .filter((node) => node !== undefined)
                .map((node) => model.describe(node!, controller.signal)),
            );
            break;
          }
          case "node": {
            const node = await model.getNode(command.id);
            if (!node) throw new NbtError(0, "Indexed node is unavailable");
            value = await model.describe(node, controller.signal);
            break;
          }
          case "ancestors":
            value = await nbtAncestors(model, command.id, controller.signal);
            break;
          case "tree":
            value = await nbtTreePage(
              model,
              command.expanded,
              command.offset,
              command.limit,
              command.anchor,
              controller.signal,
            );
            break;
          case "table":
            value = await nbtTablePage(
              model,
              command.id,
              command.offset,
              command.limit,
              command.columnOffset,
              command.columnLimit,
              command.referenceOrdinal,
              command.reverse,
              controller.signal,
            );
            break;
          case "search.start":
            value = search!.start(command.id, command.query);
            break;
          case "search.page":
            value = await search!.results(
              command.id,
              command.offset,
              command.limit,
              controller.signal,
            );
            break;
          case "search.cancel":
            await search!.cancel(command.id);
            value = null;
            break;
          case "array":
            value = await model.array(
              command.id,
              command.offset,
              command.limit,
              controller.signal,
            );
            break;
          case "edit.apply":
            value = await session!.apply(
              command.operations,
              command.revision,
              controller.signal,
              command.label,
            );
            break;
          case "edit.undo":
            value = await session!.undo(controller.signal);
            break;
          case "edit.redo":
            value = await session!.redo(controller.signal);
            break;
          case "edit.text": {
            assertRange(command.offset, command.limit);
            if (command.limit < 4 || command.limit > 65535)
              throw new NbtError(0, "Text edit pages require 4–65535 bytes");
            const node = await model.getNode(command.id),
              span =
                command.field === "name"
                  ? node?.name
                  : node?.type === 8
                    ? node.data
                    : undefined;
            if (!span) throw new NbtError(0, "Tag has no requested text field");
            if (command.offset > span.length)
              throw new NbtError(0, "Text page is beyond the field");
            const page = await model.text(
              {
                ...span,
                offset: span.offset + command.offset,
                length: span.length - command.offset,
              },
              command.limit,
              controller.signal,
            );
            value = {
              text: page.text,
              offset: command.offset,
              nextOffset: page.nextByte - span.offset,
              totalBytes: span.length,
              truncated: page.truncated,
            };
            break;
          }
          case "save.begin":
            value = await session!.beginSave(command.saveId, controller.signal);
            break;
          case "save.ack":
            value = await session!.acknowledgeSave(
              command.saveId,
              command.version,
            );
            break;
          case "save.fail":
            value = await session!.failSave(
              command.saveId,
              command.uncertain,
              command.retain,
            );
            break;
          case "pause":
            engine.setPaused(command.paused);
            value = engine.snapshot();
            break;
          case "serialize.begin": {
            if (serialization) throw new Error("NBT export already started.");
            const exportController = new AbortController();
            serialization = {
              id: command.exportId,
              iterator:
                command.original &&
                model === engine &&
                session!.canExportOriginal &&
                !command.saveId
                  ? engine.serialize(true, exportController.signal)
                  : (async function* () {
                      const selected = command.saveId
                          ? session!.saveView(command.saveId)
                          : model,
                        result = await engine!.completed;
                      yield* serializeNbtEdits(selected, engine!.format, {
                        signal: exportController.signal,
                        levelVersion: result.levelVersion,
                      });
                    })(),
              controller: exportController,
              busy: false,
              hash: sha256.create(),
              size: 0,
            };
            value = null;
            break;
          }
          case "serialize.next": {
            const current = serialization;
            if (!current || current.id !== command.exportId || current.busy)
              throw new Error("NBT export is unavailable or busy.");
            current.busy = true;
            current.request = id;
            try {
              const result = await current.iterator.next();
              if (result.done) {
                if (serialization === current) serialization = undefined;
                value = {
                  done: true,
                  size: current.size,
                  sha256: bytesToHex(current.hash.digest()),
                };
              } else {
                const bytes = result.value.slice();
                current.hash.update(bytes);
                current.size += bytes.length;
                value = { done: false, bytes };
                transfer = [bytes.buffer];
              }
            } catch (error) {
              current.controller.abort(error);
              current.hash.destroy();
              if (serialization === current) serialization = undefined;
              throw error;
            } finally {
              current.busy = false;
              current.request = undefined;
            }
            break;
          }
          case "serialize.cancel": {
            const current = serialization;
            if (current?.id === command.exportId) {
              current.controller.abort(new Error("NBT export cancelled."));
              await current.iterator.return(undefined);
              current.hash.destroy();
              if (serialization === current) serialization = undefined;
            }
            value = null;
            break;
          }
          case "close":
            for (const [requestId, request] of requests)
              if (requestId !== id)
                request.abort(new Error("NBT document is closed."));
            serialization?.controller.abort(
              new Error("NBT document is closed."),
            );
            await search?.close();
            await session?.close();
            await engine.close();
            await serialization?.iterator.return(undefined);
            serialization?.hash.destroy();
            serialization = undefined;
            closed = true;
            value = null;
            break;
        }
      }
      controller.signal.throwIfAborted();
      send({ type: "result", id, value }, transfer);
    })()
      .catch((error) =>
        send({
          type: "result",
          id,
          value: null,
          error: nbtDocumentError(error),
        }),
      )
      .finally(() => requests.delete(id));
  };
  endpoint.addEventListener("message", listener);
  return async () => {
    closed = true;
    endpoint.removeEventListener("message", listener);
    for (const controller of requests.values()) controller.abort();
    for (const read of reads.values()) {
      read.cleanup();
      read.reject(new Error("NBT worker disposed."));
    }
    reads.clear();
    serialization?.controller.abort();
    await search?.close();
    await session?.close();
    await engine?.close();
    await serialization?.iterator.return(undefined);
    serialization?.hash.destroy();
  };
}
