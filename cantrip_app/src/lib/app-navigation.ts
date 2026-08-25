import type { AppMode } from "@cantrip/protocol";

export interface AppStartupNavigationInput {
  explicitIde: boolean;
  projectIds: readonly string[];
  savedChatId: string | null;
  savedMode: AppMode | null;
  savedProjectId: string | null;
  standaloneChatIds: readonly string[];
}

export interface AppStartupNavigation {
  mode: AppMode;
  projectId: string | null;
  standaloneChatId: string | null;
}

export function resolveAppStartupNavigation({
  explicitIde,
  projectIds,
  savedChatId,
  savedMode,
  savedProjectId,
  standaloneChatIds,
}: AppStartupNavigationInput): AppStartupNavigation {
  const projectId =
    (savedProjectId && projectIds.includes(savedProjectId)
      ? savedProjectId
      : null) ??
    projectIds[0] ??
    null;
  const standaloneChatId =
    savedChatId && standaloneChatIds.includes(savedChatId) ? savedChatId : null;

  if (explicitIde) {
    return { mode: "ide", projectId, standaloneChatId };
  }
  if (savedMode === "chat") {
    return { mode: "chat", projectId, standaloneChatId };
  }
  if (savedMode === "ide" && projectId) {
    return { mode: "ide", projectId, standaloneChatId };
  }
  return projectId
    ? { mode: "ide", projectId, standaloneChatId }
    : { mode: "chat", projectId: null, standaloneChatId };
}
