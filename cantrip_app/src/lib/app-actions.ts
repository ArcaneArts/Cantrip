export const APP_ACTION_IDS = {
  newAgentChat: "project.new-agent-chat",
  newTerminal: "project.new-terminal",
} as const;

export type AppActionId = (typeof APP_ACTION_IDS)[keyof typeof APP_ACTION_IDS];

export type AppActionDescriptor = {
  category: "Project";
  id: AppActionId;
  keywords: readonly string[];
  label: string;
  requiresProject: true;
  shortcut: {
    key: "n" | "t";
    label: "⌘N" | "⌘T";
  };
};

/**
 * Canonical application action registry. Native menus, keyboard shortcuts,
 * and the future Shift-Shift command bar all consume this same collection.
 */
export const APP_ACTIONS = [
  {
    category: "Project",
    id: APP_ACTION_IDS.newAgentChat,
    keywords: ["agent", "chat", "new"],
    label: "New Agent Chat",
    requiresProject: true,
    shortcut: { key: "n", label: "⌘N" },
  },
  {
    category: "Project",
    id: APP_ACTION_IDS.newTerminal,
    keywords: ["shell", "terminal", "new"],
    label: "New Terminal",
    requiresProject: true,
    shortcut: { key: "t", label: "⌘T" },
  },
] as const satisfies readonly AppActionDescriptor[];

export type AppActionContext = {
  pendingActionIds?: ReadonlySet<AppActionId>;
  projectId: string | null;
};

export type AppActionView =
  "global" | "popout" | "project" | "project-creation" | "project-settings";

export type AppActionKeyboardInput = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

const actionIds = new Set<AppActionId>(APP_ACTIONS.map(({ id }) => id));

export function isAppActionId(value: unknown): value is AppActionId {
  return typeof value === "string" && actionIds.has(value as AppActionId);
}

export function projectIdForAppActionView(
  projectId: string | null,
  view: AppActionView,
): string | null {
  return view === "project" || view === "project-settings" ? projectId : null;
}

export function availableAppActions(
  context: AppActionContext,
): readonly AppActionDescriptor[] {
  return APP_ACTIONS.filter(
    (action) =>
      (!action.requiresProject || context.projectId !== null) &&
      !context.pendingActionIds?.has(action.id),
  );
}

export function appActionForKeyboardInput(
  input: AppActionKeyboardInput,
  context: AppActionContext,
): AppActionId | null {
  if (input.altKey || input.shiftKey || input.metaKey === input.ctrlKey) {
    return null;
  }
  const key = input.key.toLowerCase();
  return (
    availableAppActions(context).find((action) => action.shortcut.key === key)
      ?.id ?? null
  );
}
