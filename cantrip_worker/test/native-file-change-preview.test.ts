import { describe, expect, it } from "vitest";
import { agentFilePreviewLimitCharacters } from "@cantrip/protocol";

import { normalizeCodexThreadItem } from "../src/codex/app-server.js";

const correlation = {
  sourceMethod: "item/completed",
  diagnosticId: null,
  threadId: "thread",
  turnId: "turn",
  itemId: "patch",
};
function normalize(kind: "add" | "delete" | "update", diff?: string) {
  const activity = normalizeCodexThreadItem(
    {
      type: "fileChange",
      id: "patch",
      status: "completed",
      changes: [
        { path: "/project/notes/example.txt", kind: { type: kind }, diff },
      ],
    },
    "/project",
    "completed",
    correlation,
    { captureRaw: false, updatedAtMs: 123 },
  );
  if (activity?.type !== "fileChange")
    throw new Error("Expected file-change activity");
  return activity;
}

describe("native file-change content", () => {
  it.each([
    {
      kind: "add" as const,
      content: "WQA_EDIT54\n",
      preview: "+WQA_EDIT54",
      latest: "WQA_EDIT54",
    },
    {
      kind: "delete" as const,
      content: "removed\n",
      preview: "-removed",
      latest: "removed",
    },
    {
      kind: "add" as const,
      content: "+literal\n-literal\n++ heading\n+++ heading\n--- heading\n",
      preview: "++literal\n+-literal\n+++ heading\n++++ heading\n+--- heading",
      latest: "--- heading",
    },
    {
      kind: "delete" as const,
      content: "+literal\n-- heading\n--- heading\n",
      preview: "-+literal\n--- heading\n---- heading",
      latest: "--- heading",
    },
    {
      kind: "add" as const,
      content: " first  \r\n\r\nlast\r\n",
      preview: "+ first  \n+\n+last",
      latest: "last",
    },
    {
      kind: "update" as const,
      content: "@@ -1 +1 @@\n-old\n+new\n",
      preview: "-old\n+new",
      latest: "new",
    },
  ])(
    "preserves native $kind content and correct markers",
    ({ kind, content, preview, latest }) => {
      expect(normalize(kind, content).changes).toEqual([
        {
          path: "notes/example.txt",
          kind,
          diffPreview: preview,
          latestLine: latest,
          lastActivityAtMs: 123,
        },
      ]);
    },
  );

  it.each([undefined, ""])("keeps absent content %s unavailable", (diff) => {
    expect(normalize("add", diff).changes).toEqual([
      { path: "notes/example.txt", kind: "add", lastActivityAtMs: 123 },
    ]);
  });

  it("retains a bounded tail for a large added file without requiring raw capture", () => {
    const change = normalize("add", `${"line\n".repeat(10_000)}WQA_TAIL\n`)
      .changes[0]!;
    expect(change.diffPreview?.length).toBeLessThanOrEqual(
      agentFilePreviewLimitCharacters,
    );
    expect(change.diffPreview).toContain("+WQA_TAIL");
    expect(change.latestLine).toBe("WQA_TAIL");
  });
});
