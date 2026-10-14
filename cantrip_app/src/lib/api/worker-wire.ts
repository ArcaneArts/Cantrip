import {
  workerListSchema,
  workerEncryptionRefreshResultSchema,
  workerEncryptionRefreshRequestSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import type { WorkerEncryptionRefreshRequest } from "@cantrip/protocol";

export async function getWorkers() {
  return workerListSchema.parse(await request("/api/workers"));
}

export async function refreshWorkerEncryption(
  workerId: string,
  input: WorkerEncryptionRefreshRequest,
) {
  return workerEncryptionRefreshResultSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/encryption/refresh`,
      workerEncryptionRefreshRequestSchema.parse(input),
    ),
  );
}
