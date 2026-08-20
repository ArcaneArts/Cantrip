import { invoke } from "@tauri-apps/api/core";

import { isAppActionId, type AppActionId } from "@/lib/app-actions";

export const DESKTOP_APP_ACTION_EVENT = "cantrip://app-action";

export async function setDesktopAppActionAvailability(
  enabledActionIds: readonly AppActionId[],
): Promise<void> {
  await invoke("set_desktop_app_action_availability", {
    enabledActionIds,
  });
}

export async function observeDesktopAppActions(
  listener: (actionId: AppActionId) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<unknown>(DESKTOP_APP_ACTION_EVENT, ({ payload }) => {
    if (isAppActionId(payload)) listener(payload);
  });
}
