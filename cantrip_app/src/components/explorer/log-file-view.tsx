import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExplorerLogTail,
  LogTailCursor,
} from "@cantrip/protocol/surface-stream";
import { NativeCodeEditor } from "@/components/editor/native-code-editor";
import { LogTailDocument } from "./log-tail-document";

export function LogFileView({
  path,
  active,
  staging = false,
  readTail,
  onReady,
  onError,
}: {
  path: string;
  active: boolean;
  /** Restore one snapshot before a window handoff commits ownership. */
  staging?: boolean;
  readTail(cursor?: LogTailCursor): Promise<ExplorerLogTail>;
  onReady?(): void;
  onError?(error: unknown): void;
}) {
  const [model] = useState(() => new LogTailDocument(path));
  const [following, setFollowing] = useState(true);
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState("");
  const [, redraw] = useState(0);
  const refs = useRef({ readTail, onError, error, active, staging });
  refs.current = { readTail, onError, error, active, staging };
  const followingRef = useRef(true);
  const inFlight = useRef<Promise<ExplorerLogTail> | null>(null);
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (
      !following ||
      (!active && !(staging && !model.loaded)) ||
      (!visible && !staging)
    )
      return;
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canRead = () =>
      !retired &&
      followingRef.current &&
      ((refs.current.active && document.visibilityState !== "hidden") ||
        (refs.current.staging && !model.loaded));
    const poll = async () => {
      try {
        if (inFlight.current) await inFlight.current.catch(() => undefined);
        if (!canRead()) return;
        const request = refs.current.readTail(model.cursor);
        inFlight.current = request;
        let result: ExplorerLogTail;
        try {
          result = await request;
        } finally {
          if (inFlight.current === request) inFlight.current = null;
        }
        if (!canRead()) return;
        if (model.accept(result)) redraw((value) => value + 1);
        if (refs.current.error) setError("");
        if (refs.current.active) timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!canRead()) return;
        setError(
          error instanceof Error ? error.message : "Could not follow this log.",
        );
        refs.current.onError?.(error);
      }
    };
    void poll();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [active, staging, following, visible, epoch, model]);
  const scrollChanged = useCallback((atBottom: boolean) => {
    followingRef.current = atBottom;
    setFollowing(atBottom);
  }, []);
  const pause = () => {
    followingRef.current = false;
    setFollowing(false);
  };
  const resume = () => {
    followingRef.current = true;
    setError("");
    setFollowing(true);
    setEpoch((value) => value + 1);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-log-file-view>
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground">
        <span role="status">
          {error ||
            (!model.loaded
              ? "Loading log…"
              : following
                ? "Following log · Latest output"
                : "Paused · Scroll to the bottom to follow")}
        </span>
        <button type="button" onClick={error || !following ? resume : pause}>
          {error ? "Retry" : following ? "Pause following" : "Follow log"}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {model.loaded ? (
          <NativeCodeEditor
            session={model.session}
            path={path}
            active={active}
            readOnly
            followEnd={following}
            onScrollPositionChange={scrollChanged}
            onReady={onReady}
          />
        ) : null}
      </div>
    </div>
  );
}
