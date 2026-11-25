import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  APP_TOAST_AUTO_DISMISS_MS,
  type AppToastInput,
} from "@/components/ui/app-toast";
import {
  claimCouncilNotification,
  getCouncilPendingNotifications,
} from "@/lib/api/council-notifications";
import { openChatMessageOpaqueSummary } from "@/lib/chat-message-encryption";
import {
  councilNotificationsEnabled,
  useCouncilNotificationPreference,
} from "@/lib/council-notification-preference";

const queryKey = ["council-notifications"];

function available() {
  return (
    document.visibilityState === "visible" ||
    (typeof Notification !== "undefined" &&
      Notification.permission === "granted")
  );
}

function subscribe(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  window.addEventListener("focus", callback);
  return () => {
    document.removeEventListener("visibilitychange", callback);
    window.removeEventListener("focus", callback);
  };
}

function showSystemNotification(messageId: string, href: string): boolean {
  if (
    document.visibilityState === "visible" ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return false;
  try {
    const notification = new Notification("Cantrip Council", {
      body: "A Council agent posted an update.",
      tag: `cantrip-council-${messageId}`,
    });
    notification.onclick = () => window.location.assign(href);
    return true;
  } catch {
    return false;
  }
}

export function useCouncilNotifications({
  enabled,
  live,
  onToast,
}: {
  enabled: boolean;
  live: boolean;
  onToast(toast: AppToastInput): void;
}) {
  const client = useQueryClient();
  const suitableClient = useSyncExternalStore(
    subscribe,
    available,
    () => false,
  );
  const preference = useCouncilNotificationPreference();
  const [cooldown, setCooldown] = useState(false);
  const busy = useRef(false);
  const active = enabled && suitableClient && preference;
  const pending = useQuery({
    queryKey,
    queryFn: getCouncilPendingNotifications,
    enabled: active,
    refetchInterval: live ? false : 10_000,
  });
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(
      () => setCooldown(false),
      APP_TOAST_AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const next = pending.data?.[0];
  useEffect(() => {
    if (!active || !next || cooldown || busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        const message = await openChatMessageOpaqueSummary(next);
        if (!available() || !councilNotificationsEnabled()) return;
        if (!(await claimCouncilNotification(message.id))) return;
        const href = `?${new URLSearchParams({ councilAgent: message.chatId, message: message.id })}`;
        if (!showSystemNotification(message.id, href)) {
          const text = message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(" ");
          const preview = [...text];
          onToast({
            title: "Cantrip Council",
            message:
              preview.length > 320
                ? `${preview.slice(0, 320).join("")}…`
                : text,
            tone: "info",
            href,
          });
        }
      } finally {
        busy.current = false;
        setCooldown(true);
        await client.invalidateQueries({ queryKey });
      }
    })().catch(() => undefined);
  }, [active, client, cooldown, next, onToast]);
}
