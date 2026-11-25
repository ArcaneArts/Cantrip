import { COUNCIL_MEMORY_BYTE_LIMIT } from "@cantrip/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  getCouncilMemory,
  updateCouncilMemory,
  type CouncilMemory,
} from "@/lib/api/council";
import { errorMessage } from "@/lib/error-message";

export function CouncilMemoryEditor({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose(): void;
}) {
  const memory = useQuery({
    queryKey: ["council", "memory", agentId],
    queryFn: () => getCouncilMemory(agentId),
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fast memory</DialogTitle>
          <DialogDescription>
            The agent uses these preferences and notes in future turns.
          </DialogDescription>
        </DialogHeader>
        {memory.isError ? (
          <InlineAlert>{errorMessage(memory.error)}</InlineAlert>
        ) : null}
        {memory.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Opening memory…
          </p>
        ) : null}
        {memory.data ? (
          <MemoryForm
            agentId={agentId}
            initial={memory.data}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MemoryForm({
  agentId,
  initial,
  onClose,
}: {
  agentId: string;
  initial: CouncilMemory;
  onClose(): void;
}) {
  const [revision] = useState(initial.revision);
  const [text, setText] = useState(initial.text);
  const overLimit =
    new TextEncoder().encode(text).length > COUNCIL_MEMORY_BYTE_LIMIT;
  const save = useMutation({
    mutationFn: () => updateCouncilMemory(agentId, revision, text),
    onSuccess: onClose,
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!overLimit && !save.isPending) save.mutate();
      }}
    >
      <textarea
        aria-label="Fast memory notes"
        className="min-h-32 resize-y rounded-md border bg-background p-2 text-sm"
        onChange={(event) => setText(event.currentTarget.value)}
        value={text}
      />
      {overLimit ? (
        <InlineAlert>Council memory is limited to 8 KiB.</InlineAlert>
      ) : null}
      {save.isError ? (
        <InlineAlert>{errorMessage(save.error)}</InlineAlert>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={overLimit || save.isPending}>
          Save memory
        </Button>
      </div>
    </form>
  );
}
