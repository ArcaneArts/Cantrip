import { describe, expect, it } from "vitest";

import { selectDefaultProjectTab } from "./default-project-tab";

const emptyTabs = {
  browsers: [],
  chats: [],
  codeTabs: [],
  explorers: [],
  terminals: [],
};

describe("default project tab selection", () => {
  it("leaves a dormant Remote Desktop tab unselected", () => {
    expect(
      selectDefaultProjectTab({
        ...emptyTabs,
        projectViews: [
          { id: "desktop-1", kind: "remote-desktop", position: 0 },
        ],
      }),
    ).toBeNull();
  });

  it("selects the first passive tab instead of an earlier Remote Desktop", () => {
    expect(
      selectDefaultProjectTab({
        ...emptyTabs,
        chats: [{ id: "chat-1", position: 4 }],
        projectViews: [
          { id: "desktop-1", kind: "remote-desktop", position: 0 },
          { id: "history-1", kind: "history", position: 7 },
        ],
      }),
    ).toEqual({ id: "chat-1", kind: "chat" });
  });
});
