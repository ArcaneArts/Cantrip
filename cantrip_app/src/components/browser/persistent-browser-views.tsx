import type { BrowserFleetService, BrowserSummary } from "@cantrip/protocol";
import { useEffect, useState } from "react";
import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";
import { BrowserView } from "./browser-view";

export interface BrowserViewOwner {
  tabId: string;
  resourceId: string;
  browser?: BrowserSummary;
}

/** A resource query gap is not a close. Only authoritative ownership removes a view. */
export function reconcileBrowserOwners(
  previous: readonly BrowserViewOwner[],
  owned: readonly BrowserViewOwner[],
): BrowserViewOwner[] {
  const known = new Map(previous.map((owner) => [owner.tabId, owner]));
  return owned.map((owner) => ({
    ...owner,
    browser:
      owner.browser ??
      (known.get(owner.tabId)?.resourceId === owner.resourceId
        ? known.get(owner.tabId)?.browser
        : undefined),
  }));
}

export function PersistentBrowserViews({
  owners,
  selectedTabId,
  placements,
  fleetDiscovery,
  onOpenService,
  onPageState,
}: {
  owners: readonly BrowserViewOwner[];
  selectedTabId: string | null;
  placements?: readonly {
    tabId: string;
    paneId: string;
    portalTarget?: Element | null;
  }[];
  fleetDiscovery: boolean;
  onOpenService(
    browser: BrowserSummary,
    service: BrowserFleetService,
    paneId?: string,
  ): void;
  onPageState(
    browser: BrowserSummary,
    state: {
      previousTitle: string | null;
      title: string;
      url: string;
    },
  ): void;
}) {
  const [inlineHost, setInlineHost] = useState<HTMLDivElement | null>(null);
  const [retained, setRetained] = useState<readonly BrowserViewOwner[]>(owners);
  const rendered = reconcileBrowserOwners(retained, owners);
  useEffect(() => {
    setRetained((previous) => reconcileBrowserOwners(previous, owners));
  }, [owners]);
  return (
    <>
      <div className="contents" ref={setInlineHost} />
      {rendered.map(({ tabId, browser }) => {
        if (!browser) return null;
        const placement = placements?.find((entry) => entry.tabId === tabId);
        const visible = placements
          ? Boolean(placement && placement.portalTarget !== null)
          : selectedTabId === tabId;
        const content = (
          <div
            key={tabId}
            className={
              visible
                ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                : "hidden"
            }
            aria-hidden={!visible}
            data-slot="persistent-browser-surface"
            data-tab-id={tabId}
          >
            <BrowserView
              browser={browser}
              visible={visible}
              fleetDiscovery={fleetDiscovery}
              onOpenService={(service) =>
                onOpenService(browser, service, placement?.paneId)
              }
              onPageState={(state) => onPageState(browser, state)}
            />
          </div>
        );
        return (
          <PersistentSurfacePortal
            key={tabId}
            portalKey={tabId}
            host={placements ? (placement?.portalTarget ?? null) : inlineHost}
          >
            {content}
          </PersistentSurfacePortal>
        );
      })}
    </>
  );
}
