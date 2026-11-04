import { describe, expect, it } from "vitest";
import { guestFileUri, guestPathFromFileUri } from "./paths.js";

describe("Linux guest addresses", () => {
  it("round-trips literal percent, fragment, query and Unicode filenames", () => {
    for (const path of [
      "/workspace/source/a #b%?.txt",
      "/workspace/source/literal%2Fname",
      "/workspace/source/日本語.txt",
      "/",
    ])
      expect(guestPathFromFileUri(guestFileUri(path))).toBe(path);
    expect(guestFileUri("/workspace/a#b")).toBe("file:///workspace/a%23b");
  });

  it("rejects relative addresses and other machines' file authorities", () => {
    expect(() => guestFileUri("relative/file")).toThrow();
    expect(() =>
      guestPathFromFileUri("file://worker-host/etc/passwd"),
    ).toThrow();
    expect(() => guestPathFromFileUri("https://example.test/file")).toThrow();
    expect(() =>
      guestPathFromFileUri("file:///workspace/a#fragment"),
    ).toThrow();
  });
});
