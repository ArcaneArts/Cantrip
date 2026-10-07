import { useQuery } from "@tanstack/react-query";

import { getChatFileReferences } from "@/lib/api";

import {
  MessageFileSummary,
  type MessageFileSummaryModel,
} from "./message-file-summary";

export function ChatMessageFileSummary({
  chatId,
  model,
  onOpenFile,
}: {
  chatId: string;
  model: MessageFileSummaryModel;
  onOpenFile(path: string): void;
}) {
  const references = model.entries.map((entry) => entry.reference);
  const metadata = useQuery({
    queryKey: ["chat-file-references", chatId, references],
    queryFn: () => getChatFileReferences(chatId, references),
    retry: false,
    staleTime: 30_000,
  });
  return (
    <MessageFileSummary
      metadata={metadata.data}
      model={model}
      onOpenFile={onOpenFile}
    />
  );
}
