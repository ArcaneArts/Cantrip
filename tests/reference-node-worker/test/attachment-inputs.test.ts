import { describe, expect, it } from "vitest";

import { attachmentPromptText } from "../src/codex/attachment-inputs.js";

const image = {
  id: "image-1",
  chatId: "chat",
  source: "file" as const,
  status: "ready" as const,
  previewText: null,
  createdAt: "2026-11-04T00:00:00.000Z",
  fileName: "screen.png",
  mimeType: "image/png",
  sizeBytes: 128,
  kind: "image" as const,
  path: "/worker/attachments/screen.png",
};

describe("Codex attachment input", () => {
  it("warns clearly when a text-only model cannot receive image input", () => {
    expect(attachmentPromptText("Inspect this", [image], false)).toContain(
      "The selected model is text-only. Image files were not sent as model image input",
    );
  });

  it("does not add the warning when image input is supported", () => {
    expect(attachmentPromptText("Inspect this", [image], true)).not.toContain(
      "text-only",
    );
  });
});

it("labels a materialized Linux path without claiming it is on the worker", () => {
  const text = attachmentPromptText(
    "Inspect this",
    [{ ...image, path: "/home/work/.local/share/attachments/screen.png" }],
    false,
    "Linux workspace",
  );
  expect(text).toContain("in this Linux workspace");
  expect(text).toContain("/home/work/.local/share/attachments/screen.png");
  expect(text).not.toContain("/worker/attachments");
});
