import { encryptedLinkedConsoleCreateSchema } from "@cantrip/protocol";
import { encodePrivateDisplayLabelForWorker } from "./private-label-encryption.js";
import { encodeSurfacePrivateStateForWorker } from "./surface-private-state-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

/** Worker seals the fixed empty console state; no prompt or terminal input. */
export async function prepareManagedConsoleState(
  terminalId: string,
  serverId: string,
  service: WorkerEncryptionService,
) {
  const ownerId = service.ownerId();
  const [titleProtection, stateProtection] = await Promise.all([
    encodePrivateDisplayLabelForWorker({
      ownerId,
      rowId: terminalId,
      recordKind: "terminal",
      label: "Console",
      service,
    }),
    encodeSurfacePrivateStateForWorker({
      ownerId,
      context: {
        serverId,
        resource: "terminal-row",
        resourceId: terminalId,
        operationId: null,
        recordKind: "terminal-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "terminal-state" },
        directory: { kind: "project-root" },
        serviceCommand: "",
      },
      service,
    }),
  ]);
  return encryptedLinkedConsoleCreateSchema.parse({
    id: terminalId,
    titleProtection,
    stateProtection,
  });
}
