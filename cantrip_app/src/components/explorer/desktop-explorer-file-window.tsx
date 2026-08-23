import {
  explorerMediaTypeForPath,
  type CodeAttachment,
  type ExplorerFile,
  type ExplorerFileMode,
  type ExplorerMediaKind,
} from "@cantrip/protocol";
import { Code2, Eye, Loader2, Save, SlidersHorizontal } from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
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
import {
  structuredFileFormatForPath,
  type VisualFileFormat,
} from "@/components/explorer/explorer-file-language";
import { DesktopExplorerWindowHeader } from "@/components/explorer/desktop-explorer-window-shell";
import { Button } from "@/components/ui/button";
import { clientLogger } from "@/lib/client-log-relay";
import {
  CODE_WORKBENCH_READY_TIMEOUT_MS,
  codeWorkbenchStageError,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
} from "@/lib/code-workbench-frame";
import { DesktopExplorerWindowClient } from "@/lib/desktop-explorer-window-client";
import {
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

const languageByExtension: Record<string, Language> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  go: "go",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  html: "markup",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sol: "solidity",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "markup",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

function fileLanguage(path: string): Language {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return languageByExtension[extension] ?? "plain";
}

function SourceView({ code, path }: { code: string; path: string }) {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);
  return (
    <Highlight
      code={code}
      language={fileLanguage(path)}
      theme={dark ? themes.vsDark : themes.github}
    >
      {({ className, getLineProps, getTokenProps, style, tokens }) => (
        <pre
          className={cn(
            className,
            "min-h-full min-w-max p-4 font-mono text-xs leading-5",
          )}
          style={{ ...style, margin: 0, background: "transparent" }}
        >
          {tokens.map((line, lineIndex) => (
            <div key={lineIndex} {...getLineProps({ line })}>
              <span className="mr-5 inline-block w-8 select-none text-right text-muted-foreground/50">
                {lineIndex + 1}
              </span>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
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
    return (
      <div className="grid h-full place-items-center overflow-auto p-4">
        <img
          alt={fileName(path)}
          className="max-h-full max-w-full object-contain"
          src={source}
        />
      </div>
    );
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

function EditorPane({
  attachment,
  configuredAtMs,
  context,
  error,
  onWorkbenchFailed,
  onWorkbenchMounted,
  onWorkbenchReady,
  preparedAtMs,
}: {
  attachment: CodeAttachment | null;
  configuredAtMs: number | null;
  context: DesktopExplorerWindowContext;
  error: string | null;
  onWorkbenchFailed(
    nonce: string,
    error: string,
    stage: "frame" | "workbench",
  ): void;
  onWorkbenchMounted(nonce: string): void;
  onWorkbenchReady(nonce: string): void;
  preparedAtMs: number | null;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const mount = useMemo(
    () => (attachment ? createCodeWorkbenchFrameMount(attachment.url) : null),
    [attachment?.attachmentId, attachment?.url],
  );
  const [frameFailureNonce, setFrameFailureNonce] = useState<string | null>(
    null,
  );
  const frameFailureNonceRef = useRef<string | null>(null);
  const [workbenchNonce, setWorkbenchNonce] = useState<string | null>(null);
  useLayoutEffect(() => {
    setWorkbenchNonce(null);
    if (!mount || frameFailureNonce === mount.nonce) return;
    if (frameFailureNonceRef.current !== mount.nonce) {
      frameFailureNonceRef.current = null;
    }
    let settled = false;
    const fail = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      frameFailureNonceRef.current = mount.nonce;
      const failure = codeWorkbenchStageError("workbench", reason);
      setFrameFailureNonce(mount.nonce);
      onWorkbenchFailed(mount.nonce, failure.message, "workbench");
    };
    const receiveReady = (event: MessageEvent<unknown>) => {
      if (
        settled ||
        frameFailureNonceRef.current === mount.nonce ||
        !isCodeWorkbenchReadyEvent(
          event,
          frameRef.current?.contentWindow ?? null,
          mount,
        )
      ) {
        return;
      }
      settled = true;
      setWorkbenchNonce(mount.nonce);
      onWorkbenchReady(mount.nonce);
    };
    window.addEventListener("message", receiveReady);
    onWorkbenchMounted(mount.nonce);
    const timeout = setTimeout(
      () => fail("The embedded editor timed out after its endpoint loaded."),
      CODE_WORKBENCH_READY_TIMEOUT_MS,
    );
    return () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receiveReady);
    };
  }, [
    frameFailureNonce,
    mount,
    onWorkbenchFailed,
    onWorkbenchMounted,
    onWorkbenchReady,
  ]);
  const ready = workbenchNonce === mount?.nonce && configuredAtMs !== null;
  useEffect(() => {
    if (!ready) return;
    clientLogger.info("Explorer editor window rendered", {
      configuredAtMs,
      durationMs: Date.now() - context.requestedAtMs,
      event: "surface.explorer.editor-window.rendered",
      operation: "render-editor",
      preparedAtMs,
      status: "ready",
      subsystem: "explorer",
    });
  }, [configuredAtMs, context.requestedAtMs, preparedAtMs, ready]);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
      {attachment ? (
        <iframe
          key={mount?.nonce}
          allow="clipboard-read; clipboard-write"
          aria-hidden={!ready}
          className={cn(
            "size-full border-0 bg-background",
            !ready && "pointer-events-none",
          )}
          onError={() => {
            if (!mount) return;
            frameFailureNonceRef.current = mount.nonce;
            setFrameFailureNonce(mount.nonce);
            onWorkbenchFailed(
              mount.nonce,
              codeWorkbenchStageError(
                "frame",
                "The embedded editor document could not load.",
              ).message,
              "frame",
            );
          }}
          onLoad={() => {
            clientLogger.debug("Explorer editor workbench frame loaded", {
              durationMs: Date.now() - context.requestedAtMs,
              event: "surface.explorer.editor-window.frame-loaded",
              operation: "load-workbench-frame",
              preparedAtMs,
              status: "completed",
              subsystem: "explorer",
            });
          }}
          ref={frameRef}
          referrerPolicy="no-referrer"
          src={mount?.url}
          tabIndex={ready ? 0 : -1}
          title={`Cantrip Code — ${context.path}`}
        />
      ) : null}
      {ready && error ? (
        <p className="absolute inset-x-4 top-4 z-10 border border-destructive/30 bg-background/95 p-3 text-sm text-destructive shadow-lg">
          {error}
        </p>
      ) : null}
      {!ready ? (
        <div className="absolute inset-0 grid place-items-center bg-background p-6">
          {error ? (
            <p className="max-w-lg border-y border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </p>
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : null}
    </div>
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
  const [mode, setMode] = useState<ExplorerFileMode>("edit");
  const [attachment, setAttachment] = useState<CodeAttachment | null>(null);
  const [preparedAtMs, setPreparedAtMs] = useState<number | null>(null);
  const [configuredAtMs, setConfiguredAtMs] = useState<number | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [file, setFile] = useState<ExplorerFile | null>(null);
  const [draft, setDraft] = useState("");
  const [media, setMedia] = useState<Blob | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const overlayTitlebar = useMemo(() => isMacosDesktopRuntime(), []);
  const client = useMemo(
    () =>
      new DesktopExplorerWindowClient(launchId, {
        onContext: (next) => {
          setMode("edit");
          setContext(next);
          setConfiguredAtMs(null);
          setEditorError(null);
          setFile(null);
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
        onEditorEndpoint: (next, prepared) => {
          setAttachment(next);
          setPreparedAtMs(prepared);
          setConfiguredAtMs(null);
          setEditorError(null);
        },
        onEditorReady: setConfiguredAtMs,
        onEditorError: setEditorError,
        onLaunchError: setLaunchError,
      }),
    [launchId],
  );

  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, [client]);
  const editorWorkbenchReady = useCallback(
    (nonce: string) => client.editorWorkbenchReady(nonce),
    [client],
  );
  const editorWorkbenchMounted = useCallback(
    (nonce: string) => client.editorWorkbenchMounted(nonce),
    [client],
  );
  const editorWorkbenchFailed = useCallback(
    (nonce: string, error: string, stage: "frame" | "workbench") =>
      client.editorWorkbenchFailed(nonce, error, stage),
    [client],
  );

  const path = context?.path ?? initialPath;
  const mediaType = context ? explorerMediaTypeForPath(path) : null;
  const structuredFormat: VisualFileFormat | null = context
    ? structuredFileFormatForPath(path)
    : null;
  const availableModes = context
    ? desktopExplorerWindowModes(path)
    : (["preview", "edit"] satisfies ExplorerFileMode[]);
  useEffect(() => {
    if (!context || mode === "edit") return;
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
          setDraft(result.content);
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

  const dirty = Boolean(file && draft !== file.content);
  useEffect(() => {
    if (!dirty) return;
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
    if (!file || !dirty) return;
    setSaving(true);
    setContentError(null);
    try {
      const saved = await client.saveFile(draft, file.version);
      setFile(saved);
      setDraft(saved.content);
    } catch (error) {
      setContentError(
        error instanceof Error ? error.message : "File could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
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
              <ModeButton
                active={mode === "edit"}
                disabled={!context}
                onClick={() => setMode("edit")}
              >
                <Code2 className="size-3.5" />
                Editor
              </ModeButton>
            </div>
            {mode === "visual" && dirty ? (
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
      ) : mode === "edit" ? (
        <div className="flex min-h-0 flex-1">
          <EditorPane
            attachment={attachment}
            configuredAtMs={configuredAtMs}
            context={context}
            error={editorError}
            onWorkbenchFailed={editorWorkbenchFailed}
            onWorkbenchMounted={editorWorkbenchMounted}
            onWorkbenchReady={editorWorkbenchReady}
            preparedAtMs={preparedAtMs}
          />
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
          ) : mediaType && media ? (
            <MediaView
              blob={media}
              kind={mediaType.kind}
              mimeType={mediaType.mimeType}
              path={path}
            />
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
                onChange={setDraft}
                onSave={() => void save()}
                path={path}
              />
            </Suspense>
          ) : file ? (
            <div className="h-full overflow-auto">
              {file.markdown ? (
                <article className="mx-auto max-w-4xl p-6 sm:p-10">
                  <Markdown>{draft}</Markdown>
                </article>
              ) : (
                <SourceView code={draft} path={path} />
              )}
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}
