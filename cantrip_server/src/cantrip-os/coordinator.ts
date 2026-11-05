import {
  cantripOsRunDefinitionResponseSchema,
  type cantripOsRunDefinitionApiSchema,
  cantripOsDispatchScopeSchema,
  cantripOsObservedInstanceSchema,
  cantripOsOperationResultSchema,
  cantripOsSourceDispatchScopeSchema,
  cantripOsSourceReceiptSchema,
  type cantripOsAttachSchema,
  type cantripOsBindingCreateSchema,
  type cantripOsInspectSchema,
  type cantripOsProvisionSchema,
  type cantripOsWorkspaceCreateSchema,
  type cantripOsRecoveryRequestSchema,
  type CantripOsDispatchScope,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import { CantripOsPlacementError } from "../db/repository/cantrip-os.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { recoverCantripOsInstance } from "./recovery.js";

const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};

export interface CantripOsDefinitionLifecycle {
  serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
  retire(
    ownerId: string,
    projectId: string,
    filter: { configurationId: string; projectSourceId: string },
  ): Promise<void>;
}

/** Server authority produces every dispatch scope from canonical owned rows.
 * Only the first durable admission may dispatch a provisioning mutation. */
export class CantripOsCoordinator {
  constructor(
    private readonly repository: Pick<
      ServerRepository,
      "cantripOs" | "getWorker"
    >,
    private readonly bridge: Pick<WorkerCommandBus, "request">,
    private readonly serverId: string,
    private readonly definitionLifecycle?: CantripOsDefinitionLifecycle,
  ) {}

  async runDefinition(
    ownerId: string,
    projectId: string,
    bindingId: string,
    input: ReturnType<typeof cantripOsRunDefinitionApiSchema.parse>,
  ) {
    const request = input.request;
    if (request.projectId !== projectId)
      return fail("The Run definition belongs to another project.");
    if (request.type !== "project.run-configuration-definitions.delete")
      return this.dispatchRunDefinition(ownerId, projectId, bindingId, input);
    const lifecycle = this.definitionLifecycle;
    if (!lifecycle)
      return fail(
        "Linux Run deletion requires its runtime lifecycle authority.",
      );
    return lifecycle.serialize(projectId, async () => {
      const current = await this.dispatchRunDefinition(
        ownerId,
        projectId,
        bindingId,
        {
          ...input,
          request: {
            type: "project.run-configuration-definitions.get",
            projectId,
            configurationId: request.request.id,
            operationId: crypto.randomUUID(),
          },
        },
      );
      if (current.result.operation !== "get")
        return fail("The Linux definition read was misrouted.");
      const found = current.result.result.found;
      const revision = found ? current.result.result.entry.revision : null;
      if (!found || revision !== request.request.expectedRevision)
        return cantripOsRunDefinitionResponseSchema.parse({
          source: current.source,
          result: {
            operation: "delete",
            operationId: request.operationId,
            projectId,
            result: {
              outcome: found ? "revision-mismatch" : "not-found",
              id: request.request.id,
              currentRevision: revision,
            },
          },
        });
      await lifecycle.retire(ownerId, projectId, {
        configurationId: request.request.id,
        projectSourceId: current.source.projectSourceId,
      });
      return this.dispatchRunDefinition(ownerId, projectId, bindingId, input);
    });
  }

  private async dispatchRunDefinition(
    ownerId: string,
    projectId: string,
    bindingId: string,
    input: ReturnType<typeof cantripOsRunDefinitionApiSchema.parse>,
  ) {
    if (input.request.projectId !== projectId)
      return fail("The Run definition belongs to another project.");
    if (input.bindingGeneration || input.attachmentGeneration) {
      const selected = await this.repository.cantripOs.bindingContext(
        ownerId,
        bindingId,
      );
      if (
        !selected ||
        selected.binding.projectId !== projectId ||
        (input.bindingGeneration &&
          selected.binding.bindingGeneration !== input.bindingGeneration) ||
        (input.attachmentGeneration &&
          selected.instance.attachmentGeneration !== input.attachmentGeneration)
      )
        return fail("The selected Linux definition source changed.");
    }
    const execution = await this.repository.cantripOs.runPrimary(
      ownerId,
      projectId,
      bindingId,
      input.runtimeGeneration,
    );
    const result = await this.bridge.request(
      execution.scope.workerId,
      {
        type: "cantrip-os.run-definition",
        execution,
        request: input.request,
      },
      { ownerId, timeoutMs: 180_000 },
    );
    const response = cantripOsRunDefinitionResponseSchema.parse({
      source: {
        bindingId: execution.scope.bindingId,
        worktreeId: execution.scope.worktreeId,
        projectSourceId: execution.scope.projectSourceId,
        guestPath: execution.scope.guestPath,
        runtimeGeneration: execution.scope.runtimeGeneration,
      },
      result,
    });
    if (
      response.result.operationId !== input.request.operationId ||
      response.result.projectId !== projectId ||
      `project.run-configuration-definitions.${response.result.operation}` !==
        input.request.type
    )
      return fail("The Linux Run definition response was misrouted.");
    return response;
  }

  async inspect(
    ownerId: string,
    input: ReturnType<typeof cantripOsInspectSchema.parse>,
  ) {
    if (!(await this.repository.getWorker(ownerId, input.workerId)))
      return fail("Owning worker not found.");
    return cantripOsObservedInstanceSchema.parse(
      await this.bridge.request(
        input.workerId,
        {
          type: "cantrip-os.inspect",
          ownerId,
          workerId: input.workerId,
          transport: input.transport,
        },
        { ownerId },
      ),
    );
  }

  private async attachment(ownerId: string, instanceId: string) {
    const attachment = await this.repository.cantripOs.attachment(
      ownerId,
      instanceId,
    );
    if (
      !attachment ||
      !(await this.repository.getWorker(ownerId, attachment.instance.workerId))
    )
      return fail("OS attachment not found.");
    return attachment;
  }

  private scope(
    ownerId: string,
    instance: {
      id: string;
      workerId: string;
      guestInstanceId: string;
      attachmentGeneration: string;
      runtimeGeneration: string | null;
    },
  ): CantripOsDispatchScope {
    if (!instance.runtimeGeneration)
      return fail("The OS has no current executor generation.");
    return cantripOsDispatchScopeSchema.parse({
      ownerId,
      serverId: this.serverId,
      workerId: instance.workerId,
      instanceId: instance.id,
      guestInstanceId: instance.guestInstanceId,
      attachmentGeneration: instance.attachmentGeneration,
      runtimeGeneration: instance.runtimeGeneration,
    });
  }

  async attach(
    ownerId: string,
    input: ReturnType<typeof cantripOsAttachSchema.parse>,
  ) {
    const actual = await this.inspect(ownerId, input);
    if (actual.guestInstanceId !== input.guestInstanceId)
      return fail("The selected transport points to a different OS instance.");
    if (
      actual.attachment &&
      (actual.attachment.ownerId !== ownerId ||
        actual.attachment.workerId !== input.workerId)
    )
      return fail(
        "The OS is attached elsewhere; explicitly detach it on that OS first.",
      );
    const admitted = await this.repository.cantripOs.attach(ownerId, input);
    const scope = this.scope(ownerId, {
      ...admitted,
      runtimeGeneration: actual.runtimeGeneration,
    });
    try {
      await this.bridge.request(
        input.workerId,
        { type: "cantrip-os.attach", scope, transport: input.transport },
        { ownerId },
      );
      return await this.refresh(ownerId, admitted.id);
    } catch (error) {
      await this.repository.cantripOs.observe(
        ownerId,
        admitted.id,
        admitted.attachmentGeneration,
        {
          status: "unknown",
          runtimeGeneration: null,
          lastError:
            "Attachment delivery is uncertain; refresh the OS before continuing.",
        },
        null,
      );
      throw error;
    }
  }

  recoverInstance(
    ownerId: string,
    instanceId: string,
    expected: ReturnType<typeof cantripOsRecoveryRequestSchema.parse>,
  ) {
    return recoverCantripOsInstance({
      ownerId,
      instanceId,
      expected,
      repository: this.repository,
      inspect: (input) => this.inspect(ownerId, input),
    });
  }

  async refresh(ownerId: string, instanceId: string) {
    const { instance, transport } = await this.attachment(ownerId, instanceId);
    try {
      const actual = await this.inspect(ownerId, {
        workerId: instance.workerId,
        transport,
      });
      if (
        actual.guestInstanceId !== instance.guestInstanceId ||
        actual.attachment?.ownerId !== ownerId ||
        actual.attachment.workerId !== instance.workerId
      )
        return fail("The OS identity or attachment changed.");
      for (const workspace of actual.workspaces)
        await this.repository.cantripOs.recordWorkspace(
          ownerId,
          instanceId,
          instance.attachmentGeneration,
          workspace,
        );
      const observed = await this.repository.cantripOs.observe(
        ownerId,
        instanceId,
        instance.attachmentGeneration,
        {
          status: "connected",
          runtimeGeneration: actual.runtimeGeneration,
          lastError: null,
        },
        instance.runtimeGeneration,
      );
      return {
        instance: observed,
        workspaces: await this.repository.cantripOs.listWorkspaces(
          ownerId,
          instanceId,
        ),
      };
    } catch (error) {
      await this.repository.cantripOs.observe(
        ownerId,
        instanceId,
        instance.attachmentGeneration,
        {
          status: "unknown",
          runtimeGeneration: instance.runtimeGeneration,
          lastError:
            "The executor could not be observed. Check recovery before continuing.",
        },
        instance.runtimeGeneration,
      );
      throw error;
    }
  }

  async createWorkspace(
    ownerId: string,
    instanceId: string,
    input: ReturnType<typeof cantripOsWorkspaceCreateSchema.parse>,
  ) {
    const { instance, transport } = await this.attachment(ownerId, instanceId);
    const result = cantripOsOperationResultSchema.parse(
      await this.bridge.request(
        instance.workerId,
        {
          type: "cantrip-os.workspaces.create",
          scope: this.scope(ownerId, instance),
          transport,
          ...input,
        },
        { ownerId },
      ),
    );
    if (result.state === "ready" && result.receipt.kind === "workspace")
      await this.repository.cantripOs.recordWorkspace(
        ownerId,
        instanceId,
        instance.attachmentGeneration,
        result.receipt.workspace,
      );
    return result;
  }

  async createBinding(
    ownerId: string,
    projectId: string,
    input: ReturnType<typeof cantripOsBindingCreateSchema.parse>,
  ) {
    if (input.mode === "linux-worktree")
      return this.repository.cantripOs.createLinuxWorktree(
        ownerId,
        projectId,
        input,
      );
    if (input.mode === "linux-owned")
      return (
        await this.repository.cantripOs.createLinuxSource(ownerId, {
          projectId,
          workspaceId: input.workspaceId,
          sourceKind: input.sourceKind,
        })
      ).binding;
    // Ownership alone is insufficient: a project route must not admit another
    // owned project's worktree under the requested project ID.
    const existing = await this.repository.cantripOs.linkableWorktree(
      ownerId,
      projectId,
      input.worktreeId,
    );
    if (!existing) return fail("Linked worktree not found in this project.");
    return this.repository.cantripOs.createLinkedBinding(ownerId, input);
  }

  private async source(ownerId: string, projectId: string, bindingId: string) {
    const context = await this.repository.cantripOs.bindingContext(
      ownerId,
      bindingId,
    );
    if (!context || context.binding.projectId !== projectId)
      return fail("Source binding not found.");
    if (!context.sourceMatches)
      return fail("The source location changed or was removed.");
    const { binding, instance, workspace } = context;
    const scope = cantripOsSourceDispatchScopeSchema.parse({
      ...this.scope(ownerId, instance),
      bindingId,
      bindingGeneration: binding.bindingGeneration,
      projectId,
      projectSourceId: binding.projectSourceId,
      worktreeId: binding.worktreeId,
      sourceKind: context.sourceKind,
      repositoryFingerprint: context.repositoryFingerprint,
      workspaceId: workspace.id,
      guestWorkspaceId: workspace.guestWorkspaceId,
      uid: workspace.uid,
      gid: workspace.gid,
      homeGuestPath: workspace.homeGuestPath,
      guestPath: binding.guestPath,
      mode: binding.mode,
      linkedWorkerPath: binding.linkedWorkerPath,
      dependencyOverlays: binding.dependencyOverlays,
    });
    return { ...context, scope };
  }

  async provision(
    ownerId: string,
    projectId: string,
    bindingId: string,
    input: ReturnType<typeof cantripOsProvisionSchema.parse>,
  ) {
    const context = await this.source(ownerId, projectId, bindingId);
    const { admission, created } =
      await this.repository.cantripOs.admitProvision(
        ownerId,
        context.scope,
        input,
      );
    // An existing admission is observation-only, including after Server restart.
    // A lost first dispatch stays unknown rather than repeating a mutation.
    let result: ReturnType<typeof cantripOsOperationResultSchema.parse>;
    try {
      result = cantripOsOperationResultSchema.parse(
        await this.bridge.request(
          context.instance.workerId,
          created
            ? {
                type: "cantrip-os.source.provision",
                scope: admission.scope,
                transport: context.transport,
                operationId: admission.operationId,
                protectedRequest: admission.protectedRequest,
              }
            : {
                type: "cantrip-os.operation.inspect",
                scope: cantripOsDispatchScopeSchema
                  .strip()
                  .parse(admission.scope),
                operationId: admission.operationId,
              },
          { ownerId, timeoutMs: 600_000 },
        ),
      );
    } catch (error) {
      // Even a missing response can follow a successful guest mutation.
      await this.repository.cantripOs.recordBindingOutcome(
        ownerId,
        bindingId,
        {
          bindingGeneration: context.binding.bindingGeneration,
          attachmentGeneration: context.instance.attachmentGeneration,
          runtimeGeneration: context.instance.runtimeGeneration!,
        },
        {
          state: "unknown",
          lastError:
            "Provisioning delivery is uncertain; recover this operation without replaying it.",
        },
      );
      throw error;
    }

    return this.applyResult(ownerId, projectId, bindingId, result);
  }

  async recover(ownerId: string, projectId: string, bindingId: string) {
    const context = await this.repository.cantripOs.bindingContext(
      ownerId,
      bindingId,
    );
    if (
      !context ||
      context.binding.projectId !== projectId ||
      !context.sourceMatches
    )
      return fail("Source binding not found.");
    const admission = await this.repository.cantripOs.provisionAdmission(
      ownerId,
      bindingId,
    );
    if (!admission) return fail("This source has no provisioning admission.");
    const result = cantripOsOperationResultSchema.parse(
      await this.bridge.request(
        context.instance.workerId,
        {
          type: "cantrip-os.operation.inspect",
          scope: cantripOsDispatchScopeSchema.strip().parse(admission.scope),
          operationId: admission.operationId,
        },
        { ownerId },
      ),
    );
    return this.applyResult(ownerId, projectId, bindingId, result);
  }

  private async applyResult(
    ownerId: string,
    projectId: string,
    bindingId: string,
    result: ReturnType<typeof cantripOsOperationResultSchema.parse>,
  ) {
    if (result.state === "running") return result;
    const original = await this.repository.cantripOs.bindingContext(
      ownerId,
      bindingId,
    );
    if (
      !original ||
      original.binding.projectId !== projectId ||
      !original.sourceMatches
    )
      return fail("Source binding not found.");
    let instance: Awaited<
      ReturnType<CantripOsCoordinator["refresh"]>
    >["instance"];
    try {
      ({ instance } = await this.refresh(ownerId, original.instance.id));
    } catch {
      return result;
    } // Saved operation outcome remains observable while the OS is unavailable.

    const context = await this.source(ownerId, projectId, bindingId);
    const receipt =
      result.receipt?.kind === "source" ? result.receipt.source : undefined;
    const current =
      result.state === "ready" &&
      receipt?.runtimeGeneration === instance.runtimeGeneration;
    await this.repository.cantripOs.recordBindingOutcome(
      ownerId,
      bindingId,
      {
        bindingGeneration: context.binding.bindingGeneration,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: instance.runtimeGeneration!,
      },
      {
        state: current
          ? "ready"
          : result.state === "failed"
            ? "failed"
            : "unknown",
        lastError: current
          ? null
          : (result.error ??
            "The source needs read-only verification in the current runtime."),
        ...(current ? { sourceReceipt: receipt } : {}),
      },
    );
    return result;
  }

  /** Explicit read-only verification can revalidate retained bytes after a new
   * executor generation. It never repeats a clone, checkout, or Docker mount. */
  async verify(ownerId: string, projectId: string, bindingId: string) {
    const context = await this.source(ownerId, projectId, bindingId);
    const receipt = cantripOsSourceReceiptSchema.parse(
      await this.bridge.request(
        context.instance.workerId,
        {
          type: "cantrip-os.source.inspect",
          scope: context.scope,
          transport: context.transport,
          sourceKind: context.sourceKind,
        },
        { ownerId },
      ),
    );
    return this.repository.cantripOs.recordBindingOutcome(
      ownerId,
      bindingId,
      {
        bindingGeneration: context.binding.bindingGeneration,
        attachmentGeneration: context.instance.attachmentGeneration,
        runtimeGeneration: context.instance.runtimeGeneration!,
      },
      { state: "ready", lastError: null, sourceReceipt: receipt },
    );
  }
}
