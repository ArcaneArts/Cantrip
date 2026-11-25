import { useSyncExternalStore } from "react";

import { scopedClientStorageKey } from "./client-session";

const changed = "cantrip:council-notifications-preference";
function key() {
  return scopedClientStorageKey(changed);
}

export function councilNotificationsEnabled() {
  return window.localStorage.getItem(key()) !== "off";
}

export function setCouncilNotificationsEnabled(enabled: boolean) {
  window.localStorage.setItem(key(), enabled ? "on" : "off");
  window.dispatchEvent(new Event(changed));
}

function subscribe(callback: () => void) {
  window.addEventListener(changed, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(changed, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useCouncilNotificationPreference() {
  return useSyncExternalStore(
    subscribe,
    councilNotificationsEnabled,
    () => true,
  );
}
