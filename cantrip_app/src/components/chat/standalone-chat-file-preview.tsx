import type { ExplorerEntry, StandaloneChatSummary } from "@cantrip/protocol";
import type { StandaloneChatFileBinding } from "@cantrip/protocol/surface-stream";
import { useMutation, useQuery } from "@tanstack/react-query";
import { File, Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/chat/markdown";
import { NativeCodeEditor } from "@/components/editor/native-code-editor";
import { isLogFile } from "@/components/editor/log-file";
import { isLicenseFile } from "@/components/editor/license-file";
import { LicenseFileView } from "@/components/editor/license-file-view";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import {
  chatEditorSessions,
  chatFileDocumentId,
  retainedChatFileBinding,
} from "./standalone-chat-editor-sessions";
import {
  defaultExplorerFileMode,
  structuredFileFormatForPath,
} from "@/components/explorer/explorer-file-language";
import { StructuredFileVisual } from "@/components/explorer/structured-file-visual";
import { formatExplorerSize } from "@/components/explorer/explorer-entry-metadata";
import { Button } from "@/components/ui/button";
import { getClientSession } from "@/lib/client-session";
import {
  getStandaloneChats,
  getStandaloneChatFile,
  loadStandaloneChatFileMedia,
  saveStandaloneChatFile,
} from "@/lib/api";
type PreviewMode = "edit" | "preview" | "visual";

function ChatFileMediaPreview({
  chatId,
  entry,
}: {
  chatId: string;
  entry: ExplorerEntry;
}) {
  const media = useQuery({
    queryFn: () => loadStandaloneChatFileMedia(chatId, entry.path),
    queryKey: [
      "standalone-chat-file-media",
      chatId,
      entry.path,
      entry.modifiedAt,
    ],
  });
  const source = useMemo(
    () => (media.data ? URL.createObjectURL(media.data) : null),
    [media.data],
  );
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source],
  );
  if (media.isLoading) {
    return (
      <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
    );
  }
  if (media.isError || !media.data || !source) {
    return (
      <p className="m-auto p-4 text-xs text-destructive">
        Media preview unavailable.
      </p>
    );
  }
  const type = media.data.type;
  if (type.startsWith("image/")) {
    return (
      <img
        alt={entry.name}
        className="m-auto max-h-full max-w-full object-contain p-3"
        src={source}
      />
    );
  }
  if (type.startsWith("audio/")) {
    return (
      <audio
        aria-label={entry.name}
        className="m-auto w-[90%]"
        controls
        src={source}
      />
    );
  }
  return (
    <video
      aria-label={entry.name}
      className="m-auto max-h-full max-w-full p-3"
      controls
      playsInline
      src={source}
    />
  );
}

export function ChatFilePreview({
  chatId,
  chat: knownChat,
  entry,
  onSaved,
  onDirtyChange,
}: {
  chatId: string;
  chat?: StandaloneChatSummary;
  entry: ExplorerEntry | null;
  onSaved(): void;
  onDirtyChange?(dirty: boolean, document: EditorDocumentSession | null): void;
}) {
  const identity = getClientSession();
  const chats = useQuery({
    enabled: !knownChat,
    queryKey: [
      "standalone-chat-editor-binding",
      identity?.serverId,
      identity?.user.id,
      chatId,
    ],
    queryFn: getStandaloneChats,
    refetchInterval: 5_000,
  });
  const chat = knownChat ?? chats.data?.find((value) => value.id === chatId);
  // Pin the binding that supplied this document. A relocation must never redirect
  // an old draft; the server validates this exact binding on reads and saves.
  const [binding, setBinding] = useState<StandaloneChatFileBinding | null>(() =>
    retainedChatFileBinding(chatId, entry?.path),
  );
  useEffect(() => {
    if (!binding && chat?.activeWorkerId && chat.activeScratchRootId)
      setBinding({
        workerId: chat.activeWorkerId,
        scratchRootId: chat.activeScratchRootId,
      });
  }, [binding, chat?.activeWorkerId, chat?.activeScratchRootId]);
  const query = useQuery({
    enabled: Boolean(
      binding &&
      entry?.viewable &&
      !entry.symbolicLink &&
      !entry.path.match(
        /\.(?:aac|apng|avif|bmp|flac|gif|ico|jpe?g|m4[av]|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|weba|webm|webp)$/iu,
      ),
    ),
    queryFn: () => getStandaloneChatFile(chatId, entry!.path, binding!),
    queryKey: [
      "standalone-chat-file",
      identity?.serverId,
      identity?.user.id,
      chatId,
      binding?.workerId,
      binding?.scratchRootId,
      entry?.path,
      entry?.modifiedAt,
    ],
  });
  const [content, setContent] = useState("");
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<PreviewMode>(() =>
    defaultExplorerFileMode(entry?.path ?? ""),
  );
  const [document, setDocument] = useState<EditorDocumentSession | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;
  const accountScope = JSON.stringify([identity?.serverId, identity?.user.id]);
  useEffect(() => {
    chatEditorSessions.resetScope(accountScope);
    setDocument(null);
    setContent("");
    setVersion("");
    setBinding(
      retainedChatFileBinding(chatId, entry?.path) ??
        (chat?.activeWorkerId && chat.activeScratchRootId
          ? {
              workerId: chat.activeWorkerId,
              scratchRootId: chat.activeScratchRootId,
            }
          : null),
    );
  }, [accountScope]);
  const documentId = chatFileDocumentId(chatId, entry?.path, binding);
  useEffect(() => {
    const cached = chatEditorSessions.get(documentId) ?? null;
    setDocument(cached);
    setContent(cached?.text ?? "");
    setVersion(cached?.version ?? "");
    setMode(defaultExplorerFileMode(entry?.path ?? ""));
  }, [documentId]);
  useEffect(() => {
    if (!query.data || query.data.path !== entry?.path) return;
    const next = chatEditorSessions.open(
      documentId,
      query.data.content,
      query.data.version,
    );
    const switched = documentRef.current?.id !== documentId;
    setDocument(next);
    setContent(next.text);
    setVersion(next.version);
    if (switched) setMode(defaultExplorerFileMode(entry?.path ?? ""));
  }, [query.data, documentId, entry?.path]);
  const save = useMutation({
    mutationFn: async () => {
      const current = documentRef.current;
      if (!current || current.id !== documentId || !entry || !binding)
        throw new Error("This file is not loaded.");
      await current.save((input) =>
        saveStandaloneChatFile(chatId, { ...input, path: entry.path }, binding),
      );
      return current;
    },
    onSuccess: (saved) => {
      if (documentRef.current === saved) {
        setContent(saved.text);
        setVersion(saved.version);
      }
      onSaved();
    },
  });
  const dirty = document?.id === documentId && document.dirty;
  const hasUnsavedChanges = Boolean(dirty || document?.saving);
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges, document);
  }, [hasUnsavedChanges, onDirtyChange, document]);
  if (!entry) {
    return (
      <div className="grid h-full place-items-center p-5 text-center text-xs text-muted-foreground">
        Select a file to preview or edit it.
      </div>
    );
  }
  const media = entry.path.match(
    /\.(?:aac|apng|avif|bmp|flac|gif|ico|jpe?g|m4[av]|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|weba|webm|webp)$/iu,
  );
  if (media) return <ChatFileMediaPreview chatId={chatId} entry={entry} />;
  if (!entry.viewable) {
    return (
      <div className="grid h-full place-items-center p-5 text-center text-xs text-muted-foreground">
        <div>
          <File className="mx-auto mb-2 size-6" />
          <p className="font-medium text-foreground">Preview unavailable</p>
          <p className="mt-1">
            {formatExplorerSize(entry.size ?? 0)} · {entry.path}
          </p>
        </div>
      </div>
    );
  }
  if (
    ((!binding && chats.isPending && !knownChat) ||
      (binding && query.isLoading)) &&
    !document &&
    !chats.isError
  ) {
    return (
      <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
    );
  }
  if ((query.isError || !query.data) && document?.id !== documentId) {
    return (
      <div className="m-auto max-w-full p-5 text-center text-xs text-muted-foreground">
        <File className="mx-auto mb-2 size-6" />
        <p className="font-medium text-destructive">
          {(query.error ?? chats.error) instanceof Error
            ? (query.error ?? chats.error)!.message
            : !binding
              ? "This Chat has no available scratch workspace."
              : "File preview unavailable."}
        </p>
        <p className="mt-1 break-all">
          {formatExplorerSize(entry.size ?? 0)} · {entry.path}
        </p>
      </div>
    );
  }
  const format = structuredFileFormatForPath(entry.path);
  const changeContent = (text: string) => {
    document?.editExternal(text);
    setContent(text);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium"
          title={entry.path}
        >
          {entry.name}
        </span>
        {entry.markdown ||
        isLicenseFile(entry.path) ||
        isLogFile(entry.path) ? (
          <Button
            size="sm"
            variant={mode === "preview" ? "outline" : "ghost"}
            onClick={() => setMode("preview")}
          >
            Preview
          </Button>
        ) : null}
        {format ? (
          <Button
            size="sm"
            variant={mode === "visual" ? "outline" : "ghost"}
            onClick={() => setMode("visual")}
          >
            Visual
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={mode === "edit" ? "outline" : "ghost"}
          onClick={() => setMode("edit")}
        >
          Edit
        </Button>
        <Button
          aria-label="Save Chat file"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          size="icon"
          title="Save (⌘S / Ctrl+S)"
          variant="ghost"
        >
          {save.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
        </Button>
      </div>
      {save.isError ? (
        <p className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
          {save.error instanceof Error ? save.error.message : "Save failed."}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "preview" && isLicenseFile(entry.path) ? (
          <LicenseFileView path={entry.path} content={content} />
        ) : mode === "preview" && entry.markdown ? (
          <div className="h-full overflow-auto" data-content-gutter="markdown">
            <Markdown>{content}</Markdown>
          </div>
        ) : mode === "visual" && format ? (
          <StructuredFileVisual
            content={content}
            format={format}
            onChange={changeContent}
            onSave={() => save.mutate()}
            path={entry.path}
          />
        ) : document?.id === documentId ? (
          <NativeCodeEditor
            session={document}
            path={entry.path}
            readOnly={mode === "preview"}
            onChange={changeContent}
            onSave={() => save.mutate()}
          />
        ) : null}
      </div>
    </div>
  );
}
