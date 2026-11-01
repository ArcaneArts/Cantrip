import { expect, it, vi } from "vitest";
import { openProtectedBinarySource } from "./binary-file-source";
const version = "binary-v1:" + "a".repeat(64);
function page(offset = 0, data = [1], size = 3) {
  return {
    path: "data.nbt",
    offset,
    nextOffset: offset + data.length,
    size,
    eof: offset + data.length === size,
    version,
    data: btoa(String.fromCharCode(...data)),
  };
}
it("pins a snapshot and keeps all subsequent reads on that revision", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockResolvedValueOnce(page(1, [2, 3]));
  const source = await openProtectedBinarySource("data.nbt", read);
  expect(source.size).toBe(3);
  expect(await source.read(0, 1)).toEqual(Uint8Array.of(1));
  expect(await source.read(1, 2)).toEqual(Uint8Array.of(2, 3));
  expect(read.mock.calls[1]!.slice(0, 3)).toEqual([1, 2, version]);
  expect(await source.read(3, 1)).toHaveLength(0);
  source.close();
  await expect(source.read(0, 1)).rejects.toThrow("closed");
});
it.each([
  { version: "binary-v1:" + "b".repeat(64) },
  { path: "other.nbt" },
  { size: 4, eof: false },
])("rejects mixed-snapshot replies %j", async (patch) => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockResolvedValueOnce({ ...page(1, [2, 3]), ...patch });
  const source = await openProtectedBinarySource("data.nbt", read);
  await expect(source.read(1, 2)).rejects.toThrow();
  source.close();
});
it("aborts in-flight ranges on source close", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const read = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockImplementationOnce(
      (_offset, _limit, _version, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          ready();
        }),
    );
  const source = await openProtectedBinarySource("data.nbt", read),
    pending = source.read(1, 2);
  await started;
  source.close();
  await expect(pending).rejects.toThrow("closed");
});
it("cancels an individual read without closing the source", async () => {
  const controller = new AbortController();
  const read = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockImplementationOnce(
      (_o, _l, _v, signal: AbortSignal) =>
        new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    )
    .mockResolvedValueOnce(page(1, [2, 3]));
  const source = await openProtectedBinarySource("data.nbt", read),
    pending = source.read(1, 2, controller.signal);
  controller.abort(new Error("cancelled read"));
  await expect(pending).rejects.toThrow("cancelled read");
  expect(await source.read(1, 2)).toEqual(Uint8Array.of(2, 3));
  source.close();
});
it("fences replies that ignore abort signals", async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const source = await openProtectedBinarySource("data.nbt", read),
    pending = source.read(1, 2);
  source.close();
  finish(page(1, [2, 3]));
  await expect(pending).rejects.toThrow();
});
it("enforces bounded range allocation", async () => {
  const source = await openProtectedBinarySource(
    "data.nbt",
    vi.fn().mockResolvedValue(page()),
  );
  await expect(source.read(0, 256 * 1024 + 1)).rejects.toThrow(
    "Invalid binary",
  );
  source.close();
});

it("checks identity even when returning prefetched bytes", async () => {
  let live = true;
  const source = await openProtectedBinarySource(
    "data.nbt",
    vi.fn().mockResolvedValue(page()),
    undefined,
    () => {
      if (!live) throw new Error("account changed");
    },
  );
  live = false;
  await expect(source.read(0, 1)).rejects.toThrow("account changed");
  source.close();
});
