import { useEffect, useRef } from "react";

export function readCouncilProjectSourceLink() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("councilProject");
  const chatId = params.get("projectChat");
  const messageId = params.get("message");
  const requestId = params.get("request");
  const task = params.get("task") === "true";
  if (!projectId || !chatId || (!messageId && !requestId && !task)) return null;
  return { projectId, chatId, messageId, requestId, task };
}

export function useCouncilProjectSourceLink({
  enabled,
  workspaceProjectId,
  selectProject,
  openCreatedTab,
  openProjectTask,
}: {
  enabled: boolean;
  workspaceProjectId: string | null;
  selectProject: (projectId: string) => void;
  openCreatedTab: (projectId: string, kind: "chat", chatId: string) => void;
  openProjectTask: (projectId: string, chatId: string) => void;
}) {
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const open = () => {
      const source = readCouncilProjectSourceLink();
      if (!source) {
        lastOpened.current = null;
        return;
      }
      const key = window.location.search;
      if (lastOpened.current === key) return;
      if (workspaceProjectId !== source.projectId) {
        selectProject(source.projectId);
        return;
      }
      lastOpened.current = key;
      if (source.task) openProjectTask(source.projectId, source.chatId);
      else openCreatedTab(source.projectId, "chat", source.chatId);
    };
    open();
    window.addEventListener("popstate", open);
    return () => window.removeEventListener("popstate", open);
  }, [
    enabled,
    openCreatedTab,
    openProjectTask,
    selectProject,
    workspaceProjectId,
  ]);
}
