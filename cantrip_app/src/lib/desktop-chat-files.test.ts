import { describe, expect, it } from "vitest";

import {
  chatFilesAreLocalToDesktop,
  chatScratchRevealUsesLocalFolder,
  desktopChatRevealLabel,
} from "./desktop-chat-files";

describe("standalone Chat file locality", () => {
  it("requires an exact desktop worker and normalized server match", () => {
    const workers = [
      {
        name: "Local",
        running: true,
        serverUrl: "https://cantrip.example/",
        workerId: "worker-local",
      },
    ];
    expect(
      chatFilesAreLocalToDesktop(
        "worker-local",
        "https://cantrip.example",
        workers,
      ),
    ).toBe(true);
    expect(
      chatFilesAreLocalToDesktop(
        "worker-other",
        "https://cantrip.example",
        workers,
      ),
    ).toBe(false);
    expect(
      chatFilesAreLocalToDesktop(
        "worker-local",
        "https://other.example",
        workers,
      ),
    ).toBe(false);
  });

  it("offers native reveal only on supported desktop platforms", () => {
    expect(desktopChatRevealLabel(true, "Macintosh")).toBe("Show in Finder");
    expect(desktopChatRevealLabel(true, "Windows NT 10.0")).toBe(
      "Show in File Explorer",
    );
    expect(desktopChatRevealLabel(false, "Macintosh")).toBeNull();
  });

  it("uses a network share by default and the proven local root with Shift", () => {
    expect(chatScratchRevealUsesLocalFolder(true, true, false)).toBe(false);
    expect(chatScratchRevealUsesLocalFolder(true, true, true)).toBe(true);
    expect(chatScratchRevealUsesLocalFolder(true, false, false)).toBe(true);
    expect(chatScratchRevealUsesLocalFolder(false, true, true)).toBe(false);
  });
});
