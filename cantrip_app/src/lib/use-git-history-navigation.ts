import { useCallback, useEffect, useState } from "react";
import {
  parseGitHistoryRoute,
  type GitHistoryRouteState,
} from "./git-history-navigation";

/** Keep navigation pending until its focused History pane is ready to restore it. */
export function useGitHistoryNavigation() {
  const [request, setRequest] = useState<GitHistoryRouteState | null>(() => {
    const route = parseGitHistoryRoute(window.location.search);
    return route.projectId && route.worktreeId ? route : null;
  });

  useEffect(() => {
    const restore = () =>
      setRequest(parseGitHistoryRoute(window.location.search));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const complete = useCallback((handled: GitHistoryRouteState) => {
    // A newer navigation must survive a completion from the previous render.
    setRequest((current) => (current === handled ? null : current));
  }, []);

  return { request, complete };
}
