import type { AppLiveResource } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import type { CodeTunnelBroker } from "../../code/tunnel.js";
import type { ServerRepository } from "../../db/repository.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import type { RelayQuotaManager } from "../../operations/relay-quotas.js";
import type { ProjectShareTunnelBroker } from "../../project-shares/tunnel.js";
import { TunnelStreamBroker } from "../../tunnels/broker.js";
import { TunnelRuntimeManager } from "../../tunnels/runtime.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import { TUNNEL_ATTACHMENT_EXPIRY_SWEEP_MS } from "../shared/constants.js";

export interface TunnelRuntimeChange {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}

export interface TunnelControlPlaneRuntimeDependencies {
  accountUsageMeter: AccountUsageMeter;
  app: Pick<FastifyInstance, "log">;
  bridge: LimitedWorkerCommandBus;
  codeTunnel: CodeTunnelBroker;
  directAttachments: DirectAttachmentCoordinator;
  projectShareTunnel: ProjectShareTunnelBroker;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  relayQuotas: RelayQuotaManager;
  repository: ServerRepository;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
  setPublishDirectTunnelLeaseChange(
    publish: (change: TunnelRuntimeChange) => void,
  ): void;
}

/** Owns tunnel publication, brokers, control-plane binding, and expiry sweep. */
export function createTunnelControlPlaneRuntime({
  accountUsageMeter,
  app,
  bridge,
  codeTunnel,
  directAttachments,
  projectShareTunnel,
  publishLiveInvalidation,
  relayQuotas,
  repository,
  runAsOwner,
  setPublishDirectTunnelLeaseChange,
}: TunnelControlPlaneRuntimeDependencies) {
  const publishTunnelRuntimeChange = (change: TunnelRuntimeChange): void => {
    runAsOwner(change.ownerId, () => {
      publishLiveInvalidation("tunnel", {
        entityId: change.tunnelId,
        projectId: change.projectId,
      });
    });
  };
  setPublishDirectTunnelLeaseChange(publishTunnelRuntimeChange);
  const tunnelStreamBroker = new TunnelStreamBroker({
    consumeRelayBytes: (ownerId, workerId, bytes) =>
      relayQuotas.consumeRelay(ownerId, workerId, bytes),
    onActivity: (tunnelId, attachmentId, authoritativeRootRequired) =>
      !authoritativeRootRequired ||
      codeTunnel.allowRelayAttachmentActivity(attachmentId, tunnelId),
  });
  const tunnelRuntime = new TunnelRuntimeManager(
    repository,
    bridge,
    publishTunnelRuntimeChange,
    tunnelStreamBroker,
    accountUsageMeter,
  );
  projectShareTunnel.configureControlPlane(
    repository,
    tunnelStreamBroker,
    publishTunnelRuntimeChange,
  );
  const revokeManagedFileShare = async (
    ownerId: string,
    managedResourceId: string,
  ): Promise<boolean> => {
    const tunnel = await repository.getManagedTunnel(ownerId, {
      kind: "project-share",
      id: managedResourceId,
    });
    if (!tunnel) return false;
    return directAttachments.mutateResource(
      ownerId,
      "tunnel",
      tunnel.id,
      async () => {
        await Promise.all(
          tunnel.attachments.map(({ id }) =>
            tunnelRuntime.revoke(ownerId, id, {
              preserveTunnelState: true,
            }),
          ),
        );
        return projectShareTunnel.revokeManagedResource(
          managedResourceId,
          ownerId,
        );
      },
    );
  };
  codeTunnel.configureControlPlane(
    repository,
    publishTunnelRuntimeChange,
    async (ownerId, tunnelId, reason, code) => {
      tunnelRuntime.closeTunnel(tunnelId, reason, code);
      await directAttachments.revokeResource(ownerId, "tunnel", tunnelId);
    },
  );
  const tunnelAttachmentExpiryTimer = setInterval(() => {
    void repository
      .expireDesktopTunnelDirectLeases()
      .then((expired) => {
        for (const attachment of expired) {
          publishTunnelRuntimeChange(attachment);
        }
      })
      .catch((error) => {
        app.log.error(
          { err: error },
          "Could not expire direct tunnel attachment leases",
        );
      });
    void repository
      .expireDesktopTunnelAttachments()
      .then((expired) => {
        for (const attachment of expired) {
          codeTunnel.releaseRelayAttachment(attachment.attachmentId);
          tunnelRuntime.closeActive(
            attachment.attachmentId,
            "Attachment expired",
            1008,
          );
          publishTunnelRuntimeChange(attachment);
        }
      })
      .catch((error) => {
        app.log.error({ err: error }, "Could not expire tunnel attachments");
      });
  }, TUNNEL_ATTACHMENT_EXPIRY_SWEEP_MS);
  tunnelAttachmentExpiryTimer.unref();

  return {
    publishTunnelRuntimeChange,
    revokeManagedFileShare,
    stopExpirySweep(): void {
      clearInterval(tunnelAttachmentExpiryTimer);
    },
    tunnelRuntime,
  };
}
