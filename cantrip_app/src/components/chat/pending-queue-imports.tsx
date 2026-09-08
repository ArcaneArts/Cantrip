import type { QueuedPrompt } from "@cantrip/protocol";

const transferStatus = {
  pending: {
    label: "Transferring from CLI",
    description:
      "This prompt will become available when its transfer finishes.",
  },
  conflict: {
    label: "CLI prompt changed",
    description:
      "This saved copy differs from the CLI queue. It will not run until the transfer is reconciled.",
  },
  uncertain: {
    label: "Transfer unconfirmed",
    description:
      "This prompt is saved, but its transfer could not be confirmed. It will not run while confirmation is pending.",
  },
};

/** Retained transfer records are visible, but never offered as executable items. */
export function PendingQueueImports({
  imports,
}: {
  imports: Array<{
    importId: string;
    status: keyof typeof transferStatus;
    prompt: QueuedPrompt;
  }>;
}) {
  if (imports.length === 0) return null;
  return (
    <section
      aria-label="Pending queue transfers"
      className="chat-composer-surface mb-2 max-h-44 overflow-y-auto rounded-xl border p-2 text-sm shadow-xl"
    >
      {imports.map(({ importId, status, prompt }) => (
        <details key={importId} className="rounded-lg px-1 py-1.5">
          <summary className="cursor-pointer break-words">
            <span className="text-muted-foreground">
              {transferStatus[status].label}
            </span>
            <span className="ml-2">
              {prompt.text.slice(0, 120) || "Attachment prompt"}
              {prompt.text.length > 120 ? "…" : ""}
            </span>
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            {transferStatus[status].description}
          </p>
          {prompt.text ? (
            <p className="mt-2 whitespace-pre-wrap break-words">
              {prompt.text}
            </p>
          ) : null}
          {prompt.attachments.length > 0 ? (
            <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
              {prompt.attachments.map((attachment) => (
                <li key={attachment.id} className="break-words">
                  {attachment.fileName}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ))}
    </section>
  );
}
