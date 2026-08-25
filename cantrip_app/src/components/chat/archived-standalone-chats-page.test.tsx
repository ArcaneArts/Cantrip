import { archivedStandaloneChatSummarySchema } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ArchivedStandaloneChatsPage,
  archivedChatRecoveryLabel,
} from "./archived-standalone-chats-page";

const archivedChat = archivedStandaloneChatSummarySchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  contextKind: "standalone",
  projectId: null,
  experience: "agent",
  archivedAt: "2026-08-25T12:00:00.000Z",
  createdAt: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-09-24T12:00:00.000Z",
  messageCount: 4,
  title: "Research notes",
  updatedAt: "2026-08-25T12:00:00.000Z",
});

describe("archived standalone Chat page", () => {
  it("renders archived conversations as full-page content", () => {
    const markup = renderToStaticMarkup(
      <ArchivedStandaloneChatsPage
        chats={[archivedChat]}
        deleting={false}
        loading={false}
        restoring={false}
        onPermanentlyDelete={() => undefined}
        onRestore={() => undefined}
      />,
    );

    expect(markup).toContain("Archived chats");
    expect(markup).toContain("Research notes");
    expect(markup).toContain("4 messages");
    expect(markup).toContain("Restore");
    expect(markup).not.toContain('role="dialog"');
  });

  it("renders an inline empty state and stable recovery labels", () => {
    const markup = renderToStaticMarkup(
      <ArchivedStandaloneChatsPage
        chats={[]}
        deleting={false}
        loading={false}
        restoring={false}
        onPermanentlyDelete={() => undefined}
        onRestore={() => undefined}
      />,
    );

    expect(markup).toContain("No archived chats");
    expect(
      archivedChatRecoveryLabel(
        "2026-08-26T12:00:00.000Z",
        Date.parse("2026-08-25T12:00:00.000Z"),
      ),
    ).toBe("Deletes in 1 day");
  });
});
