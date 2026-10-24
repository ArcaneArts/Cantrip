import type { WorkspaceOwnership } from "@cantrip/protocol";
import type { WorkspaceTransport } from "./workspace-command-client";
import type { WorkspaceRendererLifetime } from "./workspace-renderer-lifetime";

export class WorkspaceWindowRetiredError extends Error {
  constructor(readonly windowId: string) {
    super("The window no longer belongs to this workspace.");
    this.name = "WorkspaceWindowRetiredError";
  }
}

/** Called only after acquiring the exclusive context lifetime. An uncertain
 * response is surfaced, never rebased. A subsequent read can prove attachment
 * by the persisted renderer identity without incrementing the generation twice. */
export async function attachWorkspaceRenderer(
  initial: WorkspaceOwnership,
  windowId: string,
  lifetime: WorkspaceRendererLifetime,
  transport: WorkspaceTransport,
  assertSession: () => void,
) {
  let layout = initial;
  let acknowledged = false;
  for (let attempt = 0; ; attempt++) {
    lifetime.signal.throwIfAborted();
    assertSession();
    if (
      layout.id !== initial.id ||
      layout.projectId !== initial.projectId ||
      layout.mainWindowId !== initial.mainWindowId
    )
      throw new Error("Workspace attachment response scope changed.");
    const owner = layout.windows.find(({ id }) => id === windowId);
    if (!owner) throw new WorkspaceWindowRetiredError(windowId);
    if (owner.rendererId === lifetime.rendererId) return layout;
    if (acknowledged)
      throw new Error(
        "Workspace attachment was superseded before it became usable.",
      );
    const command = {
      operationId: crypto.randomUUID(),
      projectId: layout.projectId,
      workspaceId: layout.id,
      windowId,
      attachmentGeneration: owner.attachmentGeneration,
      expectedRevision: layout.revision,
      action: {
        type: "replace-attachment" as const,
        rendererId: lifetime.rendererId,
      },
    };
    try {
      const receipt = await transport.execute(command);
      lifetime.signal.throwIfAborted();
      assertSession();
      if (
        receipt.operationId !== command.operationId ||
        receipt.appliedRevision !== command.expectedRevision + 1
      )
        throw new Error(
          "Workspace attachment receipt does not acknowledge the command.",
        );
      layout = receipt.layout;
      acknowledged = true;
    } catch (error) {
      lifetime.signal.throwIfAborted();
      assertSession();
      if (transport.classify(error) !== "conflict" || attempt >= 2) throw error;
      layout = await transport.read();
    }
  }
}
