import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  RemoteSurfaceChannel,
  RemoteSurfaceViewport,
} from "@cantrip/protocol";
import type { RemoteSurfaceStreamKind } from "@cantrip/protocol/remote-surface-stream";

import {
  RemoteSurfaceWorkerLinkClient,
  remoteSurfaceWorkerLinkRouteLabel,
  type RemoteSurfaceWorkerLinkConnectionState,
  type RemoteSurfaceWorkerLinkFrameContext,
  type RemoteSurfaceWorkerLinkInboundFrame,
  type RemoteSurfaceWorkerLinkMessages,
  type RemoteSurfaceWorkerLinkRoutes,
} from "@/lib/remote-surface-worker-link";

export interface UseRemoteSurfaceWorkerLinkOptions {
  enabled?: boolean;
  messages: RemoteSurfaceWorkerLinkMessages;
  onConnecting?(): void;
  onFrame(
    frame: RemoteSurfaceWorkerLinkInboundFrame,
    context: RemoteSurfaceWorkerLinkFrameContext,
  ): Promise<void> | void;
  onReady?(routes: RemoteSurfaceWorkerLinkRoutes): void;
  streamKind: RemoteSurfaceStreamKind;
  surfaceId: string;
  surfaceKind?: string;
  viewport(): RemoteSurfaceViewport;
  workerId: string;
}

export interface UseRemoteSurfaceWorkerLinkResult {
  activeRoute: string | null;
  activeRoutes: RemoteSurfaceWorkerLinkRoutes | null;
  connectionState: RemoteSurfaceWorkerLinkConnectionState;
  error: string | null;
  retry(): void;
  sendFrame(channel: RemoteSurfaceChannel, payload: Uint8Array): boolean;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useRemoteSurfaceWorkerLink(
  options: UseRemoteSurfaceWorkerLinkOptions,
): UseRemoteSurfaceWorkerLinkResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clientRef = useRef<RemoteSurfaceWorkerLinkClient | null>(null);
  const [connectionState, setConnectionState] =
    useState<RemoteSurfaceWorkerLinkConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [activeRoutes, setActiveRoutes] =
    useState<RemoteSurfaceWorkerLinkRoutes | null>(null);

  useEffect(() => {
    if (options.enabled === false) {
      clientRef.current?.close();
      clientRef.current = null;
      setActiveRoutes(null);
      return;
    }
    let client: RemoteSurfaceWorkerLinkClient;
    client = new RemoteSurfaceWorkerLinkClient({
      messages: options.messages,
      streamKind: options.streamKind,
      surfaceId: options.surfaceId,
      surfaceKind: options.surfaceKind,
      workerId: options.workerId,
      viewport: () => optionsRef.current.viewport(),
      onConnecting: () => {
        setActiveRoutes(null);
        optionsRef.current.onConnecting?.();
      },
      onConnectionState: setConnectionState,
      onError: setError,
      onFrame: (frame, context) =>
        optionsRef.current.onFrame(frame, {
          isCurrent: () => clientRef.current === client && context.isCurrent(),
          reportError: context.reportError,
        }),
      onReady: (routes) => {
        if (clientRef.current !== client) return;
        setActiveRoutes(routes);
        optionsRef.current.onReady?.(routes);
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      if (clientRef.current === client) clientRef.current = null;
      client.close();
    };
  }, [
    options.enabled,
    options.streamKind,
    options.surfaceId,
    options.surfaceKind,
    options.workerId,
  ]);

  const retry = useCallback(() => clientRef.current?.retry(), []);
  const sendFrame = useCallback(
    (channel: RemoteSurfaceChannel, payload: Uint8Array) =>
      clientRef.current?.send(channel, payload) ?? false,
    [],
  );

  return {
    activeRoute: remoteSurfaceWorkerLinkRouteLabel(activeRoutes),
    activeRoutes,
    connectionState,
    error,
    retry,
    sendFrame,
    setError,
  };
}
