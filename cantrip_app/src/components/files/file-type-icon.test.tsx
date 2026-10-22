import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTypeIcon } from "./file-type-icon";
import { fileIconExamples } from "./file-type-fixtures";

describe("file icon rendering", () => {
  it.each(fileIconExamples)("renders a bundled SVG for %s", (path, kind) => {
    const markup = renderToStaticMarkup(
      <FileTypeIcon path={path} className="size-3.5" />,
    );
    expect(markup).toContain(`data-file-icon="${kind}"`);
    expect(markup).toContain("<path");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain("size-3.5");
    expect(markup).not.toContain("size-4");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("href=");
  });
  it("uses the actual Rust gear logo with inherited color, not an unreadable black fill", () => {
    const markup = renderToStaticMarkup(<FileTypeIcon path="lib.rs" />);
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).not.toContain("#000000");
  });
  it.each([false, true])(
    "keeps directories as folders even with a language-like name, expanded=%s",
    (expanded) => {
      const markup = renderToStaticMarkup(
        <FileTypeIcon path="folder.rs" kind="directory" expanded={expanded} />,
      );
      expect(markup).toContain(
        `data-file-icon="${expanded ? "folder-open" : "folder"}"`,
      );
    },
  );
  it("keeps special filesystem entries generic instead of treating them as code", () => {
    expect(
      renderToStaticMarkup(<FileTypeIcon path="socket.rs" kind="other" />),
    ).toContain('data-file-icon="file"');
  });
});
