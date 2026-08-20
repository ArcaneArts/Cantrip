import { describe, expect, it } from "vitest";

import {
  APP_ACTION_IDS,
  appActionForKeyboardInput,
  availableAppActions,
  isAppActionId,
  projectIdForAppActionView,
  type AppActionContext,
} from "./app-actions";

const projectContext: AppActionContext = {
  projectId: "project-1",
};

function keyboard(
  key: string,
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) {
  return {
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: true,
    shiftKey: false,
    ...overrides,
  };
}

describe("application actions", () => {
  it("registers project actions for the command bar", () => {
    expect(
      availableAppActions(projectContext).map(({ id, label, shortcut }) => ({
        id,
        label,
        shortcut: shortcut.label,
      })),
    ).toEqual([
      {
        id: APP_ACTION_IDS.newAgentChat,
        label: "New Agent Chat",
        shortcut: "⌘N",
      },
      {
        id: APP_ACTION_IDS.newTerminal,
        label: "New Terminal",
        shortcut: "⌘T",
      },
    ]);
  });

  it("does not expose project actions without an active project", () => {
    expect(availableAppActions({ projectId: null })).toEqual([]);
    expect(
      appActionForKeyboardInput(keyboard("n"), { projectId: null }),
    ).toBeNull();
  });

  it("keeps project settings in project scope and excludes global screens", () => {
    expect(projectIdForAppActionView("project-1", "project-settings")).toBe(
      "project-1",
    );
    expect(projectIdForAppActionView("project-1", "project")).toBe("project-1");
    expect(projectIdForAppActionView("project-1", "global")).toBeNull();
    expect(
      projectIdForAppActionView("project-1", "project-creation"),
    ).toBeNull();
    expect(projectIdForAppActionView("project-1", "popout")).toBeNull();
  });

  it("maps primary-modifier shortcuts without stealing modified variants", () => {
    expect(appActionForKeyboardInput(keyboard("N"), projectContext)).toBe(
      APP_ACTION_IDS.newAgentChat,
    );
    expect(appActionForKeyboardInput(keyboard("t"), projectContext)).toBe(
      APP_ACTION_IDS.newTerminal,
    );
    expect(
      appActionForKeyboardInput(
        keyboard("t", { ctrlKey: true, metaKey: false }),
        projectContext,
      ),
    ).toBe(APP_ACTION_IDS.newTerminal);
    expect(
      appActionForKeyboardInput(
        keyboard("t", { shiftKey: true }),
        projectContext,
      ),
    ).toBeNull();
  });

  it("removes pending actions and validates native action identifiers", () => {
    expect(
      availableAppActions({
        pendingActionIds: new Set([APP_ACTION_IDS.newAgentChat]),
        projectId: "project-1",
      }).map(({ id }) => id),
    ).toEqual([APP_ACTION_IDS.newTerminal]);
    expect(isAppActionId(APP_ACTION_IDS.newTerminal)).toBe(true);
    expect(isAppActionId("project.delete")).toBe(false);
  });
});
