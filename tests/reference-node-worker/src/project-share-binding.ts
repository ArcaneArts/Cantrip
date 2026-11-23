import type { WorkerCommand } from "@cantrip/protocol";
import type { TunnelContentDestinationEndpoint } from "@cantrip/protocol/tunnel-content";

type ProjectShareOpenCommand = Extract<
  WorkerCommand,
  { type: "project.share.open" }
>;
type ProjectShareDestination = Extract<
  TunnelContentDestinationEndpoint,
  { kind: "worker-chat-share" | "worker-project-share" }
>;

export function assertProjectShareDestinationBinding(
  command: ProjectShareOpenCommand,
  destination: TunnelContentDestinationEndpoint,
  workerId: string,
): asserts destination is ProjectShareDestination {
  if (
    (destination.kind !== "worker-project-share" &&
      destination.kind !== "worker-chat-share") ||
    destination.workerId !== workerId ||
    destination.resourceId !== command.shareId
  ) {
    throw new Error(
      "Protected project share content belongs to another endpoint.",
    );
  }
  if (command.standaloneRoot) {
    if (
      destination.kind !== "worker-chat-share" ||
      destination.chatId !== command.standaloneRoot.chatId ||
      destination.rootId !== command.standaloneRoot.rootId
    ) {
      throw new Error(
        "Protected Chat share content belongs to another scratch root.",
      );
    }
    return;
  }
  if (destination.kind !== "worker-project-share") {
    throw new Error(
      "Protected project share content cannot target a standalone Chat root.",
    );
  }
}
