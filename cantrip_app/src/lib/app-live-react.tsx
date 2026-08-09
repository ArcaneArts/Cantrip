import { appLiveScopeKey, type AppLiveScope } from "@cantrip/protocol";
import {
  createContext,
  useContext,
  useEffect,
  type PropsWithChildren,
} from "react";

import { AppLiveClient } from "@/lib/app-live-client";

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
