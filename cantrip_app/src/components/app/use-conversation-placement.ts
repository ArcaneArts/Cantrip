import { useEffect, useRef, useState } from "react";
import { workspacePaneViews } from "@cantrip/protocol";
import { checkpointChatView } from "@/components/chat/chat-transfer-lifecycle";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { createConversationHandoff } from "@/lib/workspace-conversation-handoff";
import type { ConversationPlacement } from "@/lib/workspace-dnd-model";
import { detachWorkspaceEditors } from "./detach-workspace-editors";
import { revealDockPresentation } from "./project-dock-presentation";

type Source = Omit<
  Parameters<typeof detachWorkspaceEditors>[0],
  "paneId" | "title" | "tabId" | "returnToMain"
>;
export function useConversationPlacement(
  source: Source | null,
  onPlaced: () => void,
) {
  const busy = useRef(new Map<Source["controller"], Set<string>>());
  const [, renderPending] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef({ source, onPlaced });
  current.current = { source, onPlaced };
  const bridge = useRef<ReturnType<typeof createConversationHandoff> | null>(
    null,
  );
  useEffect(() => {
    if (!source) return;
    const { controller, windowId } = source;
    const identity = getClientSessionIdentitySnapshot();
    if (!identity) return;
    const connection = createConversationHandoff({
      serverId: identity.serverId,
      ownerId: identity.userId,
      workspaceId: controller.getSnapshot().authoritative.id,
      windowId,
      receive: async (request) => {
        const latest = current.current.source;
        if (
          !latest ||
          latest.controller !== controller ||
          !clientSessionIdentityMatches(identity)
        )
          throw new Error("Conversation handoff context changed.");
        await controller.refresh();
        if (
          current.current.source?.controller !== controller ||
          !clientSessionIdentityMatches(identity)
        )
          throw new Error("Conversation handoff context changed.");
        const owner = controller
          .getSnapshot()
          .authoritative.windows.find((owner) => owner.id === windowId);
        const pane = owner?.panes.find((pane) =>
          workspacePaneViews(pane).some(
            (view) =>
              view.id === request.viewId &&
              view.resource.kind === "entity" &&
              view.resource.definitionId === "project.agent" &&
              view.resource.resourceId === request.chatId,
          ),
        );
        if (!pane || owner?.attachmentGeneration !== request.sourceGeneration)
          throw new Error("Conversation ownership changed before handoff.");
        await detachWorkspaceEditors({
          ...latest,
          paneId: pane.id,
          tabId: request.viewId,
          returnToMain: true,
          title: "Returning conversation",
        });
      },
    });
    bridge.current = connection;
    const unsubscribe = onClientSessionIdentityChanged(() => {
      if (!clientSessionIdentityMatches(identity)) connection.dispose();
    });
    return () => {
      unsubscribe();
      connection.dispose();
      if (bridge.current === connection) bridge.current = null;
    };
  }, [source?.controller, source?.windowId]);
  const place = async (
    projectId: string,
    chatId: string,
    destination: ConversationPlacement,
    captured: ClientSessionIdentitySnapshot | null = getClientSessionIdentitySnapshot(),
  ) => {
    const active = current.current.source;
    const assertCurrent = () => {
      if (
        !mounted.current ||
        !active ||
        current.current.source?.controller !== active.controller ||
        !captured ||
        !clientSessionIdentityMatches(captured) ||
        active.controller.getSnapshot().authoritative.projectId !== projectId
      )
        throw new Error("Conversation placement context changed.");
    };
    assertCurrent();
    const { controller } = active!;
    await controller.placeConversation(chatId, destination, {
      assertCurrent,
      checkpoint: async (owner) => {
        assertCurrent();
        const release = await checkpointChatView(owner);
        try {
          assertCurrent();
          return release;
        } catch (error) {
          release();
          throw error;
        }
      },
      transfer: async (owner) => {
        assertCurrent();
        const connection = bridge.current;
        if (!connection)
          throw new Error("Conversation handoff connection is unavailable.");
        const sourceWindow = controller
          .getSnapshot()
          .authoritative.windows.find((window) => window.id === owner.windowId);
        if (!sourceWindow) throw new Error("Conversation owner changed.");
        const wait = new AbortController();
        let unsubscribe = () => {};
        // Committing a sole-view return closes its source renderer, so a
        // BroadcastChannel reply may never arrive. Only durable ownership
        // (after protected draft restoration) can complete that return.
        const committed = new Promise<void>((resolve, reject) => {
          const inspect = () => {
            try {
              assertCurrent();
              const layout = controller.getSnapshot().authoritative;
              if (
                layout.windows
                  .find((window) => window.id === active!.windowId)
                  ?.panes.some((pane) =>
                    workspacePaneViews(pane).some(
                      (view) =>
                        view.id === owner.viewId &&
                        view.resource.kind === "entity" &&
                        view.resource.definitionId === "project.agent" &&
                        view.resource.resourceId === chatId,
                    ),
                  )
              )
                resolve();
            } catch (error) {
              reject(error);
            }
          };
          unsubscribe = controller.subscribe(inspect);
          inspect();
        });
        try {
          await Promise.race([
            committed,
            connection.request(
              {
                sourceWindowId: owner.windowId,
                sourceGeneration: sourceWindow.attachmentGeneration,
                viewId: owner.viewId,
                chatId,
              },
              wait.signal,
            ),
          ]);
          assertCurrent();
        } finally {
          unsubscribe();
          wait.abort();
        }
      },
    });
    assertCurrent();
    const pane = controller
      .getSnapshot()
      .projected.windows.find((window) => window.id === active!.windowId)
      ?.panes.find((pane) =>
        pane.tabs.some(
          (view) =>
            view.resource.kind === "entity" &&
            view.resource.definitionId === "project.agent" &&
            view.resource.resourceId === chatId,
        ),
      );
    const view = pane?.tabs.find(
      (view) =>
        view.resource.kind === "entity" &&
        view.resource.resourceId === chatId &&
        view.resource.definitionId === "project.agent",
    );
    if (
      pane &&
      view?.dockPresentation?.preferredMode === "closed" &&
      (pane.region === "right" || pane.region === "bottom")
    )
      await controller.dispatch({
        type: "dock-presentation",
        tabId: view.id,
        presentation: revealDockPresentation(view.dockPresentation),
      });
    assertCurrent();
    current.current.onPlaced();
  };
  return Object.assign(
    async (...args: Parameters<typeof place>) => {
      const controller = current.current.source?.controller;
      if (!mounted.current || !controller) return place(...args);
      const chatId = args[1];
      const pending = busy.current.get(controller) ?? new Set<string>();
      if (pending.has(chatId))
        throw new Error(
          "This conversation is already being placed. Wait for it to finish.",
        );
      busy.current.set(controller, pending);
      pending.add(chatId);
      renderPending((value) => value + 1);
      try {
        await place(...args);
      } finally {
        pending.delete(chatId);
        if (!pending.size) busy.current.delete(controller);
        if (mounted.current) renderPending((value) => value + 1);
      }
    },
    {
      pending: new Set(
        source ? busy.current.get(source.controller) : undefined,
      ),
    },
  );
}
