import {
  getExplorerFile,
  loadExplorerMedia,
  saveExplorerFile,
} from "@/lib/api";
import {
  getClientSession,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import {
  desktopExplorerWindowChannelName,
  isDesktopExplorerWindowRequest,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowResponse,
} from "./desktop-explorer-window-protocol";
import type {
  DesktopExplorerWindowBroker,
  DesktopExplorerWindowBrokerOptions,
} from "./desktop-explorer-window-broker";
import { errorMessage } from "./error-message";

/** Main-window authorization and encrypted file APIs, without a Code runtime. */
export function createNativeExplorerWindowBroker(
  input: Omit<DesktopExplorerWindowContext, "requestedAtMs">,
  options: DesktopExplorerWindowBrokerOptions,
): DesktopExplorerWindowBroker {
  const session = getClientSession();
  const launchId = crypto.randomUUID();
  let context: DesktopExplorerWindowContext = {
    ...input,
    serverId: session?.serverId,
    ownerId: session?.user.id,
    requestedAtMs: Date.now(),
  };
  const channel = new BroadcastChannel(
    desktopExplorerWindowChannelName(launchId),
  );
  let disposed = false;
  let removeIdentityListener: (() => void) | undefined;
  const send = (message: DesktopExplorerWindowResponse) => {
    if (!disposed) channel.postMessage(message);
  };
  const receive = (event: MessageEvent<unknown>) => {
    const request = event.data;
    if (
      disposed ||
      !isDesktopExplorerWindowRequest(request) ||
      request.launchId !== launchId
    )
      return;
    if (request.type === "launch.request") {
      send({ context, launchId, type: "launch.ready" });
      return;
    }
    if (
      request.type !== "file.read" &&
      request.type !== "file.save" &&
      request.type !== "media.read"
    )
      return;
    const target = context;
    void (async () => {
      try {
        const current = getClientSession();
        if (
          current?.serverId !== target.serverId ||
          current?.user.id !== target.ownerId
        )
          throw new Error(
            "The editor's account changed. Reopen this file from Cantrip.",
          );
        if (
          request.path !== target.path ||
          request.requestedAtMs !== target.requestedAtMs
        )
          throw new Error(
            "This file request belongs to a previous editor view.",
          );
        if (request.type === "media.read") {
          send({
            blob: await loadExplorerMedia(target.explorer.id, target.path),
            launchId,
            requestId: request.requestId,
            type: "media.result",
          });
        } else {
          const binding = {
            workerId: target.explorer.activeWorkerId,
            projectId: target.explorer.projectId,
            worktreeId: target.explorer.worktreeId,
          };
          const file =
            request.type === "file.read"
              ? await getExplorerFile(target.explorer.id, target.path, binding)
              : await saveExplorerFile(
                  target.explorer.id,
                  {
                    path: target.path,
                    content: request.content,
                    version: request.version,
                  },
                  binding,
                );
          send({
            file,
            launchId,
            requestId: request.requestId,
            type: "file.result",
          });
        }
      } catch (error) {
        send({
          error: errorMessage(error),
          launchId,
          requestId: request.requestId,
          type: "request.failed",
        });
      }
    })();
  };
  const dispose = async () => {
    if (disposed) return;
    const current = getClientSession();
    if (
      current?.serverId !== context.serverId ||
      current?.user.id !== context.ownerId
    )
      channel.postMessage({
        type: "context.revoked",
        launchId,
        error: "The editor's account changed. Reopen this file from Cantrip.",
      } satisfies DesktopExplorerWindowResponse);
    disposed = true;
    removeIdentityListener?.();
    channel.removeEventListener("message", receive);
    channel.close();
    options.signal?.removeEventListener("abort", abort);
  };
  const abort = () => {
    void dispose();
  };
  channel.addEventListener("message", receive);
  removeIdentityListener = onClientSessionIdentityChanged(() => {
    const current = getClientSession();
    if (
      current?.serverId !== context.serverId ||
      current?.user.id !== context.ownerId
    )
      void dispose().catch(() => undefined);
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    launchId,
    get failed() {
      return disposed;
    },
    ready: Promise.resolve(),
    dispose,
    async openFile(path, requestedAtMs = Date.now()) {
      if (disposed) throw new Error("The editor window is closed.");
      context = { ...context, path, requestedAtMs };
      send({ context, launchId, type: "launch.ready" });
    },
  };
}
