import type { ChatMessage } from "@cantrip/protocol";
import { useEffect, useMemo, useState, type RefObject } from "react";

import { cn } from "@/lib/utils";

export const CHAT_HISTORY_RAIL_MIN_TURNS = 8;
export const CHAT_HISTORY_RAIL_MAX_LANDMARKS = 80;

export interface ChatHistoryLandmark {
  messageId: string;
  ordinal: number;
  position: number;
  strength: number;
  summary: string;
  title: string;
}

function compactText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " attachment ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipped(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function messageText(
  message: ChatMessage,
  phase: "commentary" | "final" | "user",
): string {
  return compactText(
    message.content
      .flatMap((item) => {
        if (item.type !== "text") return [];
        if (phase === "user") return [item.text];
        if (phase === "commentary") {
          return item.phase === "commentary" ? [item.text] : [];
        }
        return item.phase !== "commentary" ? [item.text] : [];
      })
      .join(" "),
  );
}

function userMessageTitle(message: ChatMessage): string {
  const text = messageText(message, "user");
  if (text) return clipped(text, 120);
  const attachments = message.content.flatMap((item) =>
    item.type === "attachment" ? [item.attachment.fileName] : [],
  );
  if (attachments.length > 0) {
    return clipped(`Attached ${attachments.join(", ")}`, 120);
  }
  return "User message";
}

function responseSummary(messages: readonly ChatMessage[]): string {
  const finalText = [...messages]
    .reverse()
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message, "final"))
    .find(Boolean);
  if (finalText) return clipped(finalText, 220);

  const commentary = [...messages]
    .reverse()
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message, "commentary"))
    .find(Boolean);
  if (commentary) return clipped(commentary, 220);

  const activityTypes = new Set(
    messages.flatMap((message) =>
      message.content.flatMap((item) =>
        item.type === "activity" ? [item.activity.type] : [],
      ),
    ),
  );
  const activity = [
    activityTypes.has("command") ? "ran commands" : null,
    activityTypes.has("fileChange") ? "changed files" : null,
    activityTypes.has("reasoning") ? "analyzed the task" : null,
  ].filter((part): part is string => part !== null);
  if (activity.length > 0) {
    return `The agent ${activity.join(", ")}.`;
  }
  return "Work in progress.";
}

function sampledIndexes(count: number): number[] {
  if (count <= CHAT_HISTORY_RAIL_MAX_LANDMARKS) {
    return Array.from({ length: count }, (_, index) => index);
  }
  const last = count - 1;
  const sampled = new Set<number>();
  for (let index = 0; index < CHAT_HISTORY_RAIL_MAX_LANDMARKS; index += 1) {
    sampled.add(
      Math.round((index / (CHAT_HISTORY_RAIL_MAX_LANDMARKS - 1)) * last),
    );
  }
  return [...sampled].sort((left, right) => left - right);
}

export function buildChatHistoryLandmarks(
  messages: readonly ChatMessage[],
): ChatHistoryLandmark[] {
  const turns: Array<{
    message: ChatMessage;
    responses: ChatMessage[];
  }> = [];

  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ message, responses: [] });
    } else {
      turns.at(-1)?.responses.push(message);
    }
  }

  if (turns.length < CHAT_HISTORY_RAIL_MIN_TURNS) return [];

  const indexes = sampledIndexes(turns.length);
  return indexes.map((turnIndex) => {
    const turn = turns[turnIndex]!;
    const responseCharacters = turn.responses.reduce(
      (total, response) =>
        total +
        response.content.reduce(
          (count, item) =>
            count + (item.type === "text" ? item.text.length : 80),
          0,
        ),
      0,
    );
    return {
      messageId: turn.message.id,
      ordinal: turnIndex + 1,
      position: turns.length === 1 ? 0 : turnIndex / (turns.length - 1),
      strength: Math.min(
        1,
        0.2 +
          Math.log2(responseCharacters + turn.responses.length * 80 + 1) / 12,
      ),
      summary: responseSummary(turn.responses),
      title: userMessageTitle(turn.message),
    };
  });
}

function tooltipPosition(position: number): string {
  if (position < 0.12) return "top-0";
  if (position > 0.88) return "bottom-0";
  return "top-1/2 -translate-y-1/2";
}

export function ChatHistoryRail({
  messages,
  viewportRef,
  withComposer,
}: {
  messages: readonly ChatMessage[];
  viewportRef: RefObject<HTMLDivElement | null>;
  withComposer: boolean;
}) {
  const landmarks = useMemo(
    () => buildChatHistoryLandmarks(messages),
    [messages],
  );
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || landmarks.length === 0) return;
    let frame: number | null = null;

    const updateActiveLandmark = () => {
      frame = null;
      const activationOffset =
        viewport.scrollTop + viewport.clientHeight * 0.28;
      let active = landmarks[0]!.messageId;
      const landmarkIds = new Set(
        landmarks.map((landmark) => landmark.messageId),
      );
      const anchors = viewport.querySelectorAll<HTMLElement>(
        "[data-chat-history-anchor]",
      );
      for (const anchor of anchors) {
        if (anchor.offsetTop > activationOffset) break;
        const messageId = anchor.dataset.chatHistoryAnchor;
        if (messageId && landmarkIds.has(messageId)) active = messageId;
      }
      setActiveMessageId((current) => (current === active ? current : active));
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateActiveLandmark);
    };

    viewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) {
      observer.observe(viewport.firstElementChild);
    }
    scheduleUpdate();
    return () => {
      viewport.removeEventListener("scroll", scheduleUpdate);
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [landmarks, viewportRef]);

  if (landmarks.length === 0) return null;

  const jumpTo = (messageId: string) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const anchor = [
      ...viewport.querySelectorAll<HTMLElement>("[data-chat-history-anchor]"),
    ].find((candidate) => candidate.dataset.chatHistoryAnchor === messageId);
    if (!anchor) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    viewport.scrollTo({
      behavior: reducedMotion ? "auto" : "smooth",
      top: Math.max(0, anchor.offsetTop - 24),
    });
  };

  return (
    <nav
      aria-label="Conversation history"
      data-elite-ignore=""
      className={cn(
        "pointer-events-none absolute left-1 top-6 z-20 hidden w-12 md:block",
        withComposer ? "bottom-64" : "bottom-10",
      )}
    >
      <div className="absolute inset-y-0 left-1 w-px bg-border/35" />
      {landmarks.map((landmark, index) => {
        const hoveredDistance =
          hoveredIndex === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(index - hoveredIndex);
        const wave = Math.max(0, 22 - hoveredDistance * 5);
        const active = activeMessageId === landmark.messageId;
        const lineWidth = 5 + landmark.strength * 8 + wave + (active ? 5 : 0);
        return (
          <button
            key={landmark.messageId}
            type="button"
            aria-label={`Jump to turn ${landmark.ordinal}: ${landmark.title}`}
            aria-current={active ? "location" : undefined}
            className="group/landmark pointer-events-auto absolute left-1 flex h-3 w-11 -translate-y-1/2 items-center outline-none"
            style={{ top: `${6 + landmark.position * 88}%` }}
            onBlur={() => setHoveredIndex(null)}
            onClick={() => jumpTo(landmark.messageId)}
            onFocus={() => setHoveredIndex(index)}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <span
              aria-hidden="true"
              className={cn(
                "block h-px origin-left rounded-full bg-muted-foreground/45 transition-[width,background-color] duration-150 motion-reduce:transition-none",
                active && "bg-foreground/80",
                hoveredIndex === index && "bg-foreground",
              )}
              style={{ width: `${lineWidth}px` }}
            />
            {hoveredIndex === index ? (
              <span
                className={cn(
                  "pointer-events-none absolute left-9 z-30 w-72 rounded-xl border bg-popover p-3 text-left text-popover-foreground opacity-0 shadow-xl backdrop-blur-xl transition-opacity duration-150 group-hover/landmark:opacity-100 group-focus-visible/landmark:opacity-100 motion-reduce:transition-none",
                  tooltipPosition(landmark.position),
                )}
              >
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Turn {landmark.ordinal}
                </span>
                <span className="mt-1 block line-clamp-2 text-xs font-medium leading-5">
                  {landmark.title}
                </span>
                <span className="mt-1 block line-clamp-3 text-xs leading-5 text-muted-foreground">
                  {landmark.summary}
                </span>
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
