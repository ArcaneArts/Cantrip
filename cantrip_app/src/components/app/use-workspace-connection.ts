import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { bootstrapWorkspace } from "@/lib/workspace-bootstrap";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import {
  emptyWorkspaceSelection,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";
import type { WorkspacePresentationState } from "@/lib/workspace-presentation-store";

type Connection = Awaited<ReturnType<typeof bootstrapWorkspace>>;
const emptyPresentation: WorkspacePresentationState = {
  presentation: null,
  loadingLabels: false,
  error: null,
};
const subscribeSession = (listener: () => void) =>
  onClientSessionIdentityChanged(listener);
const sessionKey = () => JSON.stringify(getClientSessionIdentitySnapshot());
const noSubscription = () => () => {};
const emptySnapshot = () => emptyPresentation;
const noController = () => null;
export const WORKSPACE_REFRESH_INTERVAL_MS = 5_000;

/** Owns exactly one project/window/session connection. Selection is only a seed
 * observation; changing tabs or responsive layout must not reconnect ownership. */
export function useWorkspaceConnection(
  projectId: string | null,
  selection: WorkspaceSelection,
  nativeWindowId?: string,
  connect = bootstrapWorkspace,
) {
  const identity = useSyncExternalStore(
    subscribeSession,
    sessionKey,
    sessionKey,
  );
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([projectId, nativeWindowId, identity, attempt]);
  const activeKey = useRef(key);
  activeKey.current = key;
  const seedSelection = useRef(selection);
  seedSelection.current = selection;
  const [state, setState] = useState<{
    key: string;
    connection?: Connection;
    error?: unknown;
  }>({ key });
  useEffect(() => {
    let cancelled = false;
    let connection: Connection | undefined;
    setState({ key });
    if (projectId && identity !== "null") {
      void connect(projectId, seedSelection.current, nativeWindowId).then(
        (result) => {
          if (cancelled || sessionKey() !== identity) {
            result.dispose();
            return;
          }
          connection = result;
          setState({ key, connection: result });
        },
        (error: unknown) => {
          if (!cancelled && sessionKey() === identity) setState({ key, error });
        },
      );
    }
    return () => {
      cancelled = true;
      connection?.dispose();
    };
  }, [key, projectId, nativeWindowId, identity, connect]);
  // Do not expose the old connection for one render while effect cleanup waits.
  const current = state.key === key ? state : undefined;
  const connection = current?.connection;
  const presentation = useSyncExternalStore(
    connection?.presentation.subscribe ?? noSubscription,
    connection?.presentation.getSnapshot ?? emptySnapshot,
    connection?.presentation.getSnapshot ?? emptySnapshot,
  );
  const controllerState = useSyncExternalStore(
    connection?.controller.subscribe ?? noSubscription,
    connection?.controller.getSnapshot ?? noController,
    connection?.controller.getSnapshot ?? noController,
  );
  useEffect(() => {
    if (!connection || controllerState?.disposed) return;
    const refresh = () => {
      if (activeKey.current !== key || sessionKey() !== identity) return;
      void connection.controller.refresh().catch(() => {
        // The controller retains a separate read error without losing layout
        // or retrying commands with uncertain outcomes.
      });
    };
    const timer = setInterval(refresh, WORKSPACE_REFRESH_INTERVAL_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refresh);
      window.addEventListener("online", refresh);
    }
    return () => {
      clearInterval(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", refresh);
        window.removeEventListener("online", refresh);
      }
    };
  }, [connection, controllerState?.disposed, identity, key]);
  const workspaceSelection = useMemo(
    () =>
      presentation.presentation?.selection ??
      emptyWorkspaceSelection(projectId),
    [presentation.presentation, projectId],
  );
  const setSelection = useCallback(
    (
      update:
        | WorkspaceSelection
        | ((current: WorkspaceSelection) => WorkspaceSelection),
    ) => {
      // Event handlers can outlive a render or be retained by native listeners.
      // Fence before executing functional updates, not only before transport.
      if (activeKey.current !== key || sessionKey() !== identity)
        return Promise.reject(
          new Error("Workspace selection context changed."),
        );
      if (!connection)
        return Promise.reject(new Error("Workspace connection is not ready."));
      return connection.controller.updateSelection(update);
    },
    [connection, identity, key],
  );
  const retry = useCallback(() => {
    if (activeKey.current !== key || sessionKey() !== identity) return;
    if (connection && !connection.controller.getSnapshot().disposed) {
      // Preserve uncertain sent operations and their idempotency IDs.
      connection.controller.retry();
      connection.presentation.retryLabels();
      void connection.controller.refresh().catch(() => {});
    } else setAttempt((value) => value + 1);
  }, [connection, identity, key]);
  const refresh = useCallback(() => {
    if (activeKey.current !== key || sessionKey() !== identity) return;
    void connection?.controller.refresh().catch(() => {});
  }, [connection, identity, key]);
  const retryCommand = useCallback(() => {
    if (activeKey.current !== key || sessionKey() !== identity) return;
    connection?.controller.retry();
  }, [connection, identity, key]);
  const retryLabels = useCallback(() => {
    if (activeKey.current !== key || sessionKey() !== identity) return;
    connection?.presentation.retryLabels();
  }, [connection, identity, key]);
  return {
    connection,
    presentation,
    controllerState,
    workspaceSelection,
    setSelection,
    error: current?.error ?? null,
    loading: Boolean(
      projectId && identity !== "null" && !connection && !current?.error,
    ),
    retry,
    refresh,
    retryCommand,
    retryLabels,
  };
}
