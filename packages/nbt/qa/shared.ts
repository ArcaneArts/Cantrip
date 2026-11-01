import { JAVA_NBT, NbtTag, encodeNbtPayload } from "../src/index.js";
import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "../src/recovery/index.js";
import {
  NbtSharedDocument,
  nbtSharedDocument,
} from "../../../cantrip_app/src/lib/nbt/shared-document";
import { openNbtDocument } from "../../../cantrip_app/src/lib/nbt/document";
import type { NbtDocumentClient } from "../src/document/index.js";
import type { NbtSharedFactory } from "../../../cantrip_app/src/lib/nbt/shared-owner";

let client: NbtDocumentClient | undefined,
  workers = 0;
const frames: Uint8Array[] = [];
const Channel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends Channel {
  postMessage(value: unknown) {
    if (
      this.name.startsWith("cantrip-nbt-v1:") &&
      value &&
      typeof value === "object" &&
      "bytes" in value &&
      value.bytes instanceof Uint8Array
    )
      frames.push(value.bytes.slice());
    return super.postMessage(value);
  }
};
async function open(id: string) {
  // Public, disposable fixture material, never account or production key data.
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const part of encodeNbtPayload(
    {
      name: "",
      tag: {
        type: NbtTag.Compound,
        value: [
          {
            name: "number",
            tag: { type: NbtTag.Long, value: 9007199254740993n },
          },
          {
            name: "private-marker-long-enough-to-test-encryption",
            tag: { type: NbtTag.String, value: "shared-secret-fixture-value" },
          },
        ],
      },
    },
    JAVA_NBT,
  ))
    parts.push(part.slice());
  const blob = new Blob(parts);
  const factory: NbtSharedFactory = {
    async claim() {
      const log = await NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(id),
        id,
        key,
      );
      try {
        return await log.claim();
      } finally {
        await log.close();
      }
    },
    async create(choice, signal, onCreated) {
      const log = await NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(id),
        id,
        key,
      );
      const recovered = !choice && log.descriptor();
      await log.close();
      workers++;
      return openNbtDocument(
        recovered ? null : blob,
        {
          binding: id,
          format: choice?.format ?? JAVA_NBT,
          version: "fixture-v1",
          ...(!choice ? { recovery: { id, key } } : {}),
        },
        signal,
        onCreated,
      );
    },
    async attachRecovery(client) {
      await client.attachRecovery({ id, key });
    },
    async reconcile(client) {
      if (client.getEditSnapshot()?.pendingSaveId)
        throw new Error(
          "The shared fixture does not perform filesystem saves.",
        );
    },
  };
  client = await NbtSharedDocument.open(
    {
      id,
      key,
      factory,
      assertCurrent() {},
      onInvalidate() {
        return () => {};
      },
    },
    undefined,
    (client) => {
      void client.setPaused(false).catch(() => {});
    },
  );
}
const qa = {
  open,
  status() {
    return {
      document: client?.getSnapshot(),
      edit: client?.getEditSnapshot(),
      workers,
    };
  },
  value() {
    return client!.describe("node:1").then((row) => String(row.value));
  },
  edit(value: string) {
    return client!.edit([{ type: "value", id: "node:1", value }]);
  },
  undo() {
    return client!.undo();
  },
  redo() {
    return client!.redo();
  },
  pause(paused: boolean) {
    return client!.setPaused(paused);
  },
  checkpoint() {
    return nbtSharedDocument(client!)!.checkpoint();
  },
  search(id: string, text: string) {
    return client!.startSearch(id, {
      text,
      fields: ["name", "value"],
      caseSensitive: false,
      exactNumber: false,
    });
  },
  searchStatus() {
    return client!.getSearchSnapshot();
  },
  results(id: string) {
    return client!.searchResults(id, 0);
  },
  replace() {
    return nbtSharedDocument(client!)!.replace();
  },
  async close(discard = false) {
    if (discard) await nbtSharedDocument(client!)!.closeView();
    await client!.close();
  },
  frames() {
    return frames.map((bytes) => new TextDecoder().decode(bytes)).join("");
  },
};
Object.assign(globalThis, { __nbtSharedQa: qa });
