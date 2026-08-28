import {
  cantripCliCommandResultSchema,
  encryptedBrowserCreateSchema,
  executionTargetSchema,
  type AppLiveResource,
  type CantripCliCommandName,
  type CantripCliCommandResult,
  type WorkerCliCommandCall,
} from "@cantrip/protocol";
import { runConfigurationApiWriteRequestSchema } from "@cantrip/protocol/run-configuration-operations";
import {
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
} from "@cantrip/protocol/run-configuration-secrets";

import { CliCommandRequestError } from "../../agent-tools/errors.js";
import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../../chats/execution-helpers.js";
import {
  ExecutionLaneConflictError,
  type ServerRepository,
} from "../../db/repository.js";
import type { FocusedExecutionTargetResourceKind } from "../../execution-targets/catalog.js";
import {
  optionalToolString,
  requiredToolString,
} from "../../http/request-helpers.js";
import type { AppLiveHub } from "../../live/hub.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { createAgentOperationRuntime } from "./agent-operation-runtime.js";
import type {
  createRunConfigurationRuntime,
  ExecutionOperationContext,
} from "./run-configuration-runtime.js";

type AgentOperationRuntime = ReturnType<typeof createAgentOperationRuntime>;
type RunConfigurationRuntime = ReturnType<typeof createRunConfigurationRuntime>;

type AgentOperationDependencies = Pick<
  AgentOperationRuntime,
  "agentOperationExecutor" | "chatOperationContext"
>;

type RunOperationDependencies = Pick<
  RunConfigurationRuntime,
  | "deleteRunConfigurationDefinition"
  | "detectRunConfigurationDefinitions"
  | "getRunConfigurationDefinition"
  | "listRunConfigurationDefinitions"
  | "operateRunConfigurationRuntime"
  | "queryRunConfigurationRuntimeStatus"
  | "readRunConfigurationRuntimeOutput"
  | "resolveRunConfigurationRuntimeTarget"
  | "writeRunConfigurationDefinition"
>;

export interface CliOperationRuntimeDependencies
  extends AgentOperationDependencies, RunOperationDependencies {
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  liveHub: Pick<AppLiveHub, "requestClientControl">;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
}

/** Resolves CLI execution scope and executes the supported Cantrip commands. */
export function createCliOperationRuntime({
  agentOperationExecutor,
  applicationOwnerId,
  bridge,
  chatOperationContext,
  deleteRunConfigurationDefinition,
  detectRunConfigurationDefinitions,
  getRunConfigurationDefinition,
  listRunConfigurationDefinitions,
  liveHub,
  operateRunConfigurationRuntime,
  publishLiveInvalidation,
  queryRunConfigurationRuntimeStatus,
  readRunConfigurationRuntimeOutput,
  repository,
  resolveRunConfigurationRuntimeTarget,
  writeRunConfigurationDefinition,
}: CliOperationRuntimeDependencies) {
  const normalizedWorkerPath = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
    return /^[A-Za-z]:\//u.test(normalized)
      ? normalized.toLocaleLowerCase()
      : normalized || "/";
  };

  const pathIsInside = (candidate: string, root: string) => {
    const normalizedCandidate = normalizedWorkerPath(candidate);
    const normalizedRoot = normalizedWorkerPath(root);
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(
        normalizedRoot === "/" ? "/" : `${normalizedRoot}/`,
      )
    );
  };

  const cliMutationCommands = new Set<CantripCliCommandName>([
    "worktree.create",
    "worktree.switch",
    "worktree.release",
    "worktree.remove",
    "run.create",
    "run.update",
    "run.delete",
    "run.start",
    "run.restart",
    "run.stop",
    "run.secret-set",
    "explorer.write",
    "terminal.send",
    "terminal.restart",
    "browser.create",
    "browser.open",
  ]);
  const cliCommandIsMutation = (command: CantripCliCommandName) =>
    cliMutationCommands.has(command);

  const resolveCliBoundExecutionContext = async (
    call: WorkerCliCommandCall,
  ): Promise<ExecutionOperationContext | null> => {
    if (call.chatContext) {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        call.chatContext.chatId,
      );
      if (!context) {
        throw new CliCommandRequestError(
          "context-not-found",
          404,
          "Chat execution context not found.",
        );
      }
      if (
        context.workerId !== call.workerId ||
        context.executionLaneId !== call.chatContext.executionLaneId ||
        !chatIsExecuting(context.status)
      ) {
        throw new ExecutionLaneConflictError(
          "The CLI command did not originate from the active chat lane.",
        );
      }
      return chatOperationContext(context);
    }
    if (call.context.codexThreadId) {
      const contexts = await repository.listChatExecutionContextsByThreadId(
        applicationOwnerId(),
        call.workerId,
        call.context.codexThreadId,
      );
      if (contexts.length > 1) {
        throw new CliCommandRequestError(
          "ambiguous",
          409,
          "More than one chat uses this Codex thread. Open the intended chat and retry.",
        );
      }
      if (contexts[0]) return chatOperationContext(contexts[0]);
    }

    if (call.context.terminalId) {
      const terminal = await repository.getTerminalExecutionContext(
        applicationOwnerId(),
        call.context.terminalId,
      );
      if (terminal?.workerId === call.workerId) {
        const chat = terminal.linkedChatId
          ? await repository.getChatExecutionContext(
              applicationOwnerId(),
              terminal.linkedChatId,
            )
          : null;
        const matchedChat =
          chat?.workerId === terminal.workerId &&
          chat.worktreeId === terminal.worktreeId
            ? chat
            : null;
        return {
          chatId: matchedChat?.chatId ?? null,
          executionLaneId: matchedChat?.executionLaneId ?? null,
          permissionProfileId: matchedChat
            ? effectivePermissionProfile(matchedChat).effectiveId
            : null,
          projectId: terminal.projectId,
          rootKind: terminal.rootKind,
          terminalId: terminal.terminalId,
          workerId: terminal.workerId,
          worktreeId: terminal.worktreeId,
          worktreeMode: matchedChat?.worktreeMode ?? null,
        };
      }
    }

    return null;
  };

  const resolveCliCwdExecutionContext = async (
    call: WorkerCliCommandCall,
  ): Promise<ExecutionOperationContext | null> => {
    if (call.context.cwd) {
      const candidates = (
        await repository.listWorkerExecutionRootContexts(
          applicationOwnerId(),
          call.workerId,
          128,
        )
      )
        .filter(({ worktreePath }) =>
          pathIsInside(call.context.cwd!, worktreePath),
        )
        .sort(
          (left, right) =>
            normalizedWorkerPath(right.worktreePath).length -
            normalizedWorkerPath(left.worktreePath).length,
        );
      const best = candidates[0];
      if (best) {
        const bestLength = normalizedWorkerPath(best.worktreePath).length;
        if (
          candidates.some(
            (candidate, index) =>
              index > 0 &&
              normalizedWorkerPath(candidate.worktreePath).length ===
                bestLength,
          )
        ) {
          throw new CliCommandRequestError(
            "ambiguous",
            409,
            "The current directory belongs to more than one Cantrip project root.",
          );
        }
        return {
          chatId: null,
          executionLaneId: null,
          permissionProfileId: null,
          projectId: best.projectId,
          rootKind: best.rootKind,
          terminalId: null,
          workerId: best.workerId,
          worktreeId: best.worktreeId,
          worktreeMode: null,
        };
      }
    }

    return null;
  };

  const sameCliExecutionPlacement = (
    left: ExecutionOperationContext,
    right: ExecutionOperationContext,
  ) =>
    left.projectId === right.projectId &&
    left.workerId === right.workerId &&
    left.worktreeId === right.worktreeId;

  const resolveCliExecutionContext = async (
    call: WorkerCliCommandCall,
    allowMissing = false,
  ): Promise<ExecutionOperationContext | null> => {
    const selection = call.context.selection;
    if (selection === "cwd") {
      const cwd = await resolveCliCwdExecutionContext(call);
      if (cwd) return cwd;
      throw new CliCommandRequestError(
        "context-not-found",
        400,
        "--context cwd was requested, but the current directory is not inside a Cantrip project root.",
      );
    }
    if (selection === "lane") {
      const bound = await resolveCliBoundExecutionContext(call);
      if (bound) return bound;
      throw new CliCommandRequestError(
        "context-not-found",
        400,
        "--context lane was requested, but no active chat or Terminal lane is bound to this process.",
      );
    }

    const [bound, cwd] = await Promise.all([
      resolveCliBoundExecutionContext(call),
      resolveCliCwdExecutionContext(call),
    ]);
    if (
      bound &&
      cwd &&
      cliCommandIsMutation(call.command) &&
      !sameCliExecutionPlacement(bound, cwd)
    ) {
      throw new CliCommandRequestError(
        "conflict",
        409,
        `Cantrip refused to mutate because the bound lane targets project ${bound.projectId}, worktree ${bound.worktreeId}, while cwd targets project ${cwd.projectId}, worktree ${cwd.worktreeId}. Retry explicitly with --context lane or --context cwd. The mutation did not start.`,
      );
    }
    if (bound) return bound;
    if (cwd) return cwd;

    if (allowMissing) return null;
    throw new CliCommandRequestError(
      "context-not-found",
      400,
      "Cantrip could not infer a project. Run this command inside a Cantrip chat, Terminal tab, or project root.",
    );
  };

  const ambiguousSelection = (
    noun: string,
    matches: Array<{ id: string; title: string }>,
  ) =>
    new CliCommandRequestError(
      "ambiguous",
      409,
      `Multiple ${noun} targets match: ${matches
        .slice(0, 8)
        .map(({ id, title }) => `${title} (${id.slice(0, 8)})`)
        .join(", ")}. Retry with a unique title or full ID.`,
    );

  const requireCliChatLane = (context: ExecutionOperationContext) => {
    if (!context.chatId || !context.executionLaneId) {
      throw new CliCommandRequestError(
        "conflict",
        409,
        "This operation needs an active Cantrip chat. Run it from Codex in that chat.",
      );
    }
  };

  const selectWorktree = async (
    context: ExecutionOperationContext,
    selector: string | null,
  ) => {
    const worktrees = await repository.listProjectWorktrees(
      applicationOwnerId(),
      context.projectId,
    );
    if (!selector) {
      const current = worktrees.find(({ id }) => id === context.worktreeId);
      if (current) return current;
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The current worktree is no longer registered.",
      );
    }
    const wanted = selector.toLocaleLowerCase();
    const exact = worktrees.filter(
      ({ branch, id, name }) =>
        id === selector ||
        name.toLocaleLowerCase() === wanted ||
        branch?.toLocaleLowerCase() === wanted,
    );
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) {
      throw ambiguousSelection(
        "worktree",
        exact.map(({ id, name }) => ({ id, title: name })),
      );
    }
    const prefixes = worktrees.filter(({ id }) => id.startsWith(selector));
    if (prefixes.length === 1) return prefixes[0]!;
    if (prefixes.length > 1) {
      throw ambiguousSelection(
        "worktree",
        prefixes.map(({ id, name }) => ({ id, title: name })),
      );
    }
    throw new CliCommandRequestError(
      "not-found",
      404,
      `Worktree ${selector} was not found. Run \`cantrip worktree list\` to see available worktrees.`,
    );
  };

  const selectTarget = async (
    context: ExecutionOperationContext,
    resourceKind: FocusedExecutionTargetResourceKind | null,
    selector: string | null,
  ) => {
    const result = await repository.resolveExecutionTargetSelector(
      applicationOwnerId(),
      context.projectId,
      resourceKind,
      selector,
      {
        terminalId: context.terminalId,
        workerId: context.workerId,
        worktreeId: context.worktreeId,
      },
      (workerId) => bridge.isConnected(workerId),
    );
    if (!result) {
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The current project no longer exists.",
      );
    }
    if (result.outcome === "selected") return result;
    if (result.outcome === "ambiguous") {
      throw ambiguousSelection(resourceKind ?? "execution", result.matches);
    }
    if (result.outcome === "not-found") {
      throw new CliCommandRequestError(
        "not-found",
        404,
        `Target ${selector} was not found. Run \`cantrip target list${
          resourceKind ? ` --kind ${resourceKind}` : ""
        }\` to see available targets.`,
      );
    }
    throw new CliCommandRequestError(
      "unavailable",
      503,
      `No available ${resourceKind ?? "execution"} target was found.`,
    );
  };

  const derivedWorktreeBranch = async (
    context: ExecutionOperationContext,
    name: string,
  ) => {
    const slug = name
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48);
    const prefix = `cantrip/${slug || "worktree"}`;
    const branches = new Set(
      (
        await repository.listProjectWorktrees(
          applicationOwnerId(),
          context.projectId,
        )
      )
        .map(({ branch }) => branch)
        .filter((branch): branch is string => Boolean(branch)),
    );
    if (!branches.has(prefix)) return prefix;
    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${prefix}-${suffix}`;
      if (!branches.has(candidate)) return candidate;
    }
    throw new CliCommandRequestError(
      "conflict",
      409,
      "Could not derive a unique worktree branch. Retry with --branch.",
    );
  };

  const executeCliCommand = async (
    call: WorkerCliCommandCall,
  ): Promise<CantripCliCommandResult> => {
    const context = await resolveCliExecutionContext(
      call,
      call.command === "status",
    );
    if (call.command === "status") {
      if (context) {
        return agentOperationExecutor.execute(context, {
          operation: "context.get",
          arguments: {},
        });
      }
      const worker = await repository.getWorker(
        applicationOwnerId(),
        call.workerId,
      );
      if (!worker) {
        throw new CliCommandRequestError(
          "not-found",
          404,
          "The connected worker is no longer registered.",
        );
      }
      return cantripCliCommandResultSchema.parse({
        summary: `Connected through ${worker.name}; no project context was inferred.`,
        data: {
          worker: {
            id: worker.workerId,
            name: worker.name,
            online: bridge.isConnected(call.workerId),
          },
          context,
        },
      });
    }
    if (!context) {
      throw new CliCommandRequestError(
        "context-not-found",
        400,
        "Cantrip project context is required.",
      );
    }

    if (call.command.startsWith("worktree.")) {
      const project = await repository.getProject(
        applicationOwnerId(),
        context.projectId,
      );
      if (!project?.capabilities.worktrees) {
        throw new CliCommandRequestError(
          "unsupported-capability",
          409,
          "This worker-managed folder does not support Cantrip worktree commands.",
        );
      }
    }

    const selector = optionalToolString(call.arguments, "target");
    const mutationResult = async (
      operation: Promise<CantripCliCommandResult>,
    ) => {
      const result = await operation;
      const contextSummary = ` CLI context: project ${context.projectId}, worktree ${context.worktreeId}.`;
      return cantripCliCommandResultSchema.parse({
        ...result,
        summary: `${result.summary.slice(0, 2_000 - contextSummary.length)}${contextSummary}`,
        mutated: true,
      });
    };
    switch (call.command) {
      case "policy.list":
        return agentOperationExecutor.execute(context, {
          operation: "policy.list",
          arguments: {},
        });
      case "policy.read":
        return agentOperationExecutor.execute(context, {
          operation: "policy.read",
          arguments: {
            policyId: requiredToolString(call.arguments, "policyId"),
          },
        });
      case "run.list": {
        const { result, source } = await listRunConfigurationDefinitions(
          applicationOwnerId(),
          context.projectId,
          call.requestId,
        );
        const runtimes = await repository.listRunConfigurationRuntimes(
          applicationOwnerId(),
          context.projectId,
          { limit: 256 },
        );
        const activeConfigurationIds = new Set(
          runtimes
            .filter(({ state }) =>
              ["starting", "running", "restarting", "stopping"].includes(state),
            )
            .map(({ configurationId }) => configurationId),
        );
        const entries = [...result.inventory.entries].sort(
          (left, right) =>
            Number(activeConfigurationIds.has(right.id ?? "")) -
            Number(activeConfigurationIds.has(left.id ?? "")),
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${result.inventory.entries.length} project Run configuration${result.inventory.entries.length === 1 ? "" : "s"}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: source.worktreeId,
          data: {
            ...result,
            inventory: { ...result.inventory, entries },
            runtimes,
          },
        });
      }
      case "run.show": {
        const configurationId = requiredToolString(
          call.arguments,
          "configurationId",
        );
        const { result, source } = await getRunConfigurationDefinition(
          applicationOwnerId(),
          context.projectId,
          call.requestId,
          configurationId,
        );
        if (!result.result.found) {
          throw new CliCommandRequestError(
            "not-found",
            404,
            `Run configuration ${configurationId} was not found.`,
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `Read Run configuration ${configurationId}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: source.worktreeId,
          data: result,
        });
      }
      case "run.detect": {
        const { result, source } = await detectRunConfigurationDefinitions(
          applicationOwnerId(),
          context.projectId,
          call.requestId,
          call.arguments.provider,
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Detected ${result.candidates.length} Run configuration candidate${result.candidates.length === 1 ? "" : "s"}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: source.worktreeId,
          data: result,
        });
      }
      case "run.create":
      case "run.update": {
        if (context.permissionProfileId === ":read-only") {
          throw new CliCommandRequestError(
            "conflict",
            409,
            "Run configuration mutations are unavailable in a read-only execution context.",
          );
        }
        const expectedRevision =
          call.command === "run.create"
            ? null
            : requiredToolString(call.arguments, "revision");
        const writeInput = runConfigurationApiWriteRequestSchema.parse({
          operationId: call.requestId,
          expectedRevision,
          document: call.arguments.document,
        });
        if (
          call.command === "run.update" &&
          writeInput.document.id !==
            requiredToolString(call.arguments, "configurationId")
        ) {
          throw new CliCommandRequestError(
            "invalid",
            400,
            "The requested and document configuration IDs must match.",
          );
        }
        const { result, source } = await writeRunConfigurationDefinition(
          applicationOwnerId(),
          context.projectId,
          call.requestId,
          expectedRevision,
          writeInput.document,
        );
        const configurationId =
          "entry" in result.result ? result.result.entry.id : result.result.id;
        if (!("entry" in result.result)) {
          throw new CliCommandRequestError(
            "conflict",
            409,
            `Run configuration write was rejected: ${result.result.outcome}.`,
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `${result.result.outcome === "created" ? "Created" : "Updated"} Run configuration ${configurationId}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: source.worktreeId,
          mutated: result.result.outcome !== "unchanged",
          data: result,
        });
      }
      case "run.delete": {
        if (context.permissionProfileId === ":read-only") {
          throw new CliCommandRequestError(
            "conflict",
            409,
            "Run configuration mutations are unavailable in a read-only execution context.",
          );
        }
        const configurationId = requiredToolString(
          call.arguments,
          "configurationId",
        );
        const { result, source } = await deleteRunConfigurationDefinition(
          applicationOwnerId(),
          context.projectId,
          call.requestId,
          configurationId,
          requiredToolString(call.arguments, "revision"),
        );
        if (result.result.outcome !== "deleted") {
          throw new CliCommandRequestError(
            result.result.outcome === "not-found" ? "not-found" : "conflict",
            result.result.outcome === "not-found" ? 404 : 409,
            `Run configuration delete was rejected: ${result.result.outcome}.`,
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `Deleted Run configuration ${configurationId}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: source.worktreeId,
          mutated: true,
          data: result,
        });
      }
      case "run.start":
      case "run.restart":
      case "run.stop": {
        if (context.permissionProfileId === ":read-only") {
          throw new CliCommandRequestError(
            "conflict",
            409,
            "Run configuration mutations are unavailable in a read-only execution context.",
          );
        }
        const result = await operateRunConfigurationRuntime(
          applicationOwnerId(),
          {
            operationId: call.requestId,
            projectId: context.projectId,
            configurationId: requiredToolString(
              call.arguments,
              "configurationId",
            ),
            targetWorktreeId:
              optionalToolString(call.arguments, "worktreeId") ?? null,
            operation:
              call.command === "run.start"
                ? "start"
                : call.command === "run.restart"
                  ? "restart"
                  : "stop",
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `${result.operation.operation} ${result.operation.outcome} for Run configuration ${result.operation.configurationId}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: result.operation.worktreeId,
          mutated: result.operation.outcome === "accepted",
          data: result,
        });
      }
      case "run.status": {
        const result = await queryRunConfigurationRuntimeStatus(
          applicationOwnerId(),
          {
            operationId: call.requestId,
            projectId: context.projectId,
            configurationId:
              optionalToolString(call.arguments, "configurationId") ?? null,
            targetWorktreeId:
              optionalToolString(call.arguments, "worktreeId") ?? null,
            limit: 256,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${result.runtimes.length} Run configuration runtime${result.runtimes.length === 1 ? "" : "s"}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: optionalToolString(call.arguments, "worktreeId"),
          data: result,
        });
      }
      case "run.logs": {
        const target = await resolveRunConfigurationRuntimeTarget(
          applicationOwnerId(),
          context.projectId,
          optionalToolString(call.arguments, "worktreeId"),
        );
        const result = await readRunConfigurationRuntimeOutput(
          applicationOwnerId(),
          {
            operationId: call.requestId,
            projectId: context.projectId,
            configurationId: requiredToolString(
              call.arguments,
              "configurationId",
            ),
            worktreeId: target.worktree.id,
            tail: call.arguments.tail,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Read Run configuration ${result.configurationId} output.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: result.worktreeId,
          data: result,
        });
      }
      case "run.secret-set": {
        if (context.permissionProfileId === ":read-only") {
          throw new CliCommandRequestError(
            "conflict",
            409,
            "Run configuration mutations are unavailable in a read-only execution context.",
          );
        }
        const input = runConfigurationSecretSetRequestSchema.parse({
          operationId: call.requestId,
          reference: call.arguments.reference,
          protectedValue: call.arguments.protectedValue,
        });
        const result = runConfigurationSecretSetResultSchema.parse(
          await repository.setRunConfigurationSecret(
            applicationOwnerId(),
            context.projectId,
            input,
          ),
        );
        publishLiveInvalidation("run-configuration", {
          entityId: null,
          projectId: context.projectId,
        });
        return cantripCliCommandResultSchema.parse({
          summary: `Stored Run configuration secret ${result.secret.reference}.`,
          target: { kind: "project", projectId: context.projectId },
          worktreeId: null,
          mutated: !result.replayed,
          data: result,
        });
      }
      case "worktree.list":
        return agentOperationExecutor.execute(context, {
          operation: "worktree.list",
          arguments: {},
        });
      case "worktree.create": {
        const name = requiredToolString(call.arguments, "name");
        const intent = requiredToolString(call.arguments, "intent");
        const branch =
          intent === "newBranch"
            ? (optionalToolString(call.arguments, "branch") ??
              (await derivedWorktreeBranch(context, name)))
            : optionalToolString(call.arguments, "branch");
        const shouldSwitch = call.arguments.switch === true;
        if (shouldSwitch) requireCliChatLane(context);
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: shouldSwitch ? "worktree.acquire" : "worktree.create",
            arguments: {
              name,
              intent,
              branch,
              baseRevision: optionalToolString(call.arguments, "baseRevision"),
              ...(shouldSwitch
                ? { purpose: `Continue in ${name} from the Cantrip CLI` }
                : {}),
            },
          }),
        );
      }
      case "worktree.switch": {
        requireCliChatLane(context);
        const worktree = await selectWorktree(
          context,
          requiredToolString(call.arguments, "worktree"),
        );
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "worktree.switch",
            arguments: {
              worktreeId: worktree.id,
              purpose: `Switch to ${worktree.name} from the Cantrip CLI`,
            },
          }),
        );
      }
      case "worktree.status": {
        const worktree = await selectWorktree(
          context,
          optionalToolString(call.arguments, "worktree"),
        );
        return agentOperationExecutor.execute(context, {
          operation: "worktree.status",
          arguments: { worktreeId: worktree.id },
        });
      }
      case "worktree.release":
        requireCliChatLane(context);
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "worktree.release",
            arguments: { purpose: "Release from the Cantrip CLI" },
          }),
        );
      case "worktree.remove": {
        const worktree = await selectWorktree(
          context,
          requiredToolString(call.arguments, "worktree"),
        );
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "worktree.remove",
            arguments: { worktreeId: worktree.id },
          }),
        );
      }
      case "target.list": {
        const kindValue = optionalToolString(call.arguments, "kind");
        return agentOperationExecutor.execute(context, {
          operation: "target.list",
          arguments: kindValue ? { kind: kindValue } : {},
        });
      }
      case "target.show": {
        const target = await selectTarget(
          context,
          selector
            ? null
            : context.rootKind === "folder-root"
              ? "worker"
              : "worktree",
          selector,
        );
        return agentOperationExecutor.execute(context, {
          operation: "target.inspect",
          arguments: { target: target.target },
        });
      }
      case "target.resolve-browser": {
        let target;
        try {
          target = await selectTarget(context, "browser", selector);
        } catch (error) {
          if (
            selector ||
            !(error instanceof CliCommandRequestError) ||
            error.code !== "unavailable"
          ) {
            throw error;
          }
          target = await selectTarget(
            context,
            context.rootKind === "folder-root" ? "worker" : "worktree",
            null,
          );
        }
        return agentOperationExecutor.execute(context, {
          operation: "target.inspect",
          arguments: { target: target.target },
        });
      }
      case "target.resolve-explorer": {
        const target = await selectTarget(context, "explorer", selector);
        return agentOperationExecutor.execute(context, {
          operation: "target.inspect",
          arguments: { target: target.target },
        });
      }
      case "target.resolve-terminal": {
        const target = await selectTarget(context, "terminal", selector);
        return agentOperationExecutor.execute(context, {
          operation: "target.inspect",
          arguments: { target: target.target },
        });
      }
      case "explorer.list": {
        const target = await selectTarget(context, "explorer", selector);
        return agentOperationExecutor.execute(context, {
          operation: "explorer.list",
          arguments: { ...call.arguments, target: target.target },
        });
      }
      case "explorer.read": {
        const target = await selectTarget(context, "explorer", selector);
        return agentOperationExecutor.execute(context, {
          operation: "explorer.read",
          arguments: { ...call.arguments, target: target.target },
        });
      }
      case "explorer.write": {
        const target = await selectTarget(context, "explorer", selector);
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "explorer.write",
            arguments: { ...call.arguments, target: target.target },
          }),
        );
      }
      case "terminal.read": {
        const target = await selectTarget(context, "terminal", selector);
        return agentOperationExecutor.execute(context, {
          operation: "terminal.read",
          arguments: { ...call.arguments, target: target.target },
        });
      }
      case "terminal.send": {
        const target = await selectTarget(context, "terminal", selector);
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "terminal.send",
            arguments: { ...call.arguments, target: target.target },
          }),
        );
      }
      case "terminal.restart": {
        const target = await selectTarget(context, "terminal", selector);
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "terminal.restart",
            arguments: { target: target.target },
          }),
        );
      }
      case "browser.services": {
        const target = await selectTarget(context, "browser", selector);
        return agentOperationExecutor.execute(context, {
          operation: "browser.services",
          arguments: { target: target.target },
        });
      }
      case "browser.create": {
        const input = encryptedBrowserCreateSchema.parse(call.arguments);
        const browser = await repository.createBrowser(
          applicationOwnerId(),
          context.projectId,
          input,
          (workerId) => bridge.isConnected(workerId),
        );
        if (!browser) throw new Error("Browser project was not found.");
        publishLiveInvalidation("browser", {
          entityId: browser.id,
          projectId: context.projectId,
        });
        publishLiveInvalidation("project-tab-layout", {
          entityId: browser.id,
          projectId: context.projectId,
        });
        const target = executionTargetSchema.parse({
          kind: "surface",
          projectId: context.projectId,
          surfaceKind: "browser",
          surfaceId: browser.id,
        });
        await liveHub.requestClientControl(applicationOwnerId(), {
          kind: "focus-surface",
          projectId: context.projectId,
          surfaceKind: "browser",
          surfaceId: browser.id,
        });
        return mutationResult(
          Promise.resolve(
            cantripCliCommandResultSchema.parse({
              summary: "Opened a new Browser tab.",
              target,
              worktreeId: context.worktreeId,
              mutated: true,
              data: browser,
            }),
          ),
        );
      }
      case "browser.open": {
        const target = await selectTarget(context, "browser", selector);
        return mutationResult(
          agentOperationExecutor.execute(context, {
            operation: "browser.open",
            arguments: {
              target: target.target,
              expectedStateRevision: call.arguments.expectedStateRevision,
              stateProtection: call.arguments.stateProtection,
            },
          }),
        );
      }
    }
  };

  return { cliCommandIsMutation, executeCliCommand };
}
