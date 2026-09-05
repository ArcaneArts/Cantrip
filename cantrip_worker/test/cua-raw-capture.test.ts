import { describe, expect, it } from "vitest";

import { normalizeCodexThreadItem } from "../src/codex/app-server.js";

describe("computer-use image raw trajectory capture", () => {
  it("omits the nested MCP image while leaving the original model result intact", () => {
    const sentinel = Buffer.from(
      "private computer-use screenshot sentinel",
    ).toString("base64");
    const image = Object.freeze({
      type: "image",
      mimeType: "image/png",
      data: sentinel,
    });
    const item = {
      type: "mcpToolCall" as const,
      id: "cua-mcp-image-1",
      server: "cantrip-computer-use",
      tool: "javascript",
      status: "completed" as const,
      arguments: { source: "await cua.snapshot()" },
      result: { content: [image, { type: "text", text: "Snapshot complete" }] },
      error: null,
      durationMs: 12,
    };
    const original = structuredClone(item);
    const correlation = {
      sourceMethod: "item/completed",
      diagnosticId: "runtime-session:12",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: item.id,
    };

    const activity = normalizeCodexThreadItem(
      item,
      "/workspace",
      "completed",
      correlation,
      { captureRaw: true },
    );

    expect(activity?.raw).toMatchObject({ schemaVersion: 1 });
    expect(activity?.raw?.response?.text).toContain("Snapshot complete");
    expect(activity?.raw?.response?.text).toContain(
      "Image content is not embedded in trajectory capture.",
    );
    expect(JSON.stringify(activity)).not.toContain(sentinel);
    expect(item).toEqual(original);
    expect(item.result.content[0]).toBe(image);
    expect(image.data).toBe(sentinel);

    expect(
      normalizeCodexThreadItem(item, "/workspace", "completed", correlation),
    ).not.toHaveProperty("raw");
    expect(item).toEqual(original);
  });
});
