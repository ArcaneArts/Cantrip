import type { ServerRepository } from "../../db/repository.js";
import { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import { serverLogger } from "../../logger.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { TunnelRuntimeChange } from "./tunnel-control-plane-runtime.js";

export interface DirectAttachmentRuntimeDependencies {
  bridge: LimitedWorkerCommandBus;
  repository: ServerRepository;
}

/**
 * Constructs direct-attachment coordination before live infrastructure exists
 * and exposes one late-bound tunnel lease publisher for the control plane.
 */
export function createDirectAttachmentRuntime({
  bridge,
  repository,
}: DirectAttachmentRuntimeDependencies) {
  let publishDirectTunnelLeaseChange = (_change: TunnelRuntimeChange): void =>
    undefined;
  const directAttachments = new DirectAttachmentCoordinator(
    bridge,
    serverLogger,
    {
      onLeaseFinalized: async (event) => {
        if (event.mode !== "direct-tunnel" || event.resourceKind !== "tunnel") {
          return;
        }
        const changed = await repository.finalizeDesktopTunnelDirectLease(
          event.ownerId,
          event.attachmentId,
          event.capabilityId,
          new Date(event.leaseExpiresAt),
        );
        if (changed) publishDirectTunnelLeaseChange(changed);
      },
      onLeaseRenewed: async (event) => {
        if (event.mode !== "direct-tunnel" || event.resourceKind !== "tunnel") {
          return;
        }
        const changed = await repository.renewDesktopTunnelDirectLease(
          event.ownerId,
          event.attachmentId,
          event.capabilityId,
          new Date(event.leaseExpiresAt),
        );
        if (changed) publishDirectTunnelLeaseChange(changed);
      },
    },
  );

  return {
    directAttachments,
    setPublishDirectTunnelLeaseChange(
      publish: (change: TunnelRuntimeChange) => void,
    ): void {
      publishDirectTunnelLeaseChange = publish;
    },
  };
}
