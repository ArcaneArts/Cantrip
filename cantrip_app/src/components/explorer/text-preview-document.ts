import type { ExplorerTextPreviewPage } from "@cantrip/protocol/surface-stream";
import { EditorDocumentSession } from "@/components/editor/document-session";

/** Read-only pages never enter the editor's save, recovery or transfer buffers. */
export class TextPreviewDocument {
  readonly session: EditorDocumentSession;
  offset = 0;
  size = 0;
  eof = false;
  version: string | undefined;
  private trailingCR = false;

  constructor(readonly path: string) {
    this.session = new EditorDocumentSession(`preview:${path}`, "", "");
  }

  append(page: ExplorerTextPreviewPage) {
    if (
      page.path !== this.path ||
      page.offset !== this.offset ||
      (this.version !== undefined &&
        (page.version !== this.version || page.size !== this.size)) ||
      page.nextOffset > page.size ||
      page.nextOffset < page.offset ||
      (!page.eof && page.nextOffset === page.offset) ||
      page.eof !== (page.nextOffset === page.size) ||
      new TextEncoder().encode(page.content).length !==
        page.nextOffset - page.offset
    )
      throw new Error(
        "The text preview returned a different file or page. Refresh to reload it.",
      );
    let content = page.content;
    if (this.offset === 0 && content.startsWith("\ufeff"))
      content = content.slice(1);
    if (this.trailingCR && content.startsWith("\n")) content = content.slice(1);
    this.trailingCR = page.content.endsWith("\r");
    this.session.edit(this.session.text + content.replace(/\r\n?/g, "\n"));
    this.session.baseline = this.session.text;
    this.offset = page.nextOffset;
    this.size = page.size;
    this.version = page.version;
    this.eof = page.eof;
  }
}
