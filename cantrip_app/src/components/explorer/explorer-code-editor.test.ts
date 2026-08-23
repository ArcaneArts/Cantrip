import { describe, expect, it, vi } from "vitest";

import { CantripApiError } from "@/lib/api";

import {
  createEditorAttachmentWithRouteRetry,
  isUnregisteredEditorRouteError,
} from "./explorer-code-editor";

describe("Explorer Code attachment startup", () => {
  it("retries a temporarily unregistered route while the server reloads", async () => {
    const attachment = { attachmentId: "attachment-one" };
    const create = vi
      .fn<() => Promise<typeof attachment>>()
      .mockRejectedValueOnce(new CantripApiError("Not Found", 404))
      .mockRejectedValueOnce(new CantripApiError("Not Found", 404))
      .mockResolvedValue(attachment);
    const wait = vi
      .fn<(delayMs: number) => Promise<void>>()
      .mockResolvedValue();

    await expect(
      createEditorAttachmentWithRouteRetry(create, wait),
    ).resolves.toBe(attachment);

    expect(create).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 150);
    expect(wait).toHaveBeenNthCalledWith(2, 350);
  });

  it("does not retry a real missing Explorer response", async () => {
    const error = new CantripApiError("Explorer not found.", 404);
    const create = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const wait = vi
      .fn<(delayMs: number) => Promise<void>>()
      .mockResolvedValue();

    await expect(
      createEditorAttachmentWithRouteRetry(create, wait),
    ).rejects.toBe(error);

    expect(create).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(isUnregisteredEditorRouteError(error)).toBe(false);
  });

  it("turns a persistently stale server into an actionable failure", async () => {
    const create = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new CantripApiError("Not Found", 404));
    const wait = vi
      .fn<(delayMs: number) => Promise<void>>()
      .mockResolvedValue();

    await expect(
      createEditorAttachmentWithRouteRetry(create, wait),
    ).rejects.toMatchObject({
      message:
        "The connected Cantrip Server has not loaded Explorer editor support. Restart Cantrip, then retry.",
      status: 503,
    });

    expect(create).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });
});
