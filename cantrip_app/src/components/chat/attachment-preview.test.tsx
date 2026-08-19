import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttachmentPreview } from "./attachment-preview";

const pastedText = {
  fileName: "pasted-text-2026-08-19.txt",
  id: "paste-1",
  kind: "text" as const,
  mimeType: "text/plain",
  previewText: "\n# Goal: Geography explorer\nBuild the full feature.",
  sizeBytes: 8_192,
  source: "paste" as const,
};

describe("AttachmentPreview", () => {
  it("renders a compact restorable chip for composer paste attachments", () => {
    const markup = renderToStaticMarkup(
      <AttachmentPreview
        attachment={pastedText}
        contentUrl="/attachment.txt"
        onOpen={() => undefined}
        onRemove={() => undefined}
        onRestoreText={() => undefined}
      />,
    );

    expect(markup).toContain("# Goal: Geography explorer");
    expect(markup).toContain("Show in text field");
    expect(markup).not.toContain("Build the full feature.");
  });

  it("does not offer transcript attachments as editable composer text", () => {
    const markup = renderToStaticMarkup(
      <AttachmentPreview
        attachment={pastedText}
        contentUrl="/attachment.txt"
        onOpen={() => undefined}
      />,
    );

    expect(markup).not.toContain("Show in text field");
  });
});
