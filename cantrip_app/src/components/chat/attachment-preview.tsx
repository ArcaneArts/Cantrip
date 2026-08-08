import {
  FileAudio,
  FileImage,
  FileText,
  Loader2,
  Paperclip,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { formatAttachmentBytes } from "@/components/chat/attachment-utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface AttachmentPresentation {
  fileName: string;
  id: string;
  kind: "audio" | "file" | "image" | "text";
  mimeType: string;
  previewText: string | null;
  sizeBytes: number;
  source: "file" | "paste";
}

function AttachmentIcon({ kind }: Pick<AttachmentPresentation, "kind">) {
  const Icon =
    kind === "image"
      ? FileImage
      : kind === "audio"
        ? FileAudio
        : kind === "text"
          ? FileText
          : Paperclip;
  return <Icon className="size-4" />;
}

export function AttachmentPreview({
  attachment,
  contentUrl,
  error,
  onOpen,
  onRemove,
  uploading = false,
}: {
  attachment: AttachmentPresentation;
  contentUrl: string;
  error?: string | null;
  onOpen?(): void;
  onRemove?(): void;
  uploading?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/attachment relative min-w-0 overflow-hidden rounded-xl border bg-muted/30",
        attachment.kind === "image" ? "w-40" : "w-56",
        error && "border-destructive/40",
      )}
    >
      <button
        type="button"
        className="block w-full text-left"
        disabled={uploading}
        onClick={onOpen}
      >
        {attachment.kind === "image" && !uploading ? (
          <img
            alt={attachment.fileName}
            className="h-24 w-full object-cover"
            loading="lazy"
            src={contentUrl}
          />
        ) : attachment.kind === "text" && attachment.previewText ? (
          <pre className="h-20 overflow-hidden px-3 pt-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
            {attachment.previewText}
          </pre>
        ) : (
          <div className="grid h-16 place-items-center text-muted-foreground">
            {uploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <AttachmentIcon kind={attachment.kind} />
            )}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {attachment.fileName}
            </span>
            <span
              className={cn(
                "block truncate text-[10px] text-muted-foreground",
                error && "text-destructive",
              )}
            >
              {error ??
                (uploading
                  ? "Uploading…"
                  : `${attachment.source === "paste" ? "Pasted text · " : ""}${formatAttachmentBytes(attachment.sizeBytes)}`)}
            </span>
          </span>
        </div>
      </button>
      {onRemove ? (
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="absolute right-1.5 top-1.5 size-6 rounded-full opacity-0 shadow-sm transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100"
          title={`Remove ${attachment.fileName}`}
          onClick={onRemove}
        >
          <X className="size-3" />
          <span className="sr-only">Remove attachment</span>
        </Button>
      ) : null}
    </div>
  );
}

export function AttachmentViewerDialog({
  attachment,
  contentUrl,
  onOpenChange,
  open,
}: {
  attachment: AttachmentPresentation | null;
  contentUrl: string | null;
  onOpenChange(open: boolean): void;
  open: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!open || !attachment || attachment.kind !== "text" || !contentUrl) {
      return;
    }
    const controller = new AbortController();
    void fetch(contentUrl, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(setText)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [attachment, contentUrl, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            {attachment?.fileName ?? "Attachment"}
          </DialogTitle>
          {attachment ? (
            <DialogDescription>
              {attachment.mimeType} ·{" "}
              {formatAttachmentBytes(attachment.sizeBytes)}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {attachment && contentUrl ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-muted/25 p-3">
            {attachment.kind === "image" ? (
              <img
                alt={attachment.fileName}
                className="mx-auto max-h-[65vh] max-w-full rounded-lg object-contain"
                src={contentUrl}
              />
            ) : attachment.kind === "audio" ? (
              <audio className="w-full" controls src={contentUrl} />
            ) : attachment.kind === "text" ? (
              error ? (
                <p className="text-sm text-destructive">
                  Could not load attachment: {error}
                </p>
              ) : text === null ? (
                <div className="grid min-h-40 place-items-center text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : (
                <pre className="overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap break-words">
                  {text}
                </pre>
              )
            ) : (
              <div className="grid min-h-40 place-items-center gap-3 text-center">
                <AttachmentIcon kind={attachment.kind} />
                <a
                  className="text-sm underline underline-offset-4"
                  download={attachment.fileName}
                  href={contentUrl}
                >
                  Download {attachment.fileName}
                </a>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
