import {
  explorerMediaTypeForPath,
  type CodeAttachment,
  type ExplorerFile,
  type ExplorerFileMode,
  type ExplorerMediaKind,
} from "@cantrip/protocol";
import { Code2, Eye, Loader2, Save, SlidersHorizontal } from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import {
  structuredFileFormatForPath,
  type VisualFileFormat,
} from "@/components/explorer/explorer-file-language";
import { Button } from "@/components/ui/button";
import { clientLogger } from "@/lib/client-log-relay";
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
  context,
  error,
  preparedAtMs,
}: {
  attachment: CodeAttachment | null;
  context: DesktopExplorerWindowContext;
  error: string | null;
  preparedAtMs: number | null;
}) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [attachment?.url]);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
      {attachment ? (
        <iframe
          allow="clipboard-read; clipboard-write"
          className="size-full border-0 bg-background"
          onLoad={() => {
            setLoaded(true);
            clientLogger.info("Explorer editor window rendered", {
              durationMs: Date.now() - context.requestedAtMs,
              event: "surface.explorer.editor-window.rendered",
              operation: "render-editor",
              preparedAtMs,
              status: "ready",
              subsystem: "explorer",
            });
          }}
          src={attachment.url}
          title={`Cantrip Code — ${context.path}`}
        />
      ) : null}
      {!loaded ? (
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

export function DesktopExplorerFileWindow({ launchId }: { launchId: string }) {
  const [context, setContext] = useState<DesktopExplorerWindowContext | null>(
    null,
  );
  const [mode, setMode] = useState<ExplorerFileMode>("edit");
  const [attachment, setAttachment] = useState<CodeAttachment | null>(null);
  const [preparedAtMs, setPreparedAtMs] = useState<number | null>(null);
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
          setContext(next);
          clientLogger.info("Explorer editor window handoff received", {
            durationMs: Date.now() - next.requestedAtMs,
            event: "surface.explorer.editor-window.handoff",
            operation: "receive-handoff",
            status: "ready",
            subsystem: "explorer",
          });
        },
        onEditor: (next, prepared) => {
          setAttachment(next);
          setPreparedAtMs(prepared);
          setEditorError(null);
        },
        onEditorError: setEditorError,
        onLaunchError: setLaunchError,
      }),
    [launchId],
  );

  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, [client]);

  const mediaType = context ? explorerMediaTypeForPath(context.path) : null;
  const structuredFormat: VisualFileFormat | null = context
    ? structuredFileFormatForPath(context.path)
    : null;
  const availableModes = context
    ? desktopExplorerWindowModes(context.path)
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
    if (!context) return;
    const title = [fileName(context.path), context.projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(title);
  }, [context]);

  if (!context) {
    return (
      <main className="grid h-svh place-items-center bg-background p-6 text-foreground">
        {launchError ? (
          <p className="max-w-lg text-center text-sm text-destructive">
            {launchError}
          </p>
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        )}
      </main>
    );
  }

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
      <header
        className="relative flex h-9 shrink-0 items-center border-b border-border/70 bg-background pr-2"
        style={{
          paddingLeft: overlayTitlebar
            ? desktopPopoutTitlebarLeftInset(true, true)
            : "0.5rem",
        }}
      >
        <div className="absolute inset-0" data-tauri-drag-region="" />
        <span className="relative min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground">
          {context.path}
        </span>
        <div className="relative flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5">
          <ModeButton
            active={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            <Eye className="size-3.5" />
            Read only
          </ModeButton>
          {availableModes.includes("visual") ? (
            <ModeButton
              active={mode === "visual"}
              onClick={() => setMode("visual")}
            >
              <SlidersHorizontal className="size-3.5" />
              Visual
            </ModeButton>
          ) : null}
          <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>
            <Code2 className="size-3.5" />
            Editor
          </ModeButton>
        </div>
        {mode === "visual" && dirty ? (
          <Button
            className="relative ml-1 h-7 px-2.5 text-xs"
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
      </header>

      <div
        className={cn("min-h-0 flex-1", mode === "edit" ? "flex" : "hidden")}
      >
        <EditorPane
          attachment={attachment}
          context={context}
          error={editorError}
          preparedAtMs={preparedAtMs}
        />
      </div>
      {mode !== "edit" ? (
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
              path={context.path}
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
                path={context.path}
              />
            </Suspense>
          ) : file ? (
            <div className="h-full overflow-auto">
              {file.markdown ? (
                <article className="mx-auto max-w-4xl p-6 sm:p-10">
                  <Markdown>{draft}</Markdown>
                </article>
              ) : (
                <SourceView code={draft} path={context.path} />
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
