import {
  protectedTunnelContentRecordSchema,
  tunnelContentRecordSchema,
  type ProtectedTunnelContentRecord,
  type TunnelContentRecord,
} from "@cantrip/protocol/tunnel-content";

import { openWorkerEndpointContent } from "./endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const TUNNEL_RECORD_OPERATION = "tunnel.record";

export async function openWorkerTunnelContentRecord(input: {
  record: ProtectedTunnelContentRecord;
  serverId: string;
  service: WorkerEncryptionService;
  tunnelId: string;
  workerId: string;
}): Promise<TunnelContentRecord> {
  const record = protectedTunnelContentRecordSchema.parse(input.record);
  return openWorkerEndpointContent({
    context: {
      domain: "tunnel-content",
      serverId: input.serverId,
      workerId: input.workerId,
      scopeId: JSON.stringify(["tunnel", input.tunnelId]),
      operationId: record.operationId,
      operation: TUNNEL_RECORD_OPERATION,
      direction: "stored",
      sequence: record.revision,
    },
    opaque: record.protectedContent,
    schema: tunnelContentRecordSchema,
    service: input.service,
  });
}
