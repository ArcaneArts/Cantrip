import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { interruptChat, setChatPaused } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";

/** Both presentations use the same admitted server controls. Independent
 * mutations keep Stop usable while a pause waits for its native boundary. */
export function useChatExecutionControls({
  chatId,
  projectId,
  projectChatQueryKey,
}: {
  chatId: string;
  projectId: string | null;
  projectChatQueryKey: QueryKey;
}) {
  const queryClient = useQueryClient();
  const setAutomationPaused = useMutation({
    mutationFn: (paused: boolean) => setChatPaused(chatId, paused),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["goal", chatId] }),
        queryClient.invalidateQueries({ queryKey: ["messages", chatId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chatId] }),
      ]);
    },
  });
  const interrupt = useMutation({
    mutationFn: async () => {
      const startedAt = performance.now();
      clientLogger.info("Chat interruption requested", {
        chatId: chatId,
        event: "chat.turn.interrupt.started",
        operation: "interrupt-turn",
        projectId: projectId,
        subsystem: "chat",
      });
      try {
        const result = await interruptChat(chatId);
        clientLogger.info("Chat interruption completed", {
          chatId: chatId,
          durationMs: Math.round(performance.now() - startedAt),
          event: "chat.turn.interrupt.completed",
          operation: "interrupt-turn",
          projectId: projectId,
          status: "completed",
          subsystem: "chat",
        });
        return result;
      } catch (error) {
        clientLogger.warn("Chat interruption failed", {
          chatId: chatId,
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "chat.turn.interrupt.failed",
          operation: "interrupt-turn",
          projectId: projectId,
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "chat",
        });
        throw error;
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectChatQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["messages", chatId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-queue", chatId] }),
      ]);
    },
  });
  return { setAutomationPaused, interrupt };
}
