import { describe, expect, it, vi } from "vitest";

import { CantripApiError } from "@/lib/api";

import {
  createEditorAttachmentWithCompatibilityFallback,
  isUnregisteredEditorRouteError,
} from "./explorer-code-editor";

describe("Explorer Code attachment startup", () => {
  it("uses the transient Explorer route when the server supports it", async () => {
    const attachment = { attachmentId: "attachment-one" };
    const create = vi
      .fn<() => Promise<typeof attachment>>()
      .mockResolvedValue(attachment);
    const createCompatibilityAttachment =
      vi.fn<() => Promise<typeof attachment>>();

    await expect(
      createEditorAttachmentWithCompatibilityFallback(
        create,
        createCompatibilityAttachment,
      ),
    ).resolves.toEqual({ attachment, compatibilityFallback: false });

    expect(create).toHaveBeenCalledOnce();
    expect(createCompatibilityAttachment).not.toHaveBeenCalled();
  });

  it("does not mask a real missing Explorer response", async () => {
    const error = new CantripApiError("Explorer not found.", 404);
    const create = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const createCompatibilityAttachment = vi.fn<() => Promise<never>>();

    await expect(
      createEditorAttachmentWithCompatibilityFallback(
        create,
        createCompatibilityAttachment,
      ),
    ).rejects.toBe(error);

    expect(create).toHaveBeenCalledOnce();
    expect(createCompatibilityAttachment).not.toHaveBeenCalled();
    expect(isUnregisteredEditorRouteError(error)).toBe(false);
  });

  it("falls back to the legacy Code attachment route for an older server", async () => {
    const attachment = { attachmentId: "attachment-legacy" };
    const create = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new CantripApiError("Not Found", 404));
    const createCompatibilityAttachment = vi
      .fn<() => Promise<typeof attachment>>()
      .mockResolvedValue(attachment);

    await expect(
      createEditorAttachmentWithCompatibilityFallback(
        create,
        createCompatibilityAttachment,
      ),
    ).resolves.toEqual({ attachment, compatibilityFallback: true });

    expect(create).toHaveBeenCalledOnce();
    expect(createCompatibilityAttachment).toHaveBeenCalledOnce();
  });
});
