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

export function useStickyChatScroll(conversationId: string) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nearBottom = chatScrollIsNearBottom(viewport);
    followOutputRef.current = nearBottom;
    setShowScrollToBottom(
      !nearBottom && viewport.scrollHeight > viewport.clientHeight,
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followOutputRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    followOutputRef.current = true;
    setShowScrollToBottom(false);
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [conversationId, scrollToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const contentChanged = () => {
      if (followOutputRef.current) {
        scrollToBottom();
      } else {
        updateScrollState();
      }
    };
    const resizeObserver = new ResizeObserver(contentChanged);
    resizeObserver.observe(content);
    contentChanged();
    return () => resizeObserver.disconnect();
  }, [conversationId, scrollToBottom, updateScrollState]);

  return {
    contentRef,
    onScroll: updateScrollState,
    scrollToBottom,
    showScrollToBottom,
    viewportRef,
  };
}
