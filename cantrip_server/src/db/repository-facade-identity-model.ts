import type {
  AccountLicenseWhitelistEntry,
  AccountSessionSummary,
  AppDestination,
  AppDestinationUpdate,
  AuditEvent,
  AuditEventList,
  AuditEventQuery,
  DesktopUpdateActiveWorkSummary,
  EncryptedModelProviderAccountCreate,
  EncryptedModelProviderAccountUpdate,
  EncryptedModelProviderCreate,
  EncryptedModelProviderUpdate,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProfileUpdate,
  ModelProviderAccountWireSummary,
  ModelProviderWireSummary,
  OrderedIds,
  ProjectTokenUsage,
  ProviderCatalogSyncState,
  ProviderModelAvailability,
  ProviderModelCatalogResult,
  ProviderTelemetryDeleteResult,
  ProviderTelemetryExport,
  ProviderTelemetryWireAnalytics,
  SettingsBundleWire,
  UserSettings,
  UserSettingsUpdate,
  UserSummary,
  WorkerCredentialScope,
  WorkerCredentialSummary,
  WorkerEnrollmentCodeStatus,
  WorkerHeartbeat,
  WorkerSummary,
} from "@cantrip/protocol";
import type {
  ProtectedProviderCredential,
  ProviderCredentialPublicMetadata,
} from "@cantrip/protocol/protected-secrets";

import type { QuotaTokenAnalytics } from "../analytics/quota-token.js";
import type {
  AccountRepository,
  AccountCredentialRecord,
  ActiveUserSession,
  AuditEventCreate,
  UserSessionRow,
} from "./repository/accounts.js";
import type { DesktopUpdateStateRepository } from "./repository/desktop-update-state.js";
import type {
  ProviderAccountRepository,
  ModelProviderAccountRuntime,
  ProviderAccountCredentialMigrationRecord,
  ProviderAccountCredentialRecord,
  ProviderAccountCredentialSignOutRecord,
  ProviderAccountCredentialState,
} from "./repository/provider-accounts.js";
import type {
  ProviderCatalogRepository,
  ModelProviderCatalogRuntime,
  ModelProviderCatalogTarget,
  ModelProviderRefreshTarget,
  ProviderModelCatalogWrite,
} from "./repository/provider-catalog.js";
import type {
  ModelRepository,
  ModelRuntime,
} from "./repository/model-runtime.js";
import type { SettingsRepository } from "./repository/settings.js";
import type {
  TelemetryRepository,
  AgentTimeAnalytics,
  ModelBehaviorObservationInput,
  ProviderQuotaObservationInput,
  QuotaTokenAnalyticsQuery,
  TokenUsageRecordInput,
} from "./repository/telemetry.js";
import type {
  WorkerRepository,
  ActiveWorkerCredential,
  WorkerEnrollmentProvision,
  WorkerManagementRecord,
} from "./repository/workers.js";

export abstract class IdentityModelRepositoryFacade {
  abstract readonly accounts: AccountRepository;
  abstract readonly desktopUpdateState: DesktopUpdateStateRepository;
  abstract readonly models: ModelRepository;
  abstract readonly providerAccounts: ProviderAccountRepository;
  abstract readonly providerCatalog: ProviderCatalogRepository;
  abstract readonly settings: SettingsRepository;
  abstract readonly telemetry: TelemetryRepository;
  abstract readonly workers: WorkerRepository;

  async migrateProviderSecrets(): Promise<void> {
    // Pre-release migration 0119 removes every server-readable predecessor.
  }

  async migrateProviderAccountCredentialSecrets(): Promise<void> {
    // Pre-release migration 0119 signs legacy accounts out.
  }

  async migrateMcpServerSecrets(): Promise<void> {
    // Pre-release migration 0119 deletes legacy MCP rows.
  }

  async ensureLocalIdentity(): Promise<UserSummary> {
    return this.accounts.ensureLocalIdentity();
  }

  async countAccountUsers(): Promise<number> {
    return this.accounts.countAccountUsers();
  }

  async desktopUpdateActiveWork(
    ownerId: string,
  ): Promise<DesktopUpdateActiveWorkSummary> {
    return this.desktopUpdateState.desktopUpdateActiveWork(ownerId);
  }

  async accountEmailIsWhitelisted(normalizedEmail: string): Promise<boolean> {
    return this.accounts.accountEmailIsWhitelisted(normalizedEmail);
  }

  async listAccountLicenseWhitelist(): Promise<AccountLicenseWhitelistEntry[]> {
    return this.accounts.listAccountLicenseWhitelist();
  }

  async createAccountLicenseWhitelistEntry(input: {
    addedByUserId: string;
    email: string;
    normalizedEmail: string;
  }): Promise<AccountLicenseWhitelistEntry | null> {
    return this.accounts.createAccountLicenseWhitelistEntry(input);
  }

  async deleteAccountLicenseWhitelistEntry(id: string): Promise<boolean> {
    return this.accounts.deleteAccountLicenseWhitelistEntry(id);
  }

  async createAccount(input: {
    displayName: string;
    email: string;
    normalizedEmail: string;
    passwordHash: string;
    role: UserSummary["role"];
  }): Promise<UserSummary> {
    return this.accounts.createAccount(input);
  }

  async findAccountCredential(
    normalizedEmail: string,
  ): Promise<AccountCredentialRecord | null> {
    return this.accounts.findAccountCredential(normalizedEmail);
  }

  async findAccountCredentialById(
    ownerId: string,
  ): Promise<AccountCredentialRecord | null> {
    return this.accounts.findAccountCredentialById(ownerId);
  }

  async createUserSession(input: {
    authMethod: ActiveUserSession["authMethod"];
    csrfTokenHash: string;
    expiresAt: Date;
    label: string | null;
    tokenHash: string;
    userId: string;
  }): Promise<UserSessionRow> {
    return this.accounts.createUserSession(input);
  }

  async getActiveUserSession(
    tokenHash: string,
  ): Promise<ActiveUserSession | null> {
    return this.accounts.getActiveUserSession(tokenHash);
  }

  async createMobileSignInGrant(input: {
    codeHash: string;
    createdBySessionId: string;
    expiresAt: Date;
    ownerId: string;
  }): Promise<string> {
    return this.accounts.createMobileSignInGrant(input);
  }

  async consumeMobileSignInGrant(
    codeHash: string,
  ): Promise<UserSummary | null> {
    return this.accounts.consumeMobileSignInGrant(codeHash);
  }

  async pruneMobileSignInGrants(before: Date): Promise<void> {
    return this.accounts.pruneMobileSignInGrants(before);
  }

  async isUserSessionActive(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    return this.accounts.isUserSessionActive(sessionId, userId);
  }

  async rotateSessionCsrfToken(
    sessionId: string,
    csrfTokenHash: string,
  ): Promise<boolean> {
    return this.accounts.rotateSessionCsrfToken(sessionId, csrfTokenHash);
  }

  async revokeUserSession(sessionId: string, reason: string): Promise<boolean> {
    return this.accounts.revokeUserSession(sessionId, reason);
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    return this.accounts.revokeAllUserSessions(userId, reason);
  }

  async listUserSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<AccountSessionSummary[]> {
    return this.accounts.listUserSessions(userId, currentSessionId);
  }

  async appendAuditEvent(input: AuditEventCreate): Promise<AuditEvent> {
    return this.accounts.appendAuditEvent(input);
  }

  async listAuditEvents(
    query: AuditEventQuery,
    ownerId?: string,
  ): Promise<AuditEventList> {
    return this.accounts.listAuditEvents(query, ownerId);
  }

  async ensureDefaultModelConfiguration(
    ownerId: string,
    modelName: string,
    ollamaBaseUrl: string,
  ): Promise<void> {
    return this.settings.ensureDefaultModelConfiguration(
      ownerId,
      modelName,
      ollamaBaseUrl,
    );
  }

  async ensureAccountConfiguration(ownerId: string): Promise<void> {
    return this.settings.ensureAccountConfiguration(ownerId);
  }

  async getSettings(ownerId: string): Promise<SettingsBundleWire> {
    return this.settings.getSettings(ownerId);
  }

  async getAgentTimeAnalytics(
    ownerId: string,
    projectId?: string,
    now = new Date(),
  ): Promise<AgentTimeAnalytics> {
    return this.telemetry.getAgentTimeAnalytics(ownerId, projectId, now);
  }

  async recordTokenUsage(
    ownerId: string,
    input: TokenUsageRecordInput,
  ): Promise<void> {
    return this.telemetry.recordTokenUsage(ownerId, input);
  }

  async recordModelBehaviorObservation(
    ownerId: string,
    input: ModelBehaviorObservationInput,
  ): Promise<void> {
    return this.telemetry.recordModelBehaviorObservation(ownerId, input);
  }

  async getProjectTokenUsage(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTokenUsage | null> {
    return this.telemetry.getProjectTokenUsage(ownerId, projectId);
  }
  async getUserSettings(ownerId: string): Promise<UserSettings> {
    return this.settings.getUserSettings(ownerId);
  }

  async updateAppDestination(
    ownerId: string,
    input: AppDestinationUpdate,
  ): Promise<AppDestination | null> {
    return this.settings.updateAppDestination(ownerId, input);
  }

  async updateSettings(
    ownerId: string,
    input: UserSettingsUpdate,
  ): Promise<SettingsBundleWire | null> {
    return this.settings.updateSettings(ownerId, input);
  }

  async createModelProvider(
    ownerId: string,
    input: EncryptedModelProviderCreate,
  ): Promise<ModelProviderWireSummary> {
    return this.providerCatalog.createModelProvider(ownerId, input);
  }

  async getModelProvider(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderWireSummary | null> {
    return this.providerCatalog.getModelProvider(ownerId, providerId);
  }

  async hasModelRoutesForProvider(
    ownerId: string,
    providerId: string,
  ): Promise<boolean> {
    return this.providerCatalog.hasModelRoutesForProvider(ownerId, providerId);
  }
  async listModelProviderAccounts(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderAccountWireSummary[] | null> {
    return this.providerAccounts.listModelProviderAccounts(ownerId, providerId);
  }

  async getModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.providerAccounts.getModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
    );
  }

  async listModelProviderAccountCredentialMigrations(
    ownerId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord[]> {
    return this.providerAccounts.listModelProviderAccountCredentialMigrations(
      ownerId,
    );
  }

  async getModelProviderAccountCredentialMigration(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord | null> {
    return this.providerAccounts.getModelProviderAccountCredentialMigration(
      ownerId,
      providerId,
      accountId,
    );
  }

  async storeModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: ProtectedProviderCredential,
    metadata: ProviderCredentialPublicMetadata,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.providerAccounts.storeModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
      input,
      metadata,
      expectedRevision,
    );
  }

  async updateModelProviderAccountCredentialState(input: {
    accountId: string;
    expectedRevision: number;
    ownerId: string;
    providerId: string;
    state: Extract<
      ProviderAccountCredentialState,
      "reauth-required" | "conflict"
    >;
  }): Promise<boolean> {
    return this.providerAccounts.updateModelProviderAccountCredentialState(
      input,
    );
  }

  async clearModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    return this.providerAccounts.clearModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
      expectedRevision,
    );
  }

  async takeModelProviderAccountCredentialForSignOut(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialSignOutRecord | null> {
    return this.providerAccounts.takeModelProviderAccountCredentialForSignOut(
      ownerId,
      providerId,
      accountId,
      expectedRevision,
    );
  }

  async createModelProviderAccount(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderAccountCreate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.providerAccounts.createModelProviderAccount(
      ownerId,
      providerId,
      input,
    );
  }

  async updateModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: EncryptedModelProviderAccountUpdate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.providerAccounts.updateModelProviderAccount(
      ownerId,
      providerId,
      accountId,
      input,
    );
  }

  async reorderModelProviderAccounts(
    ownerId: string,
    providerId: string,
    input: OrderedIds,
  ): Promise<boolean> {
    return this.providerAccounts.reorderModelProviderAccounts(
      ownerId,
      providerId,
      input,
    );
  }

  async deleteModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return this.providerAccounts.deleteModelProviderAccount(
      ownerId,
      providerId,
      accountId,
    );
  }

  async getModelProviderAccountRuntime(
    ownerId: string,
    providerId: string,
    accountId?: string,
  ): Promise<{
    accountId: string;
    credentialHomeKey: string;
  } | null> {
    return this.providerAccounts.getModelProviderAccountRuntime(
      ownerId,
      providerId,
      accountId,
    );
  }

  async recordModelProviderAccountStatus(
    accountId: string,
    workerId: string,
    status: {
      authenticated: boolean;
      email: string | null;
      planType: string | null;
      weeklyUsage: { usedPercent: number; resetsAt: number | null } | null;
    },
  ): Promise<void> {
    return this.providerAccounts.recordModelProviderAccountStatus(
      accountId,
      workerId,
      status,
    );
  }

  async recordModelProviderAccountUsage(input: {
    accountId: string;
    ownerId: string;
    planType: string | null;
    providerId: string;
    resetsAt: number | null;
    usedPercent: number;
  }): Promise<boolean> {
    return this.providerAccounts.recordModelProviderAccountUsage(input);
  }

  async recordProviderQuotaObservation(
    ownerId: string,
    input: ProviderQuotaObservationInput,
  ): Promise<boolean> {
    return this.telemetry.recordProviderQuotaObservation(ownerId, input);
  }

  async getQuotaTokenAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<QuotaTokenAnalytics> {
    return this.telemetry.getQuotaTokenAnalytics(ownerId, query);
  }

  async getProviderTelemetryAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<ProviderTelemetryWireAnalytics> {
    return this.telemetry.getProviderTelemetryAnalytics(ownerId, query);
  }

  async exportProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryExport | null> {
    return this.telemetry.exportProviderTelemetry(ownerId, providerId);
  }

  async deleteProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryDeleteResult | null> {
    return this.telemetry.deleteProviderTelemetry(ownerId, providerId);
  }
  async deleteModelProvider(ownerId: string, providerId: string) {
    return this.providerCatalog.deleteModelProvider(ownerId, providerId);
  }

  async updateModelProvider(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderUpdate,
  ): Promise<ModelProviderWireSummary | null> {
    return this.providerCatalog.updateModelProvider(ownerId, providerId, input);
  }

  async getModelProviderCatalogRuntime(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderCatalogRuntime | null> {
    return this.providerCatalog.getModelProviderCatalogRuntime(
      ownerId,
      providerId,
    );
  }

  async listModelProviderCatalogTargets(
    ownerId: string,
  ): Promise<ModelProviderCatalogTarget[]> {
    return this.providerCatalog.listModelProviderCatalogTargets(ownerId);
  }

  async listModelProviderRefreshTargets(
    ownerId: string,
  ): Promise<ModelProviderRefreshTarget[]> {
    return this.providerCatalog.listModelProviderRefreshTargets(ownerId);
  }

  async setProviderCatalogSyncState(
    providerId: string,
    input: {
      scopeKey: string;
      status: ProviderCatalogSyncState["status"];
      errorCode?: string | null;
      etag?: string | null;
      refreshStartedAt?: Date | null;
      lastSuccessAt?: Date | null;
      workerId?: string | null;
      providerAccountId?: string | null;
    },
  ): Promise<void> {
    return this.providerCatalog.setProviderCatalogSyncState(providerId, input);
  }

  async reconcileProviderModelCatalog(
    ownerId: string,
    providerId: string,
    input: {
      models: ProviderModelCatalogWrite[];
      availabilityScope: string;
      availableNativeModelIds: ReadonlySet<string>;
      autoCreateLogicalModels?: boolean;
      autoCreateNativeModelIds?: ReadonlySet<string>;
      availabilityWorkerId?: string | null;
      availabilityProviderAccountId?: string | null;
      defaultNativeModelId?: string | null;
    },
  ): Promise<boolean> {
    return this.providerCatalog.reconcileProviderModelCatalog(
      ownerId,
      providerId,
      input,
    );
  }

  async getProviderModelCatalog(
    ownerId: string,
    providerId: string,
    servedStale = false,
  ): Promise<ProviderModelCatalogResult | null> {
    return this.providerCatalog.getProviderModelCatalog(
      ownerId,
      providerId,
      servedStale,
    );
  }

  async listProviderModelAvailability(
    ownerId: string,
    providerId: string,
    providerModelId: string,
  ): Promise<ProviderModelAvailability[]> {
    return this.providerCatalog.listProviderModelAvailability(
      ownerId,
      providerId,
      providerModelId,
    );
  }
  async createModelProfile(
    ownerId: string,
    input: ModelProfileCreate,
  ): Promise<ModelProfileSummary | null> {
    return this.models.createModelProfile(ownerId, input);
  }

  async deleteModelProfile(ownerId: string, modelId: string) {
    return this.models.deleteModelProfile(ownerId, modelId);
  }

  async updateModelProfile(
    ownerId: string,
    modelId: string,
    input: ModelProfileUpdate,
  ): Promise<ModelProfileSummary | null> {
    return this.models.updateModelProfile(ownerId, modelId, input);
  }

  async getModelRuntime(
    ownerId: string,
    modelId: string,
    routeId?: string,
  ): Promise<ModelRuntime | null> {
    return this.models.getModelRuntime(ownerId, modelId, routeId);
  }

  async getModelRuntimeByRoute(
    ownerId: string,
    routeId: string,
  ): Promise<ModelRuntime | null> {
    return this.models.getModelRuntimeByRoute(ownerId, routeId);
  }

  async getModelRuntimes(
    ownerId: string,
    modelId?: string,
    routeId?: string,
    includeDisabled = false,
  ): Promise<ModelRuntime[]> {
    return this.models.getModelRuntimes(
      ownerId,
      modelId,
      routeId,
      includeDisabled,
    );
  }

  async listModelProviderAccountRuntimes(
    ownerId: string,
    providerId: string,
    workerId: string,
    providerModelId: string | null,
  ): Promise<ModelProviderAccountRuntime[]> {
    return this.models.listModelProviderAccountRuntimes(
      ownerId,
      providerId,
      workerId,
      providerModelId,
    );
  }
  async getOrCreateServerId(): Promise<string> {
    return this.workers.getOrCreateServerId();
  }

  async createWorkerEnrollmentCode(input: {
    codeHash: string;
    createdBySessionId: string | null;
    expiresAt: Date;
    label: string | null;
    ownerId: string;
  }): Promise<string> {
    return this.workers.createWorkerEnrollmentCode(input);
  }

  async findReusableWorkerId(
    ownerId: string,
    candidateWorkerIds: readonly string[],
  ): Promise<string | null> {
    return this.workers.findReusableWorkerId(ownerId, candidateWorkerIds);
  }

  async getWorkerEnrollmentCodeStatus(
    ownerId: string,
    enrollmentCodeId: string,
  ): Promise<WorkerEnrollmentCodeStatus | null> {
    return this.workers.getWorkerEnrollmentCodeStatus(
      ownerId,
      enrollmentCodeId,
    );
  }

  async exchangeWorkerEnrollmentCode(input: {
    codeHash: string;
    credentialHash: string;
    credentialId: string;
    heartbeat: WorkerHeartbeat;
    replacement: { workerId: string; credentialHash: string } | null;
    scopes: WorkerCredentialScope[];
  }): Promise<WorkerEnrollmentProvision> {
    return this.workers.exchangeWorkerEnrollmentCode(input);
  }

  async authenticateWorkerCredential(
    secretHash: string,
    workerId: string,
    requiredScope: WorkerCredentialScope,
  ): Promise<ActiveWorkerCredential | null> {
    return this.workers.authenticateWorkerCredential(
      secretHash,
      workerId,
      requiredScope,
    );
  }

  async listWorkerCredentials(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerCredentialSummary[] | null> {
    return this.workers.listWorkerCredentials(ownerId, workerId);
  }

  async rotateWorkerCredential(input: {
    credentialHash: string;
    credentialId: string;
    label: string | null;
    ownerId: string;
    scopes: WorkerCredentialScope[];
    workerId: string;
  }): Promise<WorkerCredentialSummary | null> {
    return this.workers.rotateWorkerCredential(input);
  }

  async revokeWorkerCredential(
    ownerId: string,
    workerId: string,
    credentialId: string,
    reason = "revoked by owner",
  ): Promise<WorkerCredentialSummary | null> {
    return this.workers.revokeWorkerCredential(
      ownerId,
      workerId,
      credentialId,
      reason,
    );
  }

  async recordWorker(
    ownerId: string,
    heartbeat: WorkerHeartbeat,
  ): Promise<WorkerSummary> {
    return this.workers.recordWorker(ownerId, heartbeat);
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    return this.workers.listWorkers(ownerId);
  }

  async getWorker(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerSummary | null> {
    return this.workers.getWorker(ownerId, workerId);
  }

  async listWorkerManagement(
    ownerId: string,
  ): Promise<WorkerManagementRecord[]> {
    return this.workers.listWorkerManagement(ownerId);
  }

  async updateWorkerDisplayName(
    ownerId: string,
    workerId: string,
    name: string,
  ): Promise<WorkerSummary | null> {
    return this.workers.updateWorkerDisplayName(ownerId, workerId, name);
  }

  async unlinkWorker(ownerId: string, workerId: string): Promise<boolean> {
    return this.workers.unlinkWorker(ownerId, workerId);
  }

  async getWorkerOwnerId(workerId: string): Promise<string | null> {
    return this.workers.getWorkerOwnerId(workerId);
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    return this.workers.onlineWorkerCount(ownerId);
  }
}
