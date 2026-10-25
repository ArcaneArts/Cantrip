import type { WorkspaceCommandClient } from "./workspace-command-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";

type Port = Pick<
  BroadcastChannel,
  "postMessage" | "addEventListener" | "removeEventListener" | "close"
>;

/** Revision-only hints accelerate local windows. Only an authorized server read
 * can change ownership; missing/broken channels leave ordinary polling intact. */
export function bindWorkspaceRefreshChannel(
  controller: Pick<
    WorkspaceCommandClient,
    "getSnapshot" | "subscribe" | "refresh"
  >,
  identity: ClientSessionIdentitySnapshot,
  createPort: (name: string) => Port = (name) => new BroadcastChannel(name),
) {
  const initial = controller.getSnapshot().authoritative;
  let port: Port;
  try {
    port = createPort(
      `cantrip-workspace-refresh:${JSON.stringify([
        identity.serverId,
        identity.userId,
        initial.projectId,
        initial.id,
      ])}`,
    );
  } catch {
    return () => {};
  }
  let disposed = false;
  let announced = initial.revision;
  let refreshing = false;
  let queued = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      do {
        queued = false;
        if (disposed || controller.getSnapshot().disposed) return;
        try {
          await controller.refresh();
        } catch {
          /* Polling retries reads. */
        }
      } while (queued && !disposed);
    } finally {
      refreshing = false;
    }
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (disposed || controller.getSnapshot().disposed) return;
    const revision = event.data;
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision <= controller.getSnapshot().authoritative.revision
    )
      return;
    queued = true;
    void refresh();
  };
  port.addEventListener("message", receive);
  const unsubscribe = controller.subscribe(() => {
    const state = controller.getSnapshot();
    if (disposed || state.disposed || state.authoritative.revision <= announced)
      return;
    announced = state.authoritative.revision;
    // BroadcastChannel failure must never turn a committed command into an
    // uncertain command or interfere with document retirement.
    try {
      port.postMessage(announced);
    } catch {
      /* Polling remains available. */
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    port.removeEventListener("message", receive);
    port.close();
  };
}
