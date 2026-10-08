import type {
  ChatAttachmentSummary,
  ChatComposerDraft,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import { ChatComposerDraftPersistence } from "@/lib/chat-composer-draft-persistence";
import {
  composerDraftWithAttachments,
  restoreComposerDraftAttachments,
  type ComposerAttachmentState,
} from "./composer-draft-attachments";

const attachment: ChatAttachmentSummary = {
  id: "uploaded-one",
  chatId: "chat-one",
  fileName: "pasted-text.txt",
  mimeType: "text/plain",
  sizeBytes: 5166,
  kind: "text",
  source: "paste",
  status: "ready",
  previewText: "unfinished paste",
  createdAt: "2026-10-08T12:00:00.000Z",
};
const empty = { text: "", mode: "default" as const, reasoningEffort: null };
const item: ComposerAttachmentState = {
  attachment,
  contentUrl: "https://old-server/content",
  error: null,
  uploading: false,
  localPreview: false,
};
const url = (id: string) => `/current-server/api/attachments/${id}/content`;

describe("composer attachment draft lifecycle", () => {
  it.each(["paste", "file"] as const)(
    "restores ready %s attachment-only drafts using current server URLs",
    (source) => {
      const draft = composerDraftWithAttachments(empty, [
        { ...item, attachment: { ...attachment, source } },
      ]);
      expect(draft?.text).toBe("");
      expect(draft?.attachments).toHaveLength(1);
      const restored = restoreComposerDraftAttachments("chat-one", draft, url);
      expect(restored).toEqual([
        {
          ...item,
          attachment: { ...attachment, source },
          contentUrl: url(attachment.id),
        },
      ]);
    },
  );

  it.each([
    { uploading: true },
    { error: "upload failed" },
    { localPreview: true },
    { attachment: { ...attachment, status: "failed" as const } },
    { attachment: { ...attachment, id: "local-incomplete" } },
  ])("never persists transient or failed attachment state: %j", (change) => {
    expect(
      composerDraftWithAttachments(empty, [{ ...item, ...change }]),
    ).toBeNull();
    expect(
      composerDraftWithAttachments({ ...empty, text: "keep text" }, [
        { ...item, ...change },
      ]),
    ).toEqual({ ...empty, text: "keep text" });
  });

  it("ignores foreign-chat, failed, local and duplicate saved references", () => {
    const draft = {
      ...empty,
      attachments: [
        attachment,
        attachment,
        { ...attachment, id: "foreign", chatId: "chat-two" },
        { ...attachment, id: "failed", status: "failed" as const },
        { ...attachment, id: "local-incomplete" },
      ],
    };
    expect(
      restoreComposerDraftAttachments("chat-one", draft, url).map(
        (item) => item.attachment.id,
      ),
    ).toEqual([attachment.id]);
  });

  it("opens legacy text-only drafts without attachments", () => {
    expect(
      restoreComposerDraftAttachments(
        "chat-one",
        { ...empty, text: "legacy" },
        url,
      ),
    ).toEqual([]);
    expect(restoreComposerDraftAttachments("chat-one", null, url)).toEqual([]);
  });

  it("persists removal and send clears after an attachment save already in flight", async () => {
    let release: () => void = () => undefined;
    let durable: ChatComposerDraft | null = null;
    const writes: (ChatComposerDraft | null)[] = [];
    const persistence = new ChatComposerDraftPersistence(async (draft) => {
      writes.push(draft);
      if (writes.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      durable = draft;
    });
    persistence.schedule(composerDraftWithAttachments(empty, [item]));
    const flushing = persistence.flush();
    expect(writes[0]?.attachments).toEqual([attachment]);
    persistence.schedule(composerDraftWithAttachments(empty, []));
    release();
    await flushing;
    expect(writes).toHaveLength(2);
    expect(durable).toBeNull();
    expect(restoreComposerDraftAttachments("chat-one", durable, url)).toEqual(
      [],
    );
  });
});
