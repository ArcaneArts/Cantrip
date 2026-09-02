import type { ChatMessage } from "@cantrip/protocol";
import { useEffect, useMemo, useState, type RefObject } from "react";

import { editableMessageText } from "@/components/chat/latest-message-edit";
import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  EliteReveal,
  type EliteRevealConfig,
} from "@cantrip/glitch";

const CHAT_TURN_PROMPT_MAX_LENGTH = 280;

export const CHAT_TURN_PROMPT_GLITCH_CONFIG: EliteRevealConfig = {
  ...DEFAULT_ELITE_REVEAL_CONFIG,
  glitchCountMax: 5,
  glitchCountMin: 3,
  glitchShowMs: 16,
  staggerSpreadMs: 0,
  variants: ["outline", "chromatic", "spatial-shift", "scanline"],
};

export interface ChatTurnPromptAnchor {
  height: number;
  messageId: string;
  offsetTop: number;
}

export interface ChatTurnPromptPosition {
  messageId: string | null;
  visible: boolean;
}

const hiddenPromptPosition: ChatTurnPromptPosition = {
  messageId: null,
  visible: false,
};

export function activeChatTurnPrompt(
  anchors: readonly ChatTurnPromptAnchor[],
  scrollTop: number,
): ChatTurnPromptPosition {
  let active: ChatTurnPromptAnchor | null = null;
  for (const anchor of anchors) {
    if (anchor.offsetTop > scrollTop) break;
    active = anchor;
  }
  if (!active) return hiddenPromptPosition;
  return {
    messageId: active.messageId,
    visible: active.offsetTop + active.height <= scrollTop,
  };
}

export function chatTurnPromptSummary(message: ChatMessage): string {
  const text = editableMessageText(message).replace(/\s+/gu, " ").trim();
  const attachmentNames = message.content.flatMap((item) =>
    item.type === "attachment" ? [item.attachment.fileName] : [],
  );
  const summary =
    text ||
    (attachmentNames.length > 0
      ? `Attached ${attachmentNames.join(", ")}`
      : "User message");
  if (summary.length <= CHAT_TURN_PROMPT_MAX_LENGTH) return summary;
  return `${summary.slice(0, CHAT_TURN_PROMPT_MAX_LENGTH - 1).trimEnd()}…`;
}

export function chatTurnPromptOverlayPreferenceEnabled(
  preference: boolean | undefined,
): boolean {
  return preference ?? true;
}

export function useChatTurnPromptOverlay({
  chatId,
  contentRef,
  enabled,
  messages,
  viewportRef,
}: {
  chatId: string;
  contentRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  messages: readonly ChatMessage[];
  viewportRef: RefObject<HTMLDivElement | null>;
}): { message: ChatMessage | null; visible: boolean } {
  const userMessages = useMemo(
    () =>
      enabled ? messages.filter((message) => message.role === "user") : [],
    [enabled, messages],
  );
  const userMessageIdsKey = useMemo(
    () => userMessages.map((message) => message.id).join("\u0000"),
    [userMessages],
  );
  const messageById = useMemo(
    () => new Map(userMessages.map((message) => [message.id, message])),
    [userMessages],
  );
  const [position, setPosition] =
    useState<ChatTurnPromptPosition>(hiddenPromptPosition);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || !userMessageIdsKey) {
      setPosition(hiddenPromptPosition);
      return;
    }

    const userMessageIds = new Set(userMessageIdsKey.split("\u0000"));
    let anchors: ChatTurnPromptAnchor[] = [];
    let activeFrame: number | null = null;
    let layoutFrame: number | null = null;

    const updatePosition = () => {
      const next = activeChatTurnPrompt(anchors, viewport.scrollTop);
      setPosition((current) => {
        if (!next.messageId) {
          return current.messageId && userMessageIds.has(current.messageId)
            ? { ...current, visible: false }
            : hiddenPromptPosition;
        }
        if (
          current.messageId === next.messageId &&
          current.visible === next.visible
        ) {
          return current;
        }
        return next;
      });
    };
    const measureAnchors = () => {
      layoutFrame = null;
      const viewportRect = viewport.getBoundingClientRect();
      anchors = [
        ...viewport.querySelectorAll<HTMLElement>("[data-chat-history-anchor]"),
      ]
        .flatMap((anchor) => {
          const messageId = anchor.dataset.chatHistoryAnchor;
          if (!messageId || !userMessageIds.has(messageId)) return [];
          const rect = anchor.getBoundingClientRect();
          return [
            {
              height: rect.height,
              messageId,
              offsetTop: rect.top - viewportRect.top + viewport.scrollTop,
            },
          ];
        })
        .sort((left, right) => left.offsetTop - right.offsetTop);
      updatePosition();
    };
    const runActiveUpdate = () => {
      activeFrame = null;
      updatePosition();
    };
    const scheduleActiveUpdate = () => {
      if (activeFrame !== null) return;
      activeFrame = window.requestAnimationFrame(runActiveUpdate);
    };
    const scheduleLayoutMeasurement = () => {
      if (layoutFrame !== null) return;
      layoutFrame = window.requestAnimationFrame(measureAnchors);
    };

    viewport.addEventListener("scroll", scheduleActiveUpdate, {
      passive: true,
    });
    const observer = new ResizeObserver(scheduleLayoutMeasurement);
    observer.observe(viewport);
    observer.observe(content);
    scheduleLayoutMeasurement();
    return () => {
      viewport.removeEventListener("scroll", scheduleActiveUpdate);
      observer.disconnect();
      if (activeFrame !== null) window.cancelAnimationFrame(activeFrame);
      if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
    };
  }, [chatId, contentRef, userMessageIdsKey, viewportRef]);

  return {
    message:
      enabled && position.messageId
        ? (messageById.get(position.messageId) ?? null)
        : null,
    visible: enabled && position.visible,
  };
}

export function ChatTurnPromptOverlay({
  eliteModeEnabled,
  message,
  visible,
}: {
  eliteModeEnabled: boolean;
  message: ChatMessage | null;
  visible: boolean;
}) {
  if (!message || !visible) return null;
  const summary = chatTurnPromptSummary(message);
  const promptCard = (
    <div className="w-full rounded-xl border border-primary/35 bg-background/75 px-4 py-2 shadow-xl ring-1 ring-primary/10 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/65">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Current prompt
      </p>
      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-foreground/90">
        {summary}
      </p>
    </div>
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-30 px-4 pt-2 sm:px-8 md:px-10"
      data-chat-turn-prompt-overlay=""
    >
      {eliteModeEnabled ? (
        <EliteReveal
          className="mx-auto max-w-5xl"
          config={CHAT_TURN_PROMPT_GLITCH_CONFIG}
          contentKind="box"
          key={`${message.id}:${summary}`}
          replayKey={0}
        >
          {promptCard}
        </EliteReveal>
      ) : (
        <div className="mx-auto max-w-5xl">{promptCard}</div>
      )}
    </div>
  );
}
