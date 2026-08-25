import { describe, expect, it } from "vitest";

import { resolveAppStartupNavigation } from "./app-navigation";

describe("application startup navigation", () => {
  it("gives an explicit IDE destination precedence", () => {
    expect(
      resolveAppStartupNavigation({
        explicitIde: true,
        projectIds: ["project-a"],
        savedChatId: "chat-a",
        savedMode: "chat",
        savedProjectId: null,
        standaloneChatIds: ["chat-a"],
      }),
    ).toEqual({
      mode: "ide",
      projectId: "project-a",
      standaloneChatId: "chat-a",
    });
  });

  it("restores Chat without selecting an unrelated conversation", () => {
    expect(
      resolveAppStartupNavigation({
        explicitIde: false,
        projectIds: ["project-a"],
        savedChatId: "archived-chat",
        savedMode: "chat",
        savedProjectId: "project-a",
        standaloneChatIds: ["chat-b"],
      }),
    ).toEqual({
      mode: "chat",
      projectId: "project-a",
      standaloneChatId: null,
    });
  });

  it("defaults to IDE with projects and Chat without them", () => {
    expect(
      resolveAppStartupNavigation({
        explicitIde: false,
        projectIds: ["project-a"],
        savedChatId: null,
        savedMode: null,
        savedProjectId: null,
        standaloneChatIds: [],
      }).mode,
    ).toBe("ide");
    expect(
      resolveAppStartupNavigation({
        explicitIde: false,
        projectIds: [],
        savedChatId: "chat-a",
        savedMode: "ide",
        savedProjectId: null,
        standaloneChatIds: ["chat-a"],
      }),
    ).toEqual({
      mode: "chat",
      projectId: null,
      standaloneChatId: "chat-a",
    });
  });

  it("falls back to the first visible project when the saved IDE project is invalid", () => {
    expect(
      resolveAppStartupNavigation({
        explicitIde: false,
        projectIds: ["project-in-saved-workspace", "project-b"],
        savedChatId: null,
        savedMode: "ide",
        savedProjectId: "removed-project",
        standaloneChatIds: [],
      }),
    ).toEqual({
      mode: "ide",
      projectId: "project-in-saved-workspace",
      standaloneChatId: null,
    });
  });
});
