import {
  explorerMediaTypeForPath,
  type ExplorerFile,
  type ExplorerFileMode,
  type ExplorerMediaKind,
} from "@cantrip/protocol";
import { Code2, Eye, Loader2, Save, SlidersHorizontal } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Markdown } from "@/components/chat/markdown";
import { NativeFileWindowCloseGuard } from "@/components/app/native-file-window-close-guard";
import { closeRevokedNativeFileWindow } from "@/lib/native-file-window-close";
import {
  EditorSessionStore,
  editorDocumentId,
  type EditorDocumentSession,
} from "@/components/editor/document-session";
import { NativeCodeEditor } from "@/components/editor/native-code-editor";
import { isLicenseFile } from "@/components/editor/license-file";
import { LicenseFileView } from "@/components/editor/license-file-view";
import {
  structuredFileFormatForPath,
  type VisualFileFormat,
} from "@/components/explorer/explorer-file-language";
import { DesktopExplorerWindowHeader } from "@/components/explorer/desktop-explorer-window-shell";
import { ExplorerImageViewport } from "@/components/explorer/explorer-image-viewport";
import { Button } from "@/components/ui/button";
import { clientLogger } from "@/lib/client-log-relay";
import { DesktopExplorerWindowClient } from "@/lib/desktop-explorer-window-client";
import {
  desktopExplorerWindowInitialMode,
  desktopExplorerWindowModes,
  type DesktopExplorerWindowContext,
} from "@/lib/desktop-explorer-window-protocol";
import {
  desktopPopoutTitlebarLeftInset,
  isMacosDesktopRuntime,
  updateDesktopWindowTitle,
} from "@/lib/desktop-popout";
import { cn } from "@/lib/utils";

const StructuredFileVisual = lazy(async () => {
  const module = await import("@/components/explorer/structured-file-visual");
  return { default: module.StructuredFileVisual };
});

function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

function MediaView({
  blob,
  kind,
  mimeType,
  path,
}: {
  blob: Blob;
  kind: ExplorerMediaKind;
  mimeType: string;
  path: string;
}) {
  const source = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(source), [source]);
  if (kind === "image") {
    return <ExplorerImageViewport alt={fileName(path)} source={source} />;
  }
  if (kind === "audio") {
    return (
      <div className="grid h-full place-items-center p-6">
        <audio
          aria-label={fileName(path)}
          className="w-full max-w-2xl"
          controls
          preload="metadata"
          src={source}
        />
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center overflow-auto p-4">
      <video
        aria-label={fileName(path)}
        className="max-h-full max-w-full"
        controls
        playsInline
        preload="metadata"
      >
        <source src={source} type={mimeType} />
      </video>
    </div>
  );
}

function ModeButton({
  active,
  children,
  disabled,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      aria-pressed={active}
      className="h-7 gap-1.5 px-2.5 text-xs"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant={active ? "outline" : "ghost"}
    >
      {children}
    </Button>
  );
}

export function DesktopExplorerFileWindow({
  initialPath,
  launchId,
}: {
  initialPath: string;
  launchId: string;
}) {
  const [context, setContext] = useState<DesktopExplorerWindowContext | null>(
    null,
  );
  const [mode, setMode] = useState<ExplorerFileMode>(() =>
    desktopExplorerWindowInitialMode(initialPath),
  );
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [authorityError, setAuthorityError] = useState<string | null>(null);
  const [file, setFile] = useState<ExplorerFile | null>(null);
  const [draft, setDraft] = useState("");
  const [media, setMedia] = useState<Blob | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const sessions = useRef<EditorSessionStore | null>(null);
  sessions.current ??= new EditorSessionStore();
  const [nativeDocument, setNativeDocument] =
    useState<EditorDocumentSession | null>(null);
  const nativeDocumentRef = useRef(nativeDocument);
  nativeDocumentRef.current = nativeDocument;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fileRef = useRef(file);
  fileRef.current = file;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const hasUnsavedChanges = () =>
    sessions.current!.hasDirtyDocuments ||
    savingRef.current ||
    (!nativeDocumentRef.current &&
      Boolean(fileRef.current && draftRef.current !== fileRef.current.content));
  const changeDraft = useCallback((text: string) => {
    draftRef.current = text;
    nativeDocumentRef.current?.editExternal(text);
    setDraft(text);
  }, []);
  const overlayTitlebar = useMemo(() => isMacosDesktopRuntime(), []);
  const client = useMemo(
    () =>
      new DesktopExplorerWindowClient(launchId, {
        onContextRevoked: (error) => {
          setAuthorityError(error);
          if (hasUnsavedChanges()) return;
          sessions.current!.discardAll();
          nativeDocumentRef.current = null;
          setNativeDocument(null);
          setContext(null);
          setFile(null);
          setDraft("");
          setMedia(null);
          setLaunchError(error);
          void closeRevokedNativeFileWindow().catch((failure: unknown) => {
            setLaunchError(
              `${error} ${failure instanceof Error ? failure.message : "The window could not close."}`,
            );
          });
        },
        onContext: (next) => {
          setAuthorityError(null);
          setMode(desktopExplorerWindowInitialMode(next.path));
          setContext(next);
          setFile(null);
          setNativeDocument(null);
          setDraft("");
          setMedia(null);
          setContentError(null);
          setContentLoading(false);
          setSaving(false);
          clientLogger.info("Explorer editor window handoff received", {
            durationMs: Date.now() - next.requestedAtMs,
            event: "surface.explorer.editor-window.handoff",
            operation: "receive-handoff",
            status: "ready",
            subsystem: "explorer",
          });
        },
        onLaunchError: setLaunchError,
      }),
    [launchId],
  );

  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, [client]);
  const path = context?.path ?? initialPath;
  const mediaType = context ? explorerMediaTypeForPath(path) : null;
  const structuredFormat: VisualFileFormat | null = context
    ? structuredFileFormatForPath(path)
    : null;
  const availableModes = desktopExplorerWindowModes(path);
  useEffect(() => {
    if (context)
      sessions.current!.resetScope(
        JSON.stringify([context.serverId, context.ownerId]),
      );
  }, [context?.serverId, context?.ownerId]);
  useEffect(() => {
    if (!context) return;
    if ((mediaType && media) || (!mediaType && file)) return;
    let cancelled = false;
    setContentLoading(true);
    setContentError(null);
    const load = mediaType ? client.readMedia() : client.readFile();
    void load
      .then((result) => {
        if (cancelled) return;
        if (result instanceof Blob) {
          setMedia(result);
        } else {
          setFile(result);
          const id = editorDocumentId({
            server: context.serverId ?? "",
            account: context.ownerId ?? "",
            worker: context.explorer.activeWorkerId,
            project: context.explorer.projectId,
            worktree: context.explorer.worktreeId,
            path: context.path,
          });
          const document = sessions.current!.open(
            id,
            result.content,
            result.version,
          );
          setNativeDocument(document);
          setDraft(document.text);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setContentError(
            error instanceof Error
              ? error.message
              : "File could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, context, file, media, mediaType, mode]);

  const dirty = nativeDocument?.dirty ?? false;
  useEffect(() => {
    if (!dirty && !sessions.current!.hasDirtyDocuments) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const title = [fileName(path), context?.projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(title);
  }, [context?.projectTitle, path]);

  const save = async () => {
    if (!file) return false;
    if (!dirty && !nativeDocument?.saving) return true;
    setSaving(true);
    savingRef.current = true;
    setContentError(null);
    try {
      if (nativeDocument) {
        let saved: ExplorerFile | undefined;
        await nativeDocument.save(async (input) => {
          saved = await client.saveFile(input.content, input.version, context);
          return saved;
        });
        if (nativeDocumentRef.current === nativeDocument) {
          if (saved) setFile(saved);
          setDraft(nativeDocument.text);
        }
      } else {
        const submitted = draft;
        const saved = await client.saveFile(submitted, file.version);
        setFile(saved);
        setDraft((current) =>
          current === submitted ? saved.content : current,
        );
      }
      return !nativeDocument?.dirty;
    } catch (error) {
      setContentError(
        error instanceof Error ? error.message : "File could not be saved.",
      );
      return false;
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <NativeFileWindowCloseGuard hasUnsavedChanges={hasUnsavedChanges} />
      <DesktopExplorerWindowHeader
        actions={
          <>
            <div className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5">
              <ModeButton
                active={mode === "preview"}
                disabled={!context}
                onClick={() => setMode("preview")}
              >
                <Eye className="size-3.5" />
                Read only
              </ModeButton>
              {availableModes.includes("visual") ? (
                <ModeButton
                  active={mode === "visual"}
                  disabled={!context}
                  onClick={() => setMode("visual")}
                >
                  <SlidersHorizontal className="size-3.5" />
                  Visual
                </ModeButton>
              ) : null}
              {availableModes.includes("edit") ? (
                <ModeButton
                  active={mode === "edit"}
                  disabled={!context}
                  onClick={() => setMode("edit")}
                >
                  <Code2 className="size-3.5" />
                  Editor
                </ModeButton>
              ) : null}
            </div>
            {dirty ? (
              <Button
                className="ml-1 h-7 px-2.5 text-xs"
                onClick={() => void save()}
                pending={saving}
                size="sm"
                type="button"
                variant="outline"
              >
                <Save className="size-3.5" />
                Save
              </Button>
            ) : null}
          </>
        }
        path={path}
        titlebarLeftInset={desktopPopoutTitlebarLeftInset(
          true,
          overlayTitlebar,
        )}
      />

      {context && authorityError ? (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p>{authorityError}</p>
          <p>
            Your draft is kept here. Copy it before closing; reopen the file in
            its original account to save.
          </p>
        </div>
      ) : null}
      {!context ? (
        <div className="grid min-h-0 flex-1 place-items-center bg-background p-6">
          {launchError ? (
            <p className="max-w-lg text-center text-sm text-destructive">
              {launchError}
            </p>
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : (
        <section className="relative min-h-0 flex-1 overflow-hidden">
          {contentError ? (
            <div className="absolute inset-x-0 top-0 z-10 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
              {contentError}
            </div>
          ) : null}
          {contentLoading ? (
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : mode === "edit" && nativeDocument ? (
            <NativeCodeEditor
              session={nativeDocument}
              path={path}
              onChange={changeDraft}
              onSave={() => void save()}
            />
          ) : mediaType && media ? (
            <MediaView
              blob={media}
              kind={mediaType.kind}
              mimeType={mediaType.mimeType}
              path={path}
            />
          ) : file && mode === "preview" && isLicenseFile(path) ? (
            <LicenseFileView content={draft} path={path} />
          ) : mode === "visual" && file && structuredFormat ? (
            <Suspense
              fallback={
                <div className="grid h-full place-items-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <StructuredFileVisual
                content={draft}
                format={structuredFormat}
                onChange={changeDraft}
                onSave={() => void save()}
                path={path}
              />
            </Suspense>
          ) : file?.markdown ? (
            <div className="h-full overflow-auto">
              <article className="px-4" data-content-gutter="markdown">
                <Markdown>{draft}</Markdown>
              </article>
            </div>
          ) : file && nativeDocument ? (
            <NativeCodeEditor session={nativeDocument} path={path} readOnly />
          ) : null}
        </section>
      )}
    </main>
  );
}
