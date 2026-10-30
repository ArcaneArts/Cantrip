import { useDraggable } from "@dnd-kit/core";
import { useEffect, useRef, type ComponentProps } from "react";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";
import type { WorkspaceDndData } from "@/lib/workspace-dnd-model";

/** Catalog rows carry resource identity, never a fabricated source tab/pane. */
export function ConversationRowButton({
  projectId,
  chatId,
  title,
  placementEnabled,
  onClick,
  onPointerDown,
  onKeyDown,
  ...props
}: ComponentProps<"button"> & {
  projectId: string;
  chatId: string;
  title: string;
  placementEnabled: boolean;
}) {
  const identity = getClientSessionIdentitySnapshot();
  const drag = useDraggable({
    id: `conversation:${projectId}:${chatId}`,
    disabled: !placementEnabled || !identity,
    data: identity
      ? ({
          drag: {
            type: "conversation",
            projectId,
            chatId,
            identity,
            label: title,
            visualKind: "chat",
          },
        } satisfies WorkspaceDndData)
      : undefined,
  });
  const dragged = useRef(false);
  useEffect(() => {
    if (drag.isDragging) dragged.current = true;
  }, [drag.isDragging]);
  return (
    <button
      {...props}
      {...drag.attributes}
      ref={drag.setNodeRef}
      onPointerDown={(event) => {
        dragged.current = false;
        onPointerDown?.(event);
        if (!event.defaultPrevented) drag.listeners?.onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") dragged.current = false;
        onKeyDown?.(event);
      }}
      onClick={(event) => {
        if (dragged.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
