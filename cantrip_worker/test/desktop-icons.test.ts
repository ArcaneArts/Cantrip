import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopApplicationIconStore } from "../src/desktop/desktop-icons.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-icons-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("DesktopApplicationIconStore", () => {
  it("deduplicates extraction and persists icons in the worker cache", async () => {
    const dataDirectory = await temporaryDirectory();
    const png = Buffer.from("small-png");
    const extract = vi.fn(async () => png);
    const first = new DesktopApplicationIconStore(dataDirectory, extract);
    const key = first.register("Visual Studio Code");

    const [left, right] = await Promise.all([
      first.resolve(key),
      first.resolve(key),
    ]);
    expect(left).toEqual(right);
    expect(left.data).toBe(png.toString("base64"));
    expect(extract).toHaveBeenCalledOnce();

    const secondExtract = vi.fn(async () => null);
    const second = new DesktopApplicationIconStore(
      dataDirectory,
      secondExtract,
    );
    expect(second.register("Visual Studio Code")).toBe(key);
    await expect(second.resolve(key)).resolves.toEqual(left);
    expect(secondExtract).not.toHaveBeenCalled();
  });

  it("caches missing application icons without repeatedly probing the OS", async () => {
    const dataDirectory = await temporaryDirectory();
    const extract = vi.fn(async () => null);
    const store = new DesktopApplicationIconStore(dataDirectory, extract);
    const key = store.register("Headless helper");

    await expect(store.resolve(key)).resolves.toMatchObject({ data: null });
    await expect(store.resolve(key)).resolves.toMatchObject({ data: null });
    expect(extract).toHaveBeenCalledOnce();
  });
});
