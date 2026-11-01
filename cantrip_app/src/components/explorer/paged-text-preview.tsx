import { useCallback, useEffect, useRef, useState } from "react";
import type { ExplorerTextPreviewPage } from "@cantrip/protocol/surface-stream";
import { NativeCodeEditor } from "@/components/editor/native-code-editor";
import { TextPreviewDocument } from "./text-preview-document";

export function PagedTextPreview({
  path,
  active,
  readPage,
  onReady,
  onError,
}: {
  path: string;
  active: boolean;
  readPage(offset: number, version?: string): Promise<ExplorerTextPreviewPage>;
  onReady?(): void;
  onError?(error: unknown): void;
}) {
  const [document] = useState(() => new TextPreviewDocument(path));
  const [state, setState] = useState({
    loading: false,
    error: "",
  });
  const mounted = useRef(false);
  const loading = useRef(false);
  const failed = useRef(false);
  const visibleEnd = useRef(0);
  const refs = useRef({ active, readPage, onError });
  refs.current = { active, readPage, onError };
  const loadMore = useCallback(async () => {
    if (
      !mounted.current ||
      loading.current ||
      document.eof ||
      !refs.current.active
    )
      return;
    loading.current = true;
    failed.current = false;
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const page = await refs.current.readPage(
        document.offset,
        document.version,
      );
      if (!mounted.current) return;
      document.append(page);
      setState({ loading: false, error: "" });
    } catch (error) {
      if (!mounted.current) return;
      failed.current = true;
      setState((s) => ({
        ...s,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Text preview could not be loaded.",
      }));
      refs.current.onError?.(error);
    } finally {
      loading.current = false;
    }
  }, [document]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const nearEnd = useCallback(
    (last: number, total: number) => {
      visibleEnd.current = total - last;
      if (total - last < 200 && !failed.current) void loadMore();
    },
    [loadMore],
  );
  useEffect(() => {
    if (
      active &&
      !failed.current &&
      (document.offset === 0 || visibleEnd.current < 200)
    )
      void loadMore();
  }, [active, document, loadMore]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-text-preview>
      <div
        className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <span>
          {state.error ||
            `Read-only preview · ${(document.offset / 1_048_576).toFixed(1)}${document.size ? ` / ${(document.size / 1_048_576).toFixed(1)}` : ""} MB${state.loading ? " · Loading…" : document.eof ? " · All text loaded" : " · Scroll to load more"}`}
        </span>
        {state.error ? (
          <button type="button" onClick={() => void loadMore()}>
            Retry
          </button>
        ) : !document.eof && !state.loading ? (
          <button type="button" onClick={() => void loadMore()}>
            Load more
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {document.offset > 0 || document.eof ? (
          <NativeCodeEditor
            session={document.session}
            path={path}
            active={active}
            readOnly
            onReady={onReady}
            onViewportChange={nearEnd}
          />
        ) : null}
      </div>
    </div>
  );
}
