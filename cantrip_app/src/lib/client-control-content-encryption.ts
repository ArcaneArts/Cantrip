import {
  clientNotificationContentSchema,
  type ClientNotificationContent,
} from "@cantrip/protocol/client-control-content";

import { openEndpointContent } from "./endpoint-content-encryption";

export function openClientNotification(input: {
  opaque: unknown;
  operationId: string;
  projectId: string;
  workerId: string;
}): Promise<ClientNotificationContent> {
  return openEndpointContent({
    context: {
      domain: "client-control-content",
      workerId: input.workerId,
      scopeId: input.projectId,
      operationId: input.operationId,
      operation: "client.notify",
      direction: "event",
      sequence: 0,
    },
    opaque: input.opaque,
    schema: clientNotificationContentSchema,
  });
}
