import {
  workerLinkIdentityResolveResultSchema,
  directCapabilityRenewResultSchema,
} from "@cantrip/protocol";
import type { WorkerCommand } from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { WorkerConfig } from "../config.js";
import type { WorkerLinkGateway } from "../worker-link-gateway.js";
import type { WorkerLinkPeerGateway } from "../worker-link-peer-gateway.js";
import type { DirectBroker } from "../direct-broker.js";

export type WorkerLinkCommand = Extract<
  WorkerCommand,
  {
    type:
      | "worker-link.identity.resolve"
      | "worker-link.session.install"
      | "worker-link.session.renew"
      | "worker-link.grant.install"
      | "worker-link.grant.renew"
      | "worker-link.grant.revoke"
      | "worker-link.session.route"
      | "worker-link.session.revoke"
      | "worker-link.peer.install"
      | "worker-link.peer.renew"
      | "worker-link.peer.revoke"
      | "worker-link.peer.signal"
      | "direct.capability.prepare"
      | "direct.capability.revoke"
      | "direct.capability.renew";
  }
>;
export interface WorkerLinkCommandDependencies {
  workerEncryption: Pick<WorkerEncryptionService, "serverIdentity" | "ownerId">;
  config: Pick<WorkerConfig, "workerId">;
  workerProcessGeneration: string;
  workerLinkGateway: Pick<WorkerLinkGateway, "handleCoordinatorCommand">;
  workerLinkPeerGateway: Pick<
    WorkerLinkPeerGateway,
    "replaceRouteGeneration" | "revokeSession" | "handleCoordinatorCommand"
  >;
  directBroker: Pick<DirectBroker, "prepare" | "revoke" | "renew">;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleWorkerLinkCommand(
  command: WorkerLinkCommand,
  dependencies: WorkerLinkCommandDependencies,
): Promise<unknown> {
  const {
    workerEncryption,
    config,
    workerProcessGeneration,
    workerLinkGateway,
    workerLinkPeerGateway,
    directBroker,
  } = dependencies;
  switch (command.type) {
    case "worker-link.identity.resolve":
      return workerLinkIdentityResolveResultSchema.parse({
        serverId: workerEncryption.serverIdentity(),
        ownerId: workerEncryption.ownerId(),
        workerId: config.workerId,
        workerProcessGeneration,
      });
    case "worker-link.session.install":
    case "worker-link.session.renew":
    case "worker-link.grant.install":
    case "worker-link.grant.renew":
    case "worker-link.grant.revoke":
      return workerLinkGateway.handleCoordinatorCommand(command);
    case "worker-link.session.route": {
      const accepted =
        await workerLinkGateway.handleCoordinatorCommand(command);
      await workerLinkPeerGateway.replaceRouteGeneration(
        command.sessionId,
        command.routeGeneration,
      );
      return accepted;
    }
    case "worker-link.session.revoke":
      await workerLinkPeerGateway.revokeSession(
        command.sessionId,
        command.revocation.reason,
      );
      return workerLinkGateway.handleCoordinatorCommand(command);
    case "worker-link.peer.install":
    case "worker-link.peer.renew":
    case "worker-link.peer.revoke":
    case "worker-link.peer.signal":
      return workerLinkPeerGateway.handleCoordinatorCommand(command);
    case "direct.capability.prepare":
      if (command.binding.workerId !== config.workerId) {
        throw new Error("Direct capability targets another worker.");
      }
      return directBroker.prepare(command);
    case "direct.capability.revoke":
      return {
        revoked: directBroker.revoke(command.capabilityId, command.reason),
      };
    case "direct.capability.renew": {
      const leaseExpiresAt = directBroker.renew(
        command.capabilityId,
        command.leaseExpiresAt,
      );
      return directCapabilityRenewResultSchema.parse({
        renewed: leaseExpiresAt !== null,
        ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
      });
    }
  }
}
