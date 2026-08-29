import { PROJECT_SHARE_STATE_STALE_CODE } from "@cantrip/protocol";

import { CantripApiError } from "@/lib/api-client";

export { PROJECT_SHARE_STATE_STALE_CODE };

export async function recoverStaleProjectShareState<T>(operations: {
  open(): Promise<T>;
  revokeOrphan(): Promise<void>;
}): Promise<T> {
  try {
    return await operations.open();
  } catch (error) {
    if (
      !(error instanceof CantripApiError) ||
      error.status !== 409 ||
      error.code !== PROJECT_SHARE_STATE_STALE_CODE
    ) {
      throw error;
    }
  }

  await operations.revokeOrphan();
  return operations.open();
}
