import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RemoteDesktopTarget } from "@cantrip/protocol";
import { getRemoteDesktop } from "@/lib/api";
import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";
import { ManagedRemoteDesktopView } from "./managed-remote-desktop-view";
import type { IncomingRemoteDesktopView } from "./remote-desktop-view-state";

interface Owner {
  tabId: string;
  resourceId: string;
  projectId: string;
}
interface Options {
  fleetDiscovery?: boolean;
  onOpenFleetTarget?(
    tabId: string,
    projectId: string,
    workerId: string,
    target: RemoteDesktopTarget,
  ): void;
}
function DesktopView({
  owner,
  incoming,
  fleetDiscovery,
  onOpenFleetTarget,
}: Options & {
  owner: Owner;
  incoming?: IncomingRemoteDesktopView;
}) {
  const query = useQuery({
    queryKey: ["remote-desktop", owner.resourceId],
    queryFn: () => getRemoteDesktop(owner.resourceId),
    initialData: incoming?.desktop,
    enabled: !incoming?.staging,
  });
  const desktop = incoming?.staging ? incoming.desktop : query.data;
  if (!desktop)
    return (
      <div role="status">
        {query.isError
          ? "Could not load remote desktop."
          : "Loading remote desktop…"}
      </div>
    );
  if (desktop.id !== owner.resourceId || desktop.projectId !== owner.projectId)
    return <div role="alert">Remote desktop does not belong to this view.</div>;
  return (
    <ManagedRemoteDesktopView
      desktop={desktop}
      transferTabId={owner.tabId}
      transferredState={incoming?.state}
      transferStaging={incoming?.staging}
      fleetDiscovery={fleetDiscovery}
      onOpenFleetTarget={(workerId, target) =>
        onOpenFleetTarget?.(owner.tabId, owner.projectId, workerId, target)
      }
    />
  );
}

/** A hidden owned tab keeps its renderer; only ownership removal disposes it. */
export function PersistentRemoteDesktopViews({
  owners,
  placements,
  selectedTabId,
  incomingViews,
  ...options
}: Options & {
  owners: readonly Owner[];
  selectedTabId: string | null;
  placements?: readonly { tabId: string; portalTarget?: Element | null }[];
  incomingViews?: readonly IncomingRemoteDesktopView[];
}) {
  const [inlineHost, setInlineHost] = useState<HTMLDivElement | null>(null);
  const allOwners = useMemo(() => {
    const merged = new Map(owners.map((owner) => [owner.tabId, owner]));
    for (const incoming of incomingViews ?? []) {
      const owned = merged.get(incoming.tabId);
      if (
        !owned ||
        (owned.resourceId === incoming.desktop.id &&
          owned.projectId === incoming.desktop.projectId)
      )
        merged.set(incoming.tabId, {
          tabId: incoming.tabId,
          resourceId: incoming.desktop.id,
          projectId: incoming.desktop.projectId,
        });
    }
    return [...merged.values()];
  }, [owners, incomingViews]);
  return (
    <>
      <div className="contents" ref={setInlineHost} />
      {allOwners.map((owner) => {
        const incoming = incomingViews?.find(
          (view) =>
            view.tabId === owner.tabId &&
            view.desktop.id === owner.resourceId &&
            view.desktop.projectId === owner.projectId,
        );
        const placement = placements?.find(
          (entry) => entry.tabId === owner.tabId,
        );
        const visible =
          !incoming?.staging &&
          (placements
            ? Boolean(placement?.portalTarget)
            : selectedTabId === owner.tabId);
        return (
          <PersistentSurfacePortal
            key={owner.tabId}
            portalKey={owner.tabId}
            host={placements ? (placement?.portalTarget ?? null) : inlineHost}
          >
            <div
              className={
                visible
                  ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  : "hidden"
              }
              aria-hidden={!visible}
              inert={!visible}
              data-slot="persistent-remote-desktop-surface"
              data-tab-id={owner.tabId}
            >
              <DesktopView
                key={JSON.stringify([owner.resourceId, owner.projectId])}
                owner={owner}
                incoming={incoming}
                {...options}
              />
            </div>
          </PersistentSurfacePortal>
        );
      })}
    </>
  );
}
