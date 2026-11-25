import {
  councilNotificationClaimSchema,
  councilPendingNotificationsSchema,
} from "@cantrip/protocol";

import { post, request } from "@/lib/api-client";

export async function getCouncilPendingNotifications() {
  return councilPendingNotificationsSchema.parse(
    await request("/api/council/notifications"),
  );
}

export async function claimCouncilNotification(messageId: string) {
  const payload = councilNotificationClaimSchema.parse(
    await post(
      `/api/council/notifications/${encodeURIComponent(messageId)}/claim`,
      {},
    ),
  );
  return payload.claimed;
}
