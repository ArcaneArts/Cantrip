import { expect, it, vi } from "vitest";
import { openPickerNbtExport } from "./picker-export";

const receipt = { size: 3, sha256: "a".repeat(64) };
const fixture = () => {
  const writer = {
      write: vi.fn(async (_bytes: ArrayBuffer) => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async (_reason: unknown) => {}),
    },
    createWritable = vi.fn(
      async () => writer as unknown as FileSystemWritableFileStream,
    ),
    picker = vi.fn(async () => ({ createWritable }));
  return { picker, writer, createWritable };
};

it("invokes the destination picker synchronously and awaits the actual commit", async () => {
  const f = fixture(),
    opening = openPickerNbtExport(
      f.picker,
      "chosen.nbt",
      new AbortController().signal,
    );
  expect(f.picker).toHaveBeenCalledWith({ suggestedName: "chosen.nbt" });
  const sink = (await opening)!;
  const bytes = new Uint8Array([1, 2, 3]);
  f.writer.write.mockImplementation(async (copy) =>
    expect([...new Uint8Array(copy)]).toEqual([1, 2, 3]),
  );
  await sink.write(bytes);
  await sink.close(receipt);
  expect(f.writer.close).toHaveBeenCalledOnce();
  expect(f.writer.abort).not.toHaveBeenCalled();
  expect([...bytes]).toEqual([1, 2, 3]);
});

it("distinguishes a cancelled picker from an actual permission or write failure", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  f.picker.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
  await expect(
    openPickerNbtExport(f.picker, "file.nbt", signal),
  ).resolves.toBeNull();
  expect(f.createWritable).not.toHaveBeenCalled();
  f.picker.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await expect(
    openPickerNbtExport(f.picker, "file.nbt", signal),
  ).rejects.toThrow(/Denied/);
  const sink = (await openPickerNbtExport(f.picker, "file.nbt", signal))!;
  f.writer.write.mockRejectedValueOnce(new Error("Disk full"));
  await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(/Disk full/);
  await sink.abort(new Error("Stopped"));
  expect(f.writer.abort).toHaveBeenCalledOnce();
  expect(f.writer.close).not.toHaveBeenCalled();
});

it("aborts an open destination on cancellation and removes its listener after close", async () => {
  const f = fixture(),
    controller = new AbortController(),
    sink = (await openPickerNbtExport(
      f.picker,
      "file.nbt",
      controller.signal,
    ))!;
  controller.abort(new Error("Account locked"));
  expect(f.writer.abort).toHaveBeenCalledOnce();
  await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(/closed/);
  const next = fixture(),
    nextController = new AbortController(),
    complete = (await openPickerNbtExport(
      next.picker,
      "file.nbt",
      nextController.signal,
    ))!;
  await complete.close(receipt);
  nextController.abort();
  expect(next.writer.abort).not.toHaveBeenCalled();
});
