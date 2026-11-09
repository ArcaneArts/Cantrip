import type { CantripOsRunSelection } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import { CantripOsPlacementError } from "../../db/repository/cantrip-os.js";
import { cantripOsExecutionForSource } from "../../db/repository/cantrip-os-chats.js";
import { osRunExecutionKey } from "../../db/repository/cantrip-os-run-capture.js";

/** Public requests name an owned source or an existing captured runtime. They
 * never supply executable paths, guest accounts, or executor transport details. */
export async function resolveOsRunSource(
  repository: ServerRepository,
  ownerId: string,
  projectId: string,
  selection: CantripOsRunSelection,
  targetWorktreeId: string | null,
) {
  if (selection.kind === "runtime") {
    const captured = await repository.getRunConfigurationRuntimeCapture(
      ownerId,
      selection.runtimeId,
    );
    if (
      !captured?.osExecution ||
      captured.runtime.projectId !== projectId ||
      (targetWorktreeId !== null &&
        captured.runtime.worktreeId !== targetWorktreeId)
    )
      throw new CantripOsPlacementError(
        "The captured Linux Run was not found for this target.",
      );
    return { ...captured, osExecution: captured.osExecution };
  }
  const selected = await repository.cantripOs.bindingContext(
    ownerId,
    selection.bindingId,
  );
  if (
    !selected?.available ||
    selected.binding.projectId !== projectId ||
    selected.binding.bindingGeneration !== selection.bindingGeneration ||
    selected.instance.attachmentGeneration !== selection.attachmentGeneration ||
    selected.instance.runtimeGeneration !== selection.runtimeGeneration
  )
    throw new CantripOsPlacementError(
      "The selected Linux Run source changed or is unavailable; no host fallback was attempted.",
    );
  const definitions = await repository.cantripOs.runPrimary(
    ownerId,
    projectId,
    selection.bindingId,
    selection.runtimeGeneration,
  );
  let target = definitions;
  if (
    targetWorktreeId !== null &&
    targetWorktreeId !== definitions.scope.worktreeId
  ) {
    const bindings = (
      await repository.cantripOs.listBindings(ownerId, projectId)
    ).filter(
      (binding) =>
        binding.worktreeId === targetWorktreeId &&
        binding.projectSourceId === selected.binding.projectSourceId &&
        binding.workspaceId === selected.workspace.id,
    );
    if (bindings.length !== 1)
      throw new CantripOsPlacementError(
        "This worktree needs one explicit binding in the selected Linux source and workspace.",
      );
    const binding = bindings[0]!;
    const context = await repository.cantripOs.executionContext(
      ownerId,
      binding.id,
      {
        bindingGeneration: binding.bindingGeneration,
        attachmentGeneration: selection.attachmentGeneration,
        runtimeGeneration: selection.runtimeGeneration,
      },
    );
    target = cantripOsExecutionForSource(ownerId, context, {
      bindingGeneration: binding.bindingGeneration,
      attachmentGeneration: selection.attachmentGeneration,
      runtimeGeneration: selection.runtimeGeneration,
    });
  }
  const osExecution = { definitions, target };
  return {
    runtime: null,
    osExecution,
    executionKey: osRunExecutionKey(osExecution),
  };
}
