import { describe, expect, it } from "vitest";

import { attachmentPromptText } from "../src/codex/attachment-inputs.js";

const image = {
  id: "image-1",
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
