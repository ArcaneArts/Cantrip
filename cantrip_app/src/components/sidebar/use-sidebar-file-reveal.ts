import { useEffect, useState } from "react";
import {
  sidebarFileRevealEvent,
  type SidebarFileReveal,
} from "@/lib/sidebar-file-reveal";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
export function useSidebarFileReveal(
  projectId: string | null,
  selectedViewId: string | undefined,
  reveal: () => void,
) {
  const [request, setRequest] = useState<{
    target: SidebarFileReveal;
    selectedViewId: string | undefined;
    identity: ClientSessionIdentitySnapshot;
  } | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      const target = (event as CustomEvent<SidebarFileReveal>).detail;
      const identity = getClientSessionIdentitySnapshot();
      if (!identity || target.projectId !== projectId) return;
      setRequest({ target, selectedViewId, identity });
      reveal();
    };
    window.addEventListener(sidebarFileRevealEvent, listener);
    return () => window.removeEventListener(sidebarFileRevealEvent, listener);
  }, [projectId, selectedViewId, reveal]);
  return request &&
    request.target.projectId === projectId &&
    request.selectedViewId === selectedViewId &&
    clientSessionIdentityMatches(request.identity)
    ? request.target
    : null;
}
