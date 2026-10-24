import { useCallback, useEffect, useRef, useState } from "react";

export const CHAT_FOLLOW_THRESHOLD_PX = 192;

export interface ChatScrollState {
  scrollTop: number;
  following: boolean;
}

type ScrollMetrics = Pick<
  HTMLElement,
  "clientHeight" | "scrollHeight" | "scrollTop"
>;

export function chatScrollDistanceFromBottom({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics): number {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function chatScrollIsNearBottom(
  metrics: ScrollMetrics,
  threshold = CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
  return chatScrollDistanceFromBottom(metrics) <= threshold;
}

export function useStickyScroll(
  conversationId: string,
  followThreshold = CHAT_FOLLOW_THRESHOLD_PX,
  latestEdge: "top" | "bottom" = "bottom",
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const restoredConversationRef = useRef<string | null>(null);
  const pendingRestorationRef = useRef<ChatScrollState | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const isNearLatest = useCallback(
    (viewport: ScrollMetrics) =>
      latestEdge === "top"
        ? viewport.scrollTop <= followThreshold
        : chatScrollIsNearBottom(viewport, followThreshold),
    [followThreshold, latestEdge],
  );

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nearLatest = isNearLatest(viewport);
    followOutputRef.current = nearLatest;
    setShowScrollToLatest(
      !nearLatest && viewport.scrollHeight > viewport.clientHeight,
    );
  }, [isNearLatest]);

  const scrollToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followOutputRef.current = true;
    viewport.scrollTop = latestEdge === "top" ? 0 : viewport.scrollHeight;
    setShowScrollToLatest(false);
  }, [latestEdge]);

  const pinToLatestIfFollowing = useCallback(() => {
    if (!followOutputRef.current) return;
    scrollToLatest();
  }, [scrollToLatest]);

  const captureScrollState = useCallback((): ChatScrollState => {
    if (pendingRestorationRef.current)
      return { ...pendingRestorationRef.current };
    const viewport = viewportRef.current;
    if (!viewport) throw new Error("The transcript viewport is not mounted.");
    return {
      scrollTop: Math.max(0, viewport.scrollTop),
      following: followOutputRef.current,
    };
  }, []);

  // Restore only after the destination transcript has loaded its required rows.
  // A mounted viewport alone does not prove that historical content is ready.
  const restoreScrollState = useCallback(
    (state: ChatScrollState) => {
      const viewport = viewportRef.current;
      if (!viewport) throw new Error("The transcript viewport is not mounted.");
      if (!Number.isFinite(state.scrollTop) || state.scrollTop < 0)
        throw new Error("Invalid transcript scroll position.");
      restoredConversationRef.current = conversationId;
      pendingRestorationRef.current =
        viewport.clientHeight === 0 ? state : null;
      followOutputRef.current = state.following;
      if (state.following) {
        scrollToLatest();
      } else {
        viewport.scrollTop = state.scrollTop;
        setShowScrollToLatest(viewport.scrollHeight > viewport.clientHeight);
      }
    },
    [conversationId, scrollToLatest],
  );

  const preserveScrollDuringPrepend = useCallback(
    async (action: () => Promise<unknown>) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        await action();
        return;
      }
      const wasNearLatest = isNearLatest(viewport);
      const previousTop = viewport.scrollTop;
      const content = contentRef.current;
      const viewportRect = viewport.getBoundingClientRect();
      const anchor =
        content &&
        [...content.children].find((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
          );
        });
      const previousAnchorTop = anchor
        ? anchor.getBoundingClientRect().top - viewportRect.top
        : undefined;
      await action();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const current = viewportRef.current;
            if (current === viewport) {
              if (wasNearLatest) {
                current.scrollTop =
                  latestEdge === "top" ? 0 : current.scrollHeight;
              } else if (
                anchor &&
                previousAnchorTop !== undefined &&
                contentRef.current === content &&
                content?.contains(anchor)
              ) {
                // A height delta also counts simultaneous appended output.
                // Measure the retained visible row; native browser anchoring
                // may already have compensated part or all of the prepend.
                current.scrollTop +=
                  anchor.getBoundingClientRect().top -
                  current.getBoundingClientRect().top -
                  previousAnchorTop;
              } else {
                current.scrollTop = previousTop;
              }
              updateScrollState();
            }
            resolve();
          });
        });
      });
    },
    [isNearLatest, latestEdge, updateScrollState],
  );

  useEffect(() => {
    if (restoredConversationRef.current === conversationId) return;
    restoredConversationRef.current = null;
    pendingRestorationRef.current = null;
    followOutputRef.current = true;
    setShowScrollToLatest(false);
    const frame = window.requestAnimationFrame(() => {
      if (restoredConversationRef.current !== conversationId) scrollToLatest();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationId, scrollToLatest]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const contentChanged = () => {
      const pending = pendingRestorationRef.current;
      if (pending) {
        if (viewport.clientHeight === 0) return;
        pendingRestorationRef.current = null;
        followOutputRef.current = pending.following;
        if (pending.following) scrollToLatest();
        else {
          viewport.scrollTop = pending.scrollTop;
          setShowScrollToLatest(viewport.scrollHeight > viewport.clientHeight);
        }
        return;
      }
      if (followOutputRef.current) {
        scrollToLatest();
      } else {
        updateScrollState();
      }
    };
    const resizeObserver = new ResizeObserver(contentChanged);
    resizeObserver.observe(content);
    resizeObserver.observe(viewport);
    contentChanged();
    return () => resizeObserver.disconnect();
  }, [conversationId, scrollToLatest, updateScrollState]);

  return {
    captureScrollState,
    restoreScrollState,
    contentRef,
    onScroll: updateScrollState,
    pinToLatestIfFollowing,
    preserveScrollDuringPrepend,
    scrollToLatest,
    showScrollToLatest,
    viewportRef,
  };
}

export function useStickyChatScroll(
  conversationId: string,
  followThreshold = CHAT_FOLLOW_THRESHOLD_PX,
) {
  const scroll = useStickyScroll(conversationId, followThreshold);
  return {
    captureScrollState: scroll.captureScrollState,
    restoreScrollState: scroll.restoreScrollState,
    contentRef: scroll.contentRef,
    onScroll: scroll.onScroll,
    pinToBottomIfFollowing: scroll.pinToLatestIfFollowing,
    preserveScrollDuringPrepend: scroll.preserveScrollDuringPrepend,
    scrollToBottom: scroll.scrollToLatest,
    showScrollToBottom: scroll.showScrollToLatest,
    viewportRef: scroll.viewportRef,
  };
}
