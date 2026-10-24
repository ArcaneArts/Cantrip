import type { ChatSummary } from "@cantrip/protocol";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IncomingChatView } from "./chat-view-state";
import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";

export interface ChatViewOwner {
  tabId: string;
  resourceId: string;
  chat?: ChatSummary;
}

/** Query loading is not a tab close. Never reuse a different resource's cache. */
export function reconcileChatViewOwners(
  previous: readonly ChatViewOwner[],
  owned: readonly ChatViewOwner[],
): ChatViewOwner[] {
  const known = new Map(previous.map((owner) => [owner.tabId, owner]));
  return owned.map((owner) => ({
    ...owner,
    chat:
      owner.chat ??
      (known.get(owner.tabId)?.resourceId === owner.resourceId
        ? known.get(owner.tabId)?.chat
        : undefined),
  }));
}

/** A chat's server execution outlives its view. This owner only retains UI state. */
export function PersistentChatViews({
  owners,
  selectedTabId,
  placements,
  incomingViews,
  renderChat,
}: {
  owners: readonly ChatViewOwner[];
  selectedTabId: string | null;
  placements?: readonly { tabId: string; portalTarget?: Element | null }[];
  incomingViews?: readonly IncomingChatView[];
  renderChat(
    chat: ChatSummary,
    tabId: string,
    visible: boolean,
    incoming?: IncomingChatView,
  ): ReactNode;
}) {
  const [inlineHost, setInlineHost] = useState<HTMLDivElement | null>(null);
  const [retained, setRetained] = useState<readonly ChatViewOwner[]>(owners);
  const allOwners = useMemo(() => {
    const merged = new Map(owners.map((owner) => [owner.tabId, owner]));
    for (const incoming of incomingViews ?? []) {
      const owned = merged.get(incoming.tabId);
      // A stale transfer must never replace a newly assigned resource.
      if (!owned || owned.resourceId === incoming.chat.id)
        merged.set(incoming.tabId, {
          tabId: incoming.tabId,
          resourceId: incoming.chat.id,
          chat: owned?.chat ?? incoming.chat,
        });
    }
    return [...merged.values()];
  }, [owners, incomingViews]);
  const rendered = reconcileChatViewOwners(retained, allOwners);
  useEffect(() => {
    setRetained((previous) => reconcileChatViewOwners(previous, allOwners));
  }, [allOwners]);
  return (
    <>
      <div className="contents" ref={setInlineHost} />
      {rendered.map(({ tabId, resourceId, chat }) => {
        const incoming = incomingViews?.find(
          (view) => view.tabId === tabId && view.chat.id === resourceId,
        );
        const placement = placements?.find((entry) => entry.tabId === tabId);
        const visible =
          !incoming?.staging &&
          (placements
            ? Boolean(placement?.portalTarget)
            : selectedTabId === tabId);
        return (
          <PersistentSurfacePortal
            key={tabId}
            portalKey={tabId}
            host={placements ? (placement?.portalTarget ?? null) : inlineHost}
          >
            <div
              className={
                visible
                  ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  : "hidden"
              }
              aria-hidden={!visible}
              inert={Boolean(incoming?.staging)}
              data-slot="persistent-chat-surface"
              data-tab-id={tabId}
            >
              {chat ? (
                <div key={resourceId} className="contents">
                  {renderChat(chat, tabId, visible, incoming)}
                </div>
              ) : (
                <div role="status">Loading chat…</div>
              )}
            </div>
          </PersistentSurfacePortal>
        );
      })}
    </>
  );
}
