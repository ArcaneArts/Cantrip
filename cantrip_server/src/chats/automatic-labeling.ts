import {
  generateLabelResultSchema,
  lowestLabelingEffort,
  type LabelKind,
  type UserSettings,
  type TaskOpaqueSummary,
} from "@cantrip/protocol";
import type { WorkerCommand } from "@cantrip/protocol";
import type { ModelRuntime, ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { serverLogger } from "../logger.js";

export function automaticNamingEnabled(
  settings: Pick<
    UserSettings,
    "autoNameTasks" | "autoNameChats" | "randomAgentNames"
  >,
  kind: LabelKind,
) {
  return kind === "task"
    ? settings.autoNameTasks
    : settings.autoNameChats && !settings.randomAgentNames;
}

export function labelingModelConfiguration(modelId: string) {
  return {
    modelId,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  };
}

export function labelingRoutes(
  resolve: (
    configuration: ReturnType<typeof labelingModelConfiguration>,
  ) => Promise<Array<{ root: { runtime: ModelRuntime } }>>,
) {
  return async (_context: unknown, modelId: string) =>
    (await resolve(labelingModelConfiguration(modelId))).map(
      ({ root }) => root.runtime,
    );
}

export function createTaskLabeler(
  dependencies: Pick<
    Parameters<typeof generateAutomaticTitle>[0],
    "repository" | "bridge" | "availableModelRuntimes" | "publishChatSummary"
  > & { applicationOwnerId(): string },
) {
  return (task: TaskOpaqueSummary) => {
    void generateAutomaticTitle({
      ...dependencies,
      ownerId: dependencies.applicationOwnerId(),
      chatId: task.chatId,
      input: { kind: "task", task },
    });
  };
}

/** Best-effort metadata, not an agent operation. Never delays or retries a turn. */
export async function generateAutomaticTitle(options: {
  repository: ServerRepository;
  bridge: Pick<WorkerCommandBus, "request">;
  ownerId: string;
  chatId: string;
  input: Extract<WorkerCommand, { type: "label.generate" }>["input"];
  availableModelRuntimes(
    context: { workerId: string; providerAccountId?: string | null },
    modelId: string,
  ): Promise<ModelRuntime[]>;
  publishChatSummary(chatId: string, projectId: string | null): void;
  reconcileEmptyTask?: boolean;
}) {
  const { repository, ownerId, chatId } = options;
  let claimId: string | null = null;
  try {
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (!context) return;
    const kind: LabelKind =
      options.input.kind === "task"
        ? "task"
        : context.contextKind === "standalone"
          ? "chat"
          : "agent";
    // Task backing chats are named from their brief, never from a planner's synthesized prompt.
    if (kind !== "task" && context.experience === "task") return;
    const settings = await repository.getUserSettings(ownerId);
    if (!automaticNamingEnabled(settings, kind)) return;
    const modelId = settings.labelingModelId ?? settings.defaultModelId;
    if (!modelId) return;
    const claim = await repository.chatState.claimAutomaticTitle(
      ownerId,
      chatId,
      options.input.kind === "message" ? options.input.message.id : undefined,
    );
    if (!claim) return;
    claimId = claim.claimId;
    // Use normal account binding, but no quota-reset, failover, or corrective-turn path.
    const [runtime] = await options.availableModelRuntimes(context, modelId);
    if (!runtime) throw new Error("No labeling route.");
    const effort = lowestLabelingEffort(
      runtime.model.catalog?.supportedReasoningEfforts.map(
        ({ effort }) => effort,
      ),
      (settings.labelingModelId === null
        ? settings.defaultReasoningEffort
        : null) ??
        runtime.model.catalog?.defaultReasoningEffort ??
        null,
    );
    const result = generateLabelResultSchema.parse(
      await options.bridge.request(
        context.workerId,
        {
          type: "label.generate",
          chatId,
          labelKind: kind,
          input: options.input,
          model: { ...runtime.model, reasoningEffort: effort },
          provider: runtime.provider,
        },
        { timeoutMs: 30_000 },
      ),
    );
    const stillEnabled = automaticNamingEnabled(
      await repository.getUserSettings(ownerId),
      kind,
    );
    const updated = await repository.chatState.finishAutomaticTitle(
      ownerId,
      chatId,
      claimId,
      stillEnabled ? result.titleProtection : null,
      result.emptyInput,
    );
    claimId = null;
    if (updated && result.titleProtection && stillEnabled)
      options.publishChatSummary(chatId, updated.projectId);
    if (
      updated &&
      result.emptyInput &&
      options.input.kind === "task" &&
      options.reconcileEmptyTask !== false
    ) {
      // First submission can race an empty creation job. Reconcile it once;
      // never title an autosaved partial draft while the user is still typing.
      const latest = await repository.tasks.get(ownerId, chatId);
      if (
        latest &&
        latest.rowVersion > options.input.task.rowVersion &&
        latest.dispatch
      ) {
        await generateAutomaticTitle({
          ...options,
          input: { kind: "task", task: latest },
          reconcileEmptyTask: false,
        });
      }
    }
  } catch {
    // Do not log provider errors: they may contain the private input or generated label.
    serverLogger.debug("Automatic title unavailable", {
      event: "labeling.unavailable",
      chatId,
    });
  } finally {
    if (claimId)
      await repository.chatState
        .finishAutomaticTitle(ownerId, chatId, claimId, null)
        .catch(() => {});
  }
}
