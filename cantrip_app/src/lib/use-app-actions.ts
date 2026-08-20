import { useEffect, useMemo, useRef } from "react";

import {
  appActionForKeyboardInput,
  availableAppActions,
  type AppActionContext,
  type AppActionId,
} from "@/lib/app-actions";
import {
  observeDesktopAppActions,
  setDesktopAppActionAvailability,
} from "@/lib/desktop-app-actions";

export type AppActionRuntime = "browser" | "desktop" | "disabled";

export function useAppActions({
  context,
  onAction,
  runtime,
}: {
  context: AppActionContext;
  onAction(actionId: AppActionId): void;
  runtime: AppActionRuntime;
}): void {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const availableActionIds = useMemo(
    () => availableAppActions(context).map(({ id }) => id),
    [context],
  );
  const availabilityKey = availableActionIds.join("|");

  useEffect(() => {
    if (runtime !== "desktop") return;
    void setDesktopAppActionAvailability(availableActionIds).catch(
      () => undefined,
    );
  }, [availabilityKey, runtime]);

  useEffect(() => {
    if (runtime === "disabled") return;
    const available = new Set(availableActionIds);
    if (runtime === "browser") {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.repeat || event.defaultPrevented) return;
        const actionId = appActionForKeyboardInput(event, context);
        if (!actionId) return;
        event.preventDefault();
        onActionRef.current(actionId);
      };
      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }

    let active = true;
    let stop: (() => void) | null = null;
    void observeDesktopAppActions((actionId) => {
      if (active && available.has(actionId)) onActionRef.current(actionId);
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [availabilityKey, context, runtime]);
}
