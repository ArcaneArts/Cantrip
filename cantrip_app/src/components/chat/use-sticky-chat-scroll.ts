import { useCallback, useEffect, useRef, useState } from "react";

export const CHAT_FOLLOW_THRESHOLD_PX = 192;

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

  const preserveScrollDuringPrepend = useCallback(
    async (action: () => Promise<unknown>) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        await action();
        return;
      }
      const wasNearLatest = isNearLatest(viewport);
      const previousHeight = viewport.scrollHeight;
      const previousTop = viewport.scrollTop;
      await action();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const current = viewportRef.current;
            if (current) {
              if (wasNearLatest) {
                current.scrollTop =
                  latestEdge === "top" ? 0 : current.scrollHeight;
              } else {
                current.scrollTop =
                  previousTop + (current.scrollHeight - previousHeight);
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
    followOutputRef.current = true;
    setShowScrollToLatest(false);
    const frame = window.requestAnimationFrame(scrollToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [conversationId, scrollToLatest]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const contentChanged = () => {
      if (followOutputRef.current) {
        scrollToLatest();
      } else {
        updateScrollState();
      }
    };
    const resizeObserver = new ResizeObserver(contentChanged);
    resizeObserver.observe(content);
    contentChanged();
    return () => resizeObserver.disconnect();
  }, [conversationId, scrollToLatest, updateScrollState]);

  return {
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
    contentRef: scroll.contentRef,
    onScroll: scroll.onScroll,
    pinToBottomIfFollowing: scroll.pinToLatestIfFollowing,
    preserveScrollDuringPrepend: scroll.preserveScrollDuringPrepend,
    scrollToBottom: scroll.scrollToLatest,
    showScrollToBottom: scroll.showScrollToLatest,
    viewportRef: scroll.viewportRef,
  };
}
