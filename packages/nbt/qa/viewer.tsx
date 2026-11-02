import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NbtBrowser } from "../../../cantrip_app/src/components/nbt/browser";
import "./viewer.css";
import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "../src/recovery/index";
import {
  validateNbtViewState,
  type NbtViewState,
} from "../../../cantrip_app/src/lib/nbt/view-state";
import type { FileViewerSession } from "../../../cantrip_app/src/components/files/file-viewers";
import {
  encodeNbtPayload,
  JAVA_NBT,
  BEDROCK_NBT,
  NETWORK_NBT,
  NbtTag,
  type NbtEntry,
  type NbtEncoding,
  encodeNbtFile,
  blobNbtSource,
} from "../src/index";

const statistics = { reads: 0, maxRead: 0, closed: 0 };
const recoveryEnabled = new URL(location.href).searchParams.has("recovery");
Object.assign(window, { __nbtViewerStatistics: statistics });
async function collect(chunks: AsyncIterable<Uint8Array>) {
  const parts: BlobPart[] = [];
  for await (const part of chunks)
    parts.push(part.slice().buffer as ArrayBuffer);
  return new Blob(parts);
}
const str = (name: string, value: string): NbtEntry => ({
  name,
  tag: { type: NbtTag.String, value },
});
const int = (name: string, value: number): NbtEntry => ({
  name,
  tag: { type: NbtTag.Int, value },
});
const fixture = async (entries: NbtEntry[], format: NbtEncoding = JAVA_NBT) =>
  collect(
    encodeNbtPayload(
      {
        name: format.namedRoot ? "world" : undefined,
        tag: { type: NbtTag.Compound, value: entries },
      },
      format,
    ),
  );
async function make(name: string) {
  if (name === "large") {
    const length = 100 * 1024 ** 2,
      parts: BlobPart[] = [
        Uint8Array.of(10, 0, 0, 7, 0, 5, 97, 114, 114, 97, 121, 6, 64, 0, 0)
          .buffer,
      ];
    for (let i = 0; i < length; i += 65536)
      parts.push(new Uint8Array(Math.min(65536, length - i)).fill(42).buffer);
    const end = await fixture([
      {
        name: "hidden",
        tag: {
          type: NbtTag.Compound,
          value: [
            str("full", "x".repeat(49000) + "TAIL_NEEDLE"),
            {
              name: "long",
              tag: { type: NbtTag.Long, value: 9007199254740993n },
            },
            str("duplicate", "TAIL_NEEDLE"),
          ],
        },
      },
    ]);
    parts.push(await end.slice(8).arrayBuffer());
    const raw = new Blob(parts);
    return new Response(
      raw.stream().pipeThrough(new CompressionStream("gzip")),
    ).blob();
  }
  if (name === "table")
    return fixture([
      {
        name: "items",
        tag: {
          type: NbtTag.List,
          elementType: NbtTag.Compound,
          length: 500,
          value: Array.from({ length: 500 }, (_, i) => ({
            type: NbtTag.Compound,
            value:
              i % 2
                ? [
                    str("b", "row " + i),
                    str("a", "typed " + i),
                    int("duplicate", i),
                    int("duplicate", i + 1),
                  ]
                : [
                    int("a", i),
                    str("b", "row " + i),
                    str("duplicate", "first"),
                    int("duplicate", i),
                    ...Array.from({ length: 8 }, (_, n) => int("field" + n, n)),
                  ],
          })),
        },
      },
    ]);
  if (name === "bedrock")
    return collect(
      encodeNbtFile(
        blobNbtSource(await fixture([int("little", 42)], BEDROCK_NBT)),
        { ...BEDROCK_NBT, bedrockLevel: true },
        { levelVersion: 10 },
      ),
    );
  if (name === "network") return fixture([int("network", -42)], NETWORK_NBT);
  if (name === "broken") return new Blob([Uint8Array.of(10, 0, 0, 99)]);
  throw new Error("Unknown QA fixture");
}
function App() {
  const [file, setFile] = useState<Blob | null>(null),
    [epoch, setEpoch] = useState(0),
    [active, setActive] = useState(true),
    [name, setName] = useState("large"),
    [loading, setLoading] = useState(false),
    [documentId, setDocumentId] = useState(() => crypto.randomUUID()),
    [viewState, setViewState] = useState<NbtViewState | undefined>();
  const session = useRef<FileViewerSession | null>(null);
  const onSession = useCallback((value: FileViewerSession | null) => {
    session.current = value;
  }, []);
  useEffect(() => {
    Object.assign(window, {
      __nbtViewerTransfer: {
        capture: async () => session.current?.checkpoint?.(),
        restore(value: unknown) {
          setViewState(validateNbtViewState(value));
          setEpoch((value) => value + 1);
        },
      },
    });
  }, []);
  const openRecovery = useCallback(async () => {
    // Public fixture key; this entry point is never part of the product build.
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(11),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const log = async () =>
      NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(documentId),
        documentId,
        key,
      );
    return {
      id: documentId,
      key,
      assertCurrent() {},
      onInvalidate: () => () => {},
      async claim() {
        const journal = await log();
        try {
          return await journal.claim();
        } finally {
          await journal.close();
        }
      },
      async inspect() {
        const journal = await log();
        try {
          return journal.descriptor();
        } finally {
          await journal.close();
        }
      },
    };
  }, [documentId]);
  const open = useCallback(
    async (signal: AbortSignal) => {
      if (!file) throw new Error("Choose a fixture");
      return {
        version: "qa-source-" + documentId,
        size: file.size,
        async read(offset: number, length: number, abort?: AbortSignal) {
          signal.throwIfAborted();
          abort?.throwIfAborted();
          statistics.reads++;
          statistics.maxRead = Math.max(length, statistics.maxRead);
          return new Uint8Array(
            await file.slice(offset, offset + length).arrayBuffer(),
          );
        },
        close() {
          statistics.closed++;
        },
      };
    },
    [file, documentId],
  );
  return (
    <main
      data-qa-nbt-epoch={epoch}
      className="flex h-dvh flex-col bg-background text-foreground"
    >
      <div className="flex shrink-0 gap-3 p-2 text-xs">
        <select
          aria-label="QA fixture"
          value={name}
          onChange={(event) => setName(event.target.value)}
        >
          {["large", "table", "bedrock", "network", "broken"].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <button
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void make(name)
              .then((blob) => {
                setFile(blob);
                setViewState(undefined);
                setDocumentId(crypto.randomUUID());
                setEpoch((value) => value + 1);
              })
              .finally(() => setLoading(false));
          }}
        >
          Load fixture
        </button>
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          Active viewer
        </label>
      </div>
      {file ? (
        <NbtBrowser
          key={epoch}
          openSource={open}
          scope={"QA/viewer/" + epoch}
          active={active}
          openRecovery={recoveryEnabled ? openRecovery : undefined}
          initialViewState={viewState}
          onSessionChange={onSession}
          onLocalFile={(file) => {
            setFile(file);
            setEpoch((value) => value + 1);
          }}
        />
      ) : (
        <p>Choose a disposable NBT fixture.</p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
