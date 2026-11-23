import type { WorkerEvent } from "@cantrip/protocol";
import {
  cuaApprovalRequestEventSchema,
  cuaApprovalTerminalSchema,
} from "@cantrip/protocol/computer-use-preview";
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
type LiveMutationRuntime = ReturnType<typeof createLiveMutationRuntime>;
import type { ServerRepository } from "../../db/repository.js";

/** Called by the command bus's serialized onEvent queue. Preserve the complete
 * protected computer-use request: reconstituting a Codex request loses its
 * owner, child turn and encryption provenance. No screenshot content is read. */
export async function applyComputerUseAgentEvent(input: {
  event: WorkerEvent;
  ownerId: string;
  chatId: string;
  workerId: string;
  projectId: string | null;
  executionLaneId: string;
  record: LiveMutationRuntime["recordLiveEncryptedAgentInteractionRequest"];
  terminalize: LiveMutationRuntime["terminalizeLiveAgentInteractionRequest"];
  lookup: ServerRepository["getAgentInteractionRequestByKey"];
}): Promise<boolean> {
  const { event } = input;
  if (event.type === "computer-use.approval.request") {
    const { request } = cuaApprovalRequestEventSchema.parse(event);
    const provenance = request.provenance;
    if (
      provenance.owner !== "computer-use" ||
      provenance.chatId !== input.chatId ||
      provenance.workerId !== input.workerId ||
      provenance.executionLaneId !== input.executionLaneId ||
      request.projectId !== input.projectId ||
      !provenance.threadId ||
      !provenance.turnId
    )
      throw new Error("Invalid agent computer-use approval request.");
    await input.record(request);
    return true;
  }
  if (event.type === "computer-use.approval.terminal") {
    const terminal = cuaApprovalTerminalSchema.parse(event);
    if (terminal.chatId !== input.chatId)
      throw new Error("Invalid agent computer-use approval terminal event.");
    const existing = await input.lookup(input.ownerId, terminal.requestKey);
    if (
      !existing ||
      existing.provenance.owner !== "computer-use" ||
      existing.provenance.chatId !== input.chatId ||
      existing.provenance.workerId !== input.workerId ||
      existing.provenance.executionLaneId !== input.executionLaneId ||
      !existing.provenance.threadId ||
      !existing.provenance.turnId
    )
      throw new Error("Invalid agent computer-use approval terminal event.");
    await input.terminalize(
      terminal.requestKey,
      input.chatId,
      input.workerId,
      terminal.status,
    );
    return true;
  }
  return false;
}
