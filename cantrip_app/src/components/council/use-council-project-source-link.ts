import { useEffect, useRef } from "react";

export function readCouncilProjectSourceLink() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("councilProject");
  const chatId = params.get("projectChat");
  const messageId = params.get("message");
  const requestId = params.get("request");
  if (!projectId || !chatId || (!messageId && !requestId)) return null;
  return { projectId, chatId, messageId, requestId };
}

export function useCouncilProjectSourceLink(
  enabled: boolean,
  openCreatedTab: (projectId: string, kind: "chat", chatId: string) => void,
) {
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
      lastOpened.current = key;
      openCreatedTab(source.projectId, "chat", source.chatId);
    };
    open();
    window.addEventListener("popstate", open);
    return () => window.removeEventListener("popstate", open);
  }, [enabled, openCreatedTab]);
}
