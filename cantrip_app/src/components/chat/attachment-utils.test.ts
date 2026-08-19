import { describe, expect, it } from "vitest";

import {
  attachmentKind,
  formatAttachmentBytes,
  insertComposerText,
  LARGE_PASTE_THRESHOLD,
  largePasteFileName,
  pastedTextAttachmentLabel,
  shouldAttachPastedText,
} from "./attachment-utils";

describe("attachment composer utilities", () => {
  it("classifies common attachment types", () => {
    expect(attachmentKind("screen.png", "image/png")).toBe("image");
    expect(attachmentKind("voice.m4a", "audio/mp4")).toBe("audio");
    expect(attachmentKind("trace.log", "application/octet-stream")).toBe(
      "text",
    );
    expect(attachmentKind("archive.zip", "application/zip")).toBe("file");
  });

  it("converts only large text pastes and gives them stable readable names", () => {
    expect(shouldAttachPastedText("x".repeat(LARGE_PASTE_THRESHOLD))).toBe(
      false,
    );
    expect(shouldAttachPastedText("x".repeat(LARGE_PASTE_THRESHOLD + 1))).toBe(
      true,
    );
    expect(largePasteFileName(new Date("2026-08-08T14:30:15.123Z"))).toBe(
      "pasted-text-2026-08-08-14-30-15-123.txt",
    );
  });

  it("labels pasted text from its first non-empty content line", () => {
    expect(
      pastedTextAttachmentLabel(
        "\n  # Goal: Map every biome  \nMore detail",
        "pasted-text.txt",
      ),
    ).toBe("# Goal: Map every biome");
    expect(pastedTextAttachmentLabel("\n \n", "pasted-text.txt")).toBe(
      "pasted-text.txt",
    );
  });

  it("inserts attachment references around an active selection", () => {
    expect(
      insertComposerText("before after", "Read attachment note.txt", 7),
    ).toEqual({
      caret: 32,
      text: "before \nRead attachment note.txt\nafter",
    });
    expect(insertComposerText("replace me", "attachment", 0, 7)).toEqual({
      caret: 10,
      text: "attachment\n me",
    });
  });

  it("formats compact file sizes", () => {
    expect(formatAttachmentBytes(12)).toBe("12 B");
    expect(formatAttachmentBytes(1_536)).toBe("1.5 KB");
    expect(formatAttachmentBytes(2 * 1_024 * 1_024)).toBe("2.0 MB");
  });
});
