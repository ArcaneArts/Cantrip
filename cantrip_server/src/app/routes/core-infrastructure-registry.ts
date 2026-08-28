import type { FastifyInstance } from "fastify";

import { createAuthRouteSupport } from "../http/auth-route-support.js";
import type { RequestLimits } from "../http/request-limits.js";
import { installAccountSecurityRoutes } from "./account-security.js";
import { installApiMetadataRoute } from "./api-meta-and-removed-routes.js";
import { installAuthSessionRoutes } from "./auth-sessions.js";
import { installDirectAttachmentControlRoutes } from "./direct-attachment-control.js";
import { installInternalProviderCredentialRoutes } from "./internal-provider-credentials.js";
import { installInternalWorkerCodeSettingsRoutes } from "./internal-worker-code-settings.js";
import { installRepositoryOperationRoutes } from "./repository-operations.js";
import { installStandaloneChatCatalogRoutes } from "./chat-catalogs.js";
import { installSystemStatusRoutes } from "./system-status.js";
import { installTunnelAttachmentRoutes } from "./tunnel-attachments.js";
import {
  installTunnelListRoute,
  installTunnelMutationRoutes,
  installTunnelReadAndCreateRoutes,
} from "./tunnel-management.js";
import { installWorkerCatalogRoutes } from "./worker-catalog.js";
import { installWorkerCredentialRoutes } from "./worker-credentials.js";
import { installWorkerEnrollmentCodeRoutes } from "./worker-enrollment-codes.js";
import { installWorkerLinkSessionRoutes } from "./worker-link-sessions.js";
import { installWorkerLogRoutes } from "./worker-logs.js";
import { installWorkerMaintenanceRoutes } from "./worker-maintenance.js";
import { installWorkerManagementRoutes } from "./worker-management.js";

type AuthSessionRouteDependencies = Parameters<
  typeof installAuthSessionRoutes
>[1];
type AccountSecurityRouteDependencies = Parameters<
  typeof installAccountSecurityRoutes
>[1];

export type CoreInfrastructureRouteDependencies = Parameters<
  typeof installInternalWorkerCodeSettingsRoutes
>[1] &
  Parameters<typeof installInternalProviderCredentialRoutes>[1] &
  Omit<
    AuthSessionRouteDependencies,
    "consumeAuthAttempt" | "rejectUnapprovedAuthOrigin" | "withRegistrationLock"
  > &
  Omit<AccountSecurityRouteDependencies, "consumeAuthAttempt"> &
  Parameters<typeof installSystemStatusRoutes>[1] &
  Parameters<typeof installWorkerCatalogRoutes>[1] &
  Parameters<typeof installWorkerMaintenanceRoutes>[1] &
  Parameters<typeof installRepositoryOperationRoutes>[1] &
  Parameters<typeof installWorkerLogRoutes>[1] &
  Parameters<typeof installWorkerLinkSessionRoutes>[1] &
  Parameters<typeof installDirectAttachmentControlRoutes>[1] &
  Parameters<typeof installTunnelListRoute>[1] &
  Parameters<typeof installStandaloneChatCatalogRoutes>[1] &
  Parameters<typeof installTunnelReadAndCreateRoutes>[1] &
  Parameters<typeof installTunnelAttachmentRoutes>[1] &
  Parameters<typeof installTunnelMutationRoutes>[1] &
  Parameters<typeof installWorkerManagementRoutes>[1] &
  Parameters<typeof installWorkerEnrollmentCodeRoutes>[1] &
  Parameters<typeof installWorkerCredentialRoutes>[1] & {
    authRateLimiter: RequestLimits["authRateLimiter"];
  };

/** Registers the contiguous auth, status, worker, and tunnel route tranche. */
export function installCoreInfrastructureRoutes(
  app: FastifyInstance,
  dependencies: CoreInfrastructureRouteDependencies,
): void {
  installApiMetadataRoute(app);

  const authSupport = createAuthRouteSupport({
    authRateLimiter: dependencies.authRateLimiter,
    config: dependencies.config,
  });

  installInternalWorkerCodeSettingsRoutes(app, dependencies);

  installInternalProviderCredentialRoutes(app, dependencies);

  installAuthSessionRoutes(app, { ...dependencies, ...authSupport });

  installAccountSecurityRoutes(app, { ...dependencies, ...authSupport });

  installSystemStatusRoutes(app, dependencies);

  installWorkerCatalogRoutes(app, dependencies);

  installWorkerMaintenanceRoutes(app, dependencies);

  installRepositoryOperationRoutes(app, dependencies);

  installWorkerLogRoutes(app, dependencies);
  installWorkerLinkSessionRoutes(app, dependencies);
  installDirectAttachmentControlRoutes(app, dependencies);

  installTunnelListRoute(app, dependencies);

  installStandaloneChatCatalogRoutes(app, dependencies);

  installTunnelReadAndCreateRoutes(app, dependencies);

  installTunnelAttachmentRoutes(app, dependencies);
  installTunnelMutationRoutes(app, dependencies);

  installWorkerManagementRoutes(app, dependencies);

  installWorkerEnrollmentCodeRoutes(app, dependencies);

  installWorkerCredentialRoutes(app, dependencies);
}
