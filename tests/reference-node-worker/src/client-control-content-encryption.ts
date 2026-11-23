import {
  clientNotificationContentSchema,
  type ClientNotificationContent,
} from "@cantrip/protocol/client-control-content";
import type { EndpointContentOpaque } from "@cantrip/protocol/endpoint-content";

import { protectWorkerEndpointContent } from "./endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export function protectWorkerClientNotification(input: {
  content: ClientNotificationContent;
  operationId: string;
  projectId: string;
  service: WorkerEncryptionService;
  workerId: string;
}): Promise<EndpointContentOpaque> {
  return protectWorkerEndpointContent({
    context: {
      domain: "client-control-content",
      serverId: input.service.serverIdentity(),
      workerId: input.workerId,
      scopeId: input.projectId,
      operationId: input.operationId,
      operation: "client.notify",
      direction: "event",
      sequence: 0,
    },
    content: input.content,
    schema: clientNotificationContentSchema,
    service: input.service,
  });
}
