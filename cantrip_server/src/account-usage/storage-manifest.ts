import type { AnyPgTable } from "drizzle-orm/pg-core";

import * as schema from "../db/schema.js";

export const STORAGE_ACCOUNTING_BASIS_VERSION = "postgres-logical-row-bytes-v1";

export type StorageAccountingCategory =
  "account" | "analytics" | "configuration" | "conversations" | "projects";

export type StorageAccountingClassification =
  | "account-owned"
  | "accounting-excluded"
  | "chat-owned"
  | "platform-excluded"
  | "project-owned";

export type StorageOwnerResolution =
  | "attachment"
  | "chat"
  | "model-profile"
  | "owner-column"
  | "project"
  | "project-source"
  | "provider"
  | "provider-account"
  | "provider-model"
  | "self"
  | "tunnel"
  | "tunnel-attachment"
  | "user"
  | "workspace";

export type WorkerManagedStorageKind =
  "attachment-replica" | "attachment-source";

export interface StorageAccountingManifestEntry {
  readonly category: StorageAccountingCategory | null;
  readonly classification: StorageAccountingClassification;
  readonly excludeReason?: string;
  readonly ownerResolution: StorageOwnerResolution | null;
  readonly table: AnyPgTable;
  readonly workerManaged?: WorkerManagedStorageKind;
}

function accountOwned(
  table: AnyPgTable,
  category: StorageAccountingCategory,
  ownerResolution: StorageOwnerResolution = "owner-column",
): StorageAccountingManifestEntry {
  return {
    category,
    classification: "account-owned",
    ownerResolution,
    table,
  };
}

function projectOwned(
  table: AnyPgTable,
  category: StorageAccountingCategory = "projects",
  ownerResolution: StorageOwnerResolution = "project",
): StorageAccountingManifestEntry {
  return {
    category,
    classification: "project-owned",
    ownerResolution,
    table,
  };
}

function chatOwned(
  table: AnyPgTable,
  workerManaged?: WorkerManagedStorageKind,
): StorageAccountingManifestEntry {
  return {
    category: "conversations",
    classification: "chat-owned",
    ownerResolution:
      workerManaged === "attachment-replica" ? "attachment" : "chat",
    table,
    workerManaged,
  };
}

function excluded(
  table: AnyPgTable,
  classification: Extract<
    StorageAccountingClassification,
    "accounting-excluded" | "platform-excluded"
  >,
  excludeReason: string,
): StorageAccountingManifestEntry {
  return {
    category: null,
    classification,
    excludeReason,
    ownerResolution: null,
    table,
  };
}

/**
 * Exhaustive classification of every durable server table.
 *
 * The coverage test intentionally compares this manifest to the exported
 * Drizzle schema so a newly introduced table cannot silently escape storage
 * accounting. Entries with indirect ownership still use the product-level
 * classification requested by the accounting contract.
 */
export const STORAGE_ACCOUNTING_MANIFEST: readonly StorageAccountingManifestEntry[] =
  [
    excluded(schema.systemState, "platform-excluded", "global server state"),
    accountOwned(schema.users, "account", "self"),
    excluded(
      schema.accountLicenseWhitelist,
      "platform-excluded",
      "server-wide registration policy",
    ),
    accountOwned(schema.userSessions, "account", "user"),
    accountOwned(schema.mobileSignInGrants, "account"),
    accountOwned(schema.auditEvents, "analytics"),
    accountOwned(schema.workerEnrollmentCodes, "account"),
    accountOwned(schema.modelProviders, "configuration"),
    accountOwned(schema.modelProviderAccounts, "configuration", "provider"),
    accountOwned(
      schema.modelProviderAccountWorkers,
      "configuration",
      "provider-account",
    ),
    accountOwned(schema.providerQuotaObservations, "analytics"),
    accountOwned(schema.providerModels, "configuration", "provider"),
    accountOwned(schema.providerModelCatalogSnapshots, "analytics"),
    accountOwned(
      schema.providerModelAvailability,
      "configuration",
      "provider-model",
    ),
    accountOwned(schema.providerCatalogSyncStates, "configuration", "provider"),
    accountOwned(schema.providerModelSuppressions, "configuration"),
    accountOwned(schema.modelProfiles, "configuration"),
    accountOwned(schema.modelRoutes, "configuration", "model-profile"),
    accountOwned(schema.userSettings, "configuration", "user"),
    accountOwned(schema.taskWorkers, "configuration"),
    accountOwned(schema.policyOwnerStates, "configuration"),
    accountOwned(schema.policies, "configuration"),
    accountOwned(schema.codeSettingsProfiles, "configuration"),
    accountOwned(schema.workers, "account"),
    accountOwned(schema.skillAudiences, "configuration", "provider"),
    accountOwned(schema.workerCredentials, "account"),
    accountOwned(schema.accountEncryptionProfiles, "account"),
    accountOwned(schema.encryptionPrincipals, "account"),
    accountOwned(schema.encryptionKeyGrants, "account"),
    accountOwned(schema.projects, "projects"),
    accountOwned(schema.tunnels, "projects"),
    accountOwned(schema.tunnelAttachments, "projects", "tunnel"),
    accountOwned(
      schema.tunnelAttachmentDirectLeases,
      "projects",
      "tunnel-attachment",
    ),
    accountOwned(schema.mcpServers, "configuration"),
    accountOwned(schema.projectWorkspaces, "projects"),
    accountOwned(
      schema.projectWorkspaceStorageProfiles,
      "projects",
      "workspace",
    ),
    accountOwned(schema.workspaceRepositoryDiscoveryJobs, "projects"),
    accountOwned(schema.workspaceRepositoryCandidates, "projects"),
    projectOwned(schema.projectWorkspaceMemberships),
    projectOwned(schema.projectPolicyAssignments),
    projectOwned(schema.workspacePolicyAssignments, "projects", "workspace"),
    projectOwned(schema.tabGroups),
    projectOwned(schema.tabGroupMembers),
    projectOwned(schema.projectSources),
    projectOwned(schema.projectWorktrees, "projects", "project-source"),
    accountOwned(schema.projectFolderSetupJobs, "projects"),
    accountOwned(schema.projectGithubConversionJobs, "projects"),
    accountOwned(schema.projectReplicaJobs, "projects"),
    accountOwned(schema.gitOperations, "projects"),
    accountOwned(schema.runConfigurationRuntimes, "projects"),
    accountOwned(schema.runConfigurationRuntimeOperations, "projects"),
    accountOwned(schema.runConfigurationSecrets, "projects"),
    accountOwned(schema.runConfigurationSecretOperations, "projects"),
    accountOwned(schema.chats, "conversations"),
    accountOwned(schema.standaloneChatRoots, "conversations"),
    accountOwned(schema.standaloneChatRootJobs, "conversations"),
    chatOwned(schema.tasks),
    accountOwned(schema.taskDispatchCycles, "conversations"),
    chatOwned(schema.taskPlanningRounds),
    projectOwned(schema.terminals),
    projectOwned(schema.explorers),
    projectOwned(schema.codeTabs),
    projectOwned(schema.codeSessions),
    projectOwned(schema.browsers),
    projectOwned(schema.remoteSurfaces),
    projectOwned(schema.projectViews),
    chatOwned(schema.chatRuntimeSessions),
    chatOwned(schema.chatExecutionLanes),
    accountOwned(schema.agentInteractionRequests, "conversations"),
    chatOwned(schema.chatMessages),
    accountOwned(schema.tokenUsageRecords, "analytics"),
    accountOwned(schema.modelBehaviorObservations, "analytics"),
    {
      ...chatOwned(schema.chatAttachments, "attachment-source"),
      ownerResolution: "chat",
    },
    chatOwned(schema.chatAttachmentReplicas, "attachment-replica"),
    accountOwned(schema.chatRelocationJobs, "conversations"),
    accountOwned(schema.chatImportJobs, "conversations"),
    chatOwned(schema.chatRelocationSnapshots),
    chatOwned(schema.queuedPrompts),
    accountOwned(schema.projectAutomations, "projects"),
    accountOwned(schema.projectAutomationRuns, "projects"),
    projectOwned(schema.projectBranchLeases),
    excluded(
      schema.accountStorageUsageCurrent,
      "accounting-excluded",
      "current accounting projection",
    ),
    excluded(
      schema.accountStorageUsageSnapshots,
      "accounting-excluded",
      "storage history accounting data",
    ),
    excluded(
      schema.accountStorageReconciliationLeases,
      "accounting-excluded",
      "reconciliation coordination",
    ),
    excluded(
      schema.accountBandwidthUsageBuckets,
      "accounting-excluded",
      "bandwidth accounting data",
    ),
    excluded(
      schema.accountBandwidthFlushes,
      "accounting-excluded",
      "bandwidth flush idempotence ledger",
    ),
  ];
