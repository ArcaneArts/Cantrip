import { appLiveScopeKey, type AppLiveScope } from "@cantrip/protocol";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";

import {
  AppLiveClient,
  type AppLiveClientStatus,
  type ClientControlHandler,
} from "@/lib/app-live-client";

const AppLiveContext = createContext<AppLiveClient | null>(null);

export function AppLiveProvider({
  children,
  client,
}: PropsWithChildren<{ client: AppLiveClient }>) {
  return (
    <AppLiveContext.Provider value={client}>{children}</AppLiveContext.Provider>
  );
}

export function useAppLiveScope(scope: AppLiveScope | null): void {
  const client = useContext(AppLiveContext);
  const scopeKey = scope ? appLiveScopeKey(scope) : null;
  useEffect(() => {
    if (!client || !scope) return;
    return client.retainScope(scope);
  }, [client, scopeKey]);
}

export function useAppLiveStatus(): AppLiveClientStatus {
  const client = useContext(AppLiveContext);
  const [status, setStatus] = useState<AppLiveClientStatus>(
    () => client?.status() ?? "stopped",
  );
  useEffect(() => {
    if (!client) return;
    return client.subscribeStatus(setStatus);
  }, [client]);
  return status;
}

export function useAppLiveClientControl(handler: ClientControlHandler): void {
  const client = useContext(AppLiveContext);
  useEffect(() => {
    if (!client) return;
    return client.registerClientControlHandler(handler);
  }, [client, handler]);
}
