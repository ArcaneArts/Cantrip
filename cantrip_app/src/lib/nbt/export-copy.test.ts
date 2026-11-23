import { expect, it, vi } from "vitest";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
import { exportNbtCopy, type NbtExportSink } from "./export-copy";

function fixture() {
  const release = vi.fn(),
    ended = vi.fn(),
    receipt = { size: 768 * 1024 + 13, sha256: "a".repeat(64) },
    serialize = vi.fn(async function* () {
      try {
        yield new Uint8Array(receipt.size).fill(42);
        return receipt;
      } finally {
        ended();
      }
    }),
    freezeEdits = vi.fn(() => release),
    client = { freezeEdits, serialize } as unknown as NbtDocumentClient,
    sink: NbtExportSink = {
      completion: "copy consumed",
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
  return { client, sink, release, ended, receipt, serialize };
}

it("awaits each bounded write and closes only after the serialization receipt", async () => {
  const f = fixture(),
    progress: number[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(f.sink.write).mockImplementationOnce(async () => held);
  const result = exportNbtCopy(
    f.client,
    "file.nbt",
    async () => f.sink,
    new AbortController().signal,
    (size) => progress.push(size),
  );
  await vi.waitFor(() => expect(f.sink.write).toHaveBeenCalledTimes(1));
  expect(f.sink.close).not.toHaveBeenCalled();
  release();
  await expect(result).resolves.toEqual({
    ...f.receipt,
    message: "copy consumed",
  });
  expect(
    vi.mocked(f.sink.write).mock.calls.map(([bytes]) => bytes.length),
  ).toEqual([256 * 1024, 256 * 1024, 256 * 1024, 13]);
  expect(progress.at(-1)).toBe(f.receipt.size);
  expect(f.sink.close).toHaveBeenCalledWith(f.receipt);
  expect(f.sink.abort).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

it("starts no serializer when the destination picker is cancelled", async () => {
  const f = fixture();
  await expect(
    exportNbtCopy(
      f.client,
      "file.nbt",
      async () => null,
      new AbortController().signal,
    ),
  ).resolves.toBeNull();
  expect(f.serialize).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

it("cancels between writes, closes the producer, and never commits a partial copy", async () => {
  const f = fixture(),
    controller = new AbortController();
  vi.mocked(f.sink.write).mockImplementationOnce(async () => {
    controller.abort(new Error("User cancelled"));
  });
  await expect(
    exportNbtCopy(f.client, "file.nbt", async () => f.sink, controller.signal),
  ).rejects.toThrow(/User cancelled/);
  expect(f.sink.write).toHaveBeenCalledOnce();
  expect(f.sink.abort).toHaveBeenCalledOnce();
  expect(f.sink.close).not.toHaveBeenCalled();
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});

it.each(["write", "close"] as const)(
  "retains the draft and releases the client after a %s failure",
  async (phase) => {
    const f = fixture();
    vi.mocked(f.sink[phase]).mockRejectedValue(new Error("Disk full"));
    vi.mocked(f.sink.abort).mockRejectedValue(new Error("Cleanup failed"));
    await expect(
      exportNbtCopy(
        f.client,
        "file.nbt",
        async () => f.sink,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Disk full/);
    expect(f.sink.abort).toHaveBeenCalledOnce();
    expect(f.ended).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  },
);

it("rejects a receipt with a different size before committing the copy", async () => {
  const f = fixture();
  f.serialize.mockImplementation(async function* () {
    yield new Uint8Array(10);
    return f.receipt;
  });
  await expect(
    exportNbtCopy(
      f.client,
      "file.nbt",
      async () => f.sink,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/size changed/);
  expect(f.sink.close).not.toHaveBeenCalled();
  expect(f.sink.abort).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});
