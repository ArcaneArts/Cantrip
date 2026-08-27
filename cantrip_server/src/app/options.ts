import type { CodeTunnelBroker } from "../code/tunnel.js";
import type { ServerConfig } from "../config.js";
import type { RelayCoordinator } from "../coordination/relay-coordinator.js";
import type { DatabaseConnection } from "../db/index.js";
import type { OpenRouterCatalogService } from "../models/openrouter-catalog.js";
import type { ProviderCredentialMigrationCoordinator } from "../models/provider-credential-migrations.js";
import type { RelayQuotaManager } from "../operations/relay-quotas.js";
import type { ProjectShareTunnelBroker } from "../project-shares/tunnel.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

export interface BuildAppOptions {
  config: ServerConfig;
  database: DatabaseConnection;
  logger?: boolean;
  codeTunnel?: CodeTunnelBroker;
  projectShareTunnel?: ProjectShareTunnelBroker;
  workerBridge?: WorkerCommandBus;
  relayQuotas?: RelayQuotaManager;
  coordinator?: RelayCoordinator;
  providerCatalogService?: OpenRouterCatalogService;
  providerCredentialMigrations?: ProviderCredentialMigrationCoordinator;
}
