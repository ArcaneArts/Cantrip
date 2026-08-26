import { ChatTranscriptView } from "@/components/chat/chat-transcript-view";
import { useChatTranscriptController } from "@/components/chat/use-chat-transcript-controller";
import type { ChatTranscriptProps } from "@/components/chat/use-chat-transcript-controller";

export type { ChatTranscriptProps };

export function ChatTranscript(props: ChatTranscriptProps) {
  const controller = useChatTranscriptController(props);
  return <ChatTranscriptView controller={controller} />;
}
