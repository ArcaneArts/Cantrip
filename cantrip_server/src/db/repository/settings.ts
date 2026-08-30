import { DEFAULT_PERMISSION_PROFILE_ID } from "@cantrip/protocol";
import type {
  AppDestination,
  AppDestinationUpdate,
  SettingsBundleWire,
  ThemePreference,
  UserSettings,
  UserSettingsUpdate,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import {
  toModelRouteSummary,
  toModelSummary,
  type ModelRuntime,
} from "./model-runtime.js";
import { toProviderAccountSummary } from "./provider-accounts.js";
import { toProviderSummary } from "./provider-catalog.js";
import { tokenUsageTotals, type AgentTimeAnalytics } from "./telemetry.js";

export const DEFAULT_OLLAMA_PROVIDER_ID =
  "00000000-0000-0000-0000-000000000010";
export const DEFAULT_MODEL_ID = "00000000-0000-0000-0000-000000000020";
export const DEFAULT_MODEL_ROUTE_ID = "00000000-0000-0000-0000-000000000021";

interface SettingsRepositoryCollaborators {
  getAgentTimeAnalytics(ownerId: string): Promise<AgentTimeAnalytics>;
  getModelRuntime(
    ownerId: string,
    modelId: string,
  ): Promise<ModelRuntime | null>;
  getSettings(ownerId: string): Promise<SettingsBundleWire>;
  getUserSettings(ownerId: string): Promise<UserSettings>;
  getWorker(ownerId: string, workerId: string): Promise<WorkerSummary | null>;
}

export class SettingsRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: SettingsRepositoryCollaborators,
  ) {}

  async ensureDefaultModelConfiguration(
    ownerId: string,
    modelName: string,
    ollamaBaseUrl: string,
  ): Promise<void> {
    await this.database
      .insert(schema.modelProviders)
      .values({
        id: DEFAULT_OLLAMA_PROVIDER_ID,
        ownerId,
        name: "Ollama",
        kind: "ollama",
        baseUrl: ollamaBaseUrl,
      })
      .onConflictDoNothing({ target: schema.modelProviders.id });
    await this.database
      .insert(schema.modelProfiles)
      .values({
        id: DEFAULT_MODEL_ID,
        ownerId,
        name: modelName,
      })
      .onConflictDoNothing({ target: schema.modelProfiles.id });
    await this.database
      .insert(schema.modelRoutes)
      .values({
        id: DEFAULT_MODEL_ROUTE_ID,
        modelId: DEFAULT_MODEL_ID,
        providerId: DEFAULT_OLLAMA_PROVIDER_ID,
        modelName,
        position: 0,
      })
      .onConflictDoNothing({ target: schema.modelRoutes.id });
    await this.database
      .insert(schema.userSettings)
      .values({
        userId: ownerId,
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        randomAgentNames: false,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: DEFAULT_MODEL_ID,
        defaultPermissionProfileId: DEFAULT_PERMISSION_PROFILE_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
    await this.database.execute(sql`
      update ${schema.chats}
      set model_id = ${DEFAULT_MODEL_ID}
      where model_id is null
        and exists (
          select 1 from ${schema.chatMessages}
          where ${schema.chatMessages.chatId} = ${schema.chats.id}
            and ${schema.chatMessages.role} = 'user'
        )
    `);
  }

  async ensureAccountConfiguration(ownerId: string): Promise<void> {
    await this.database
      .insert(schema.userSettings)
      .values({
        userId: ownerId,
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        randomAgentNames: false,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
        defaultPermissionProfileId: DEFAULT_PERMISSION_PROFILE_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
  }

  async getSettings(ownerId: string): Promise<SettingsBundleWire> {
    const [
      preferences,
      providerRows,
      providerAccountRows,
      providerAccountWorkerRows,
      modelRows,
      routeRows,
      providerUsageRows,
      modelUsageRows,
      agentTime,
    ] = await Promise.all([
      this.collaborators.getUserSettings(ownerId),
      this.database
        .select()
        .from(schema.modelProviders)
        .where(eq(schema.modelProviders.ownerId, ownerId))
        .orderBy(asc(schema.modelProviders.name)),
      this.database
        .select({ account: schema.modelProviderAccounts })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        )
        .orderBy(asc(schema.modelProviderAccounts.position)),
      this.database
        .select({ binding: schema.modelProviderAccountWorkers })
        .from(schema.modelProviderAccountWorkers)
        .innerJoin(
          schema.modelProviderAccounts,
          eq(
            schema.modelProviderAccounts.id,
            schema.modelProviderAccountWorkers.accountId,
          ),
        )
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        ),
      this.database
        .select()
        .from(schema.modelProfiles)
        .where(eq(schema.modelProfiles.ownerId, ownerId))
        .orderBy(asc(schema.modelProfiles.name)),
      this.database
        .select({
          route: schema.modelRoutes,
          providerName: schema.modelProviders.name,
        })
        .from(schema.modelRoutes)
        .innerJoin(
          schema.modelProfiles,
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
        )
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
        )
        .where(eq(schema.modelProfiles.ownerId, ownerId))
        .orderBy(asc(schema.modelRoutes.position)),
      this.database
        .select({
          id: schema.tokenUsageRecords.providerId,
          inputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.ownerId, ownerId))
        .groupBy(schema.tokenUsageRecords.providerId),
      this.database
        .select({
          id: schema.tokenUsageRecords.modelId,
          inputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.ownerId, ownerId))
        .groupBy(schema.tokenUsageRecords.modelId),
      this.collaborators.getAgentTimeAnalytics(ownerId),
    ]);
    const providerUsage = new Map(
      providerUsageRows.flatMap((row) =>
        row.id
          ? [[row.id, tokenUsageTotals(row.inputTokens, row.outputTokens)]]
          : [],
      ),
    );
    const modelUsage = new Map(
      modelUsageRows.flatMap((row) =>
        row.id
          ? [[row.id, tokenUsageTotals(row.inputTokens, row.outputTokens)]]
          : [],
      ),
    );
    return {
      preferences,
      providers: providerRows.map((provider) =>
        toProviderSummary(
          provider,
          providerUsage.get(provider.id),
          agentTime.providers.get(provider.id),
          providerAccountRows
            .filter(({ account }) => account.providerId === provider.id)
            .map(({ account }) =>
              toProviderAccountSummary(
                account,
                providerAccountWorkerRows
                  .filter(({ binding }) => binding.accountId === account.id)
                  .map(({ binding }) => binding),
              ),
            ),
        ),
      ),
      models: modelRows.map((model) =>
        toModelSummary(
          model,
          routeRows
            .filter(({ route }) => route.modelId === model.id)
            .map(({ route, providerName }) =>
              toModelRouteSummary(route, providerName),
            ),
          modelUsage.get(model.id),
          agentTime.models.get(model.id),
        ),
      ),
    };
  }

  async getUserSettings(ownerId: string): Promise<UserSettings> {
    const rows = await this.database
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, ownerId))
      .limit(1);
    const settings = firstOrThrow(rows, "loading user settings");
    return {
      theme: settings.theme as ThemePreference,
      highContrast: settings.highContrast,
      proMode: settings.proMode,
      proModeOpacity: settings.proModeOpacity,
      eliteMode: settings.eliteMode,
      eliteRevealConfig: settings.eliteRevealConfig,
      sidebarWidth: settings.sidebarWidth,
      randomAgentNames: settings.randomAgentNames,
      desktopFrameRate:
        settings.desktopFrameRate as UserSettings["desktopFrameRate"],
      desktopStreamQuality:
        settings.desktopStreamQuality as UserSettings["desktopStreamQuality"],
      defaultModelId: settings.defaultModelId,
      defaultReasoningEffort: settings.defaultReasoningEffort,
      defaultCustomSubagentModel: settings.defaultCustomSubagentModel,
      defaultSubagentModelId: settings.defaultSubagentModelId,
      defaultSubagentReasoningEffort: settings.defaultSubagentReasoningEffort,
      defaultPermissionProfileId:
        settings.defaultPermissionProfileId as UserSettings["defaultPermissionProfileId"],
      defaultChatModelId: settings.defaultChatModelId,
      defaultChatReasoningEffort: settings.defaultChatReasoningEffort,
      defaultChatPermissionProfileId:
        settings.defaultChatPermissionProfileId as UserSettings["defaultChatPermissionProfileId"],
      defaultWorkerId: settings.defaultWorkerId,
      lastAppMode: settings.lastAppMode as UserSettings["lastAppMode"],
      lastIdeProjectId: settings.lastIdeProjectId,
      lastIdeWorkspaceId: settings.lastIdeWorkspaceId,
      lastStandaloneChatId: settings.lastStandaloneChatId,
      destinationRevision: settings.destinationRevision,
      automaticReplicaProvisioning: settings.automaticReplicaProvisioning,
      automaticReplicaSynchronization:
        settings.automaticReplicaSynchronization as UserSettings["automaticReplicaSynchronization"],
      mobileProjectTabConfigurations: settings.mobileProjectTabConfigurations,
    };
  }

  async updateAppDestination(
    ownerId: string,
    input: AppDestinationUpdate,
  ): Promise<AppDestination | null> {
    if (input.lastIdeProjectId) {
      const projects = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, input.lastIdeProjectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projects[0]) return null;
    }
    if (input.lastIdeWorkspaceId) {
      const workspaces = await this.database
        .select({ id: schema.projectWorkspaces.id })
        .from(schema.projectWorkspaces)
        .where(
          and(
            eq(schema.projectWorkspaces.id, input.lastIdeWorkspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!workspaces[0]) return null;
    }
    if (input.lastStandaloneChatId) {
      const chats = await this.database
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.lastStandaloneChatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .limit(1);
      if (!chats[0]) return null;
    }

    const rows = await this.database
      .update(schema.userSettings)
      .set({
        ...(input.lastAppMode !== undefined
          ? { lastAppMode: input.lastAppMode }
          : {}),
        ...(input.lastIdeProjectId !== undefined
          ? { lastIdeProjectId: input.lastIdeProjectId }
          : {}),
        ...(input.lastIdeWorkspaceId !== undefined
          ? { lastIdeWorkspaceId: input.lastIdeWorkspaceId }
          : {}),
        ...(input.lastStandaloneChatId !== undefined
          ? { lastStandaloneChatId: input.lastStandaloneChatId }
          : {}),
        destinationRevision: sql`${schema.userSettings.destinationRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.userSettings.userId, ownerId),
          eq(schema.userSettings.destinationRevision, input.expectedRevision),
        ),
      )
      .returning({
        lastAppMode: schema.userSettings.lastAppMode,
        lastIdeProjectId: schema.userSettings.lastIdeProjectId,
        lastIdeWorkspaceId: schema.userSettings.lastIdeWorkspaceId,
        lastStandaloneChatId: schema.userSettings.lastStandaloneChatId,
        revision: schema.userSettings.destinationRevision,
      });
    const destination = rows[0];
    return destination
      ? {
          lastAppMode: destination.lastAppMode as AppDestination["lastAppMode"],
          lastIdeProjectId: destination.lastIdeProjectId,
          lastIdeWorkspaceId: destination.lastIdeWorkspaceId,
          lastStandaloneChatId: destination.lastStandaloneChatId,
          revision: destination.revision,
        }
      : null;
  }

  async updateSettings(
    ownerId: string,
    input: UserSettingsUpdate,
  ): Promise<SettingsBundleWire | null> {
    if (input.defaultModelId) {
      const model = await this.collaborators.getModelRuntime(
        ownerId,
        input.defaultModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (input.defaultChatModelId) {
      const model = await this.collaborators.getModelRuntime(
        ownerId,
        input.defaultChatModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (input.defaultSubagentModelId) {
      const model = await this.collaborators.getModelRuntime(
        ownerId,
        input.defaultSubagentModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (
      input.defaultCustomSubagentModel !== undefined ||
      input.defaultSubagentModelId !== undefined
    ) {
      const current = await this.collaborators.getUserSettings(ownerId);
      const customSubagentModel =
        input.defaultCustomSubagentModel ?? current.defaultCustomSubagentModel;
      const subagentModelId =
        input.defaultSubagentModelId !== undefined
          ? input.defaultSubagentModelId
          : current.defaultSubagentModelId;
      if (customSubagentModel && !subagentModelId) return null;
    }
    if (
      input.defaultWorkerId &&
      !(await this.collaborators.getWorker(ownerId, input.defaultWorkerId))
    ) {
      return null;
    }
    const { mobileProjectTabConfigurations, ...scalarSettings } = input;
    await this.database
      .update(schema.userSettings)
      .set({
        ...scalarSettings,
        ...(mobileProjectTabConfigurations
          ? {
              mobileProjectTabConfigurations: sql`${schema.userSettings.mobileProjectTabConfigurations} || ${JSON.stringify(mobileProjectTabConfigurations)}::jsonb`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.userSettings.userId, ownerId));
    return this.collaborators.getSettings(ownerId);
  }
}
