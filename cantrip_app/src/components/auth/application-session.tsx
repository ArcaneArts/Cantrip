import type {
  AuthSession,
  ServerBootstrap,
  UserSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  AlertCircle,
  Loader2,
  LockKeyhole,
  Server,
  WandSparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { ServerSwitcher } from "@/components/servers/server-switcher";
import { AddServerForm } from "@/components/servers/add-server-form";
import { MobileSignInScanner } from "@/components/auth/mobile-sign-in-scanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAuthSession,
  getServerBootstrap,
  login,
  registerAccount,
} from "@/lib/api";
import { AppLiveClient, appLiveWebSocketUrl } from "@/lib/app-live-client";
import { AppLiveQueryBridge } from "@/lib/app-live-query";
import { AppLiveProvider } from "@/lib/app-live-react";
import {
  clearClientSession,
  notifyAuthenticationRequired,
  onAuthenticationRequired,
  setClientSession,
} from "@/lib/client-session";
import { errorMessage } from "@/lib/error-message";
import {
  getActiveServerConnection,
  selectServerConnection,
  type ServerConnectionFailureKind,
} from "@/lib/server-connections";
import { router } from "@/router";

type ApplicationSessionState =
  | { kind: "loading" }
  | { kind: "server-required" }
  | {
      kind: "connection-error";
      failureKind: ServerConnectionFailureKind;
      message: string;
    }
  | {
      kind: "signed-out";
      bootstrap: ServerBootstrap;
      notice: string | null;
    }
  | {
      kind: "authenticated";
      bootstrap: ServerBootstrap;
      csrfToken: string | null;
      expiresAt: string | null;
      user: UserSummary;
    };

function connectionFailure(
  error: unknown,
): Extract<ApplicationSessionState, { kind: "connection-error" }> {
  const message = errorMessage(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : null;
  const failureKind: ServerConnectionFailureKind =
    status === 401 || status === 403
      ? "authentication"
      : status === 404 || status === 426
        ? "version"
        : (error instanceof Error && error.name === "ZodError") ||
            /protocol|parse|compatible|version/i.test(message)
          ? "compatibility"
          : /certificate|ssl|tls/i.test(message)
            ? "tls"
            : "network";
  return { kind: "connection-error", failureKind, message };
}

async function loadApplicationSession(): Promise<ApplicationSessionState> {
  clearClientSession();
  if (!getActiveServerConnection()) return { kind: "server-required" };
  const bootstrap = await getServerBootstrap();
  if (bootstrap.auth.mode === "none") {
    if (!bootstrap.auth.currentUser) {
      throw new Error("The local server did not provide its anonymous user.");
    }
    return {
      kind: "authenticated",
      bootstrap,
      csrfToken: null,
      expiresAt: null,
      user: bootstrap.auth.currentUser,
    };
  }
  const session = await getAuthSession();
  if (!session.currentUser || !session.csrfToken) {
    return { kind: "signed-out", bootstrap, notice: null };
  }
  return {
    kind: "authenticated",
    bootstrap,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user: session.currentUser,
  };
}

function sessionState(
  bootstrap: ServerBootstrap,
  session: AuthSession,
): ApplicationSessionState {
  return {
    kind: "authenticated",
    bootstrap,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user: session.currentUser,
  };
}

function SessionFrame({ children }: { children: React.ReactNode }) {
  const active = getActiveServerConnection();
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md space-y-6">
        <header className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border bg-card">
            <WandSparkles className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-semibold">Cantrip</span>
            <span className="block truncate text-xs text-muted-foreground">
              {active
                ? `${active.name} · ${active.url || "Local development server"}`
                : "Remote server required"}
            </span>
          </span>
        </header>
        {children}
      </section>
    </main>
  );
}

function ServerSetupScreen({ onConnected }: { onConnected(): void }) {
  return (
    <SessionFrame>
      <div className="space-y-6 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <Server className="size-4" />
          </span>
          <div>
            <h1 className="font-semibold">Connect to a Cantrip server</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Browser and mobile apps are clients only. Add the address of a
              Cantrip Server running on another device to continue.
            </p>
          </div>
        </div>
        <AddServerForm
          autoFocus
          onSaved={async (connection) => {
            await selectServerConnection(connection.id);
            clearClientSession();
            onConnected();
          }}
          submitLabel="Save and connect"
        />
      </div>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        Enter the server origin, such as https://cantrip.example, without an API
        path.
      </p>
    </SessionFrame>
  );
}

function ConnectionErrorScreen({
  failureKind,
  message,
  onRetry,
}: {
  failureKind: ServerConnectionFailureKind;
  message: string;
  onRetry(): void;
}) {
  const label =
    failureKind === "tls"
      ? "Secure connection failed"
      : failureKind === "compatibility" || failureKind === "version"
        ? "Incompatible server"
        : failureKind === "authentication"
          ? "Authentication failed"
          : "Server unavailable";
  return (
    <SessionFrame>
      <div className="space-y-5 rounded-2xl border bg-card p-6">
        <div className="flex gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h1 className="font-semibold">{label}</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {message}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onRetry}>Try again</Button>
          <div className="min-w-0 flex-1">
            <ServerSwitcher
              currentUserName="Choose another server"
              workerName="Connection unavailable"
            />
          </div>
        </div>
        <MobileSignInScanner className="w-full" />
      </div>
    </SessionFrame>
  );
}

function AuthenticationScreen({
  bootstrap,
  notice,
  onAuthenticated,
}: {
  bootstrap: ServerBootstrap;
  notice: string | null;
  onAuthenticated(session: AuthSession): void;
}) {
  const accounts = bootstrap.auth.mode === "accounts";
  const canRegister = accounts && bootstrap.auth.registration.enabled;
  const [registering, setRegistering] = useState(
    canRegister && bootstrap.auth.registration.bootstrapRequired,
  );
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (registering && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const session = registering
        ? await registerAccount(
            { displayName, email, password },
            bootstrap.auth.registration.bootstrapRequired
              ? bootstrapToken
              : undefined,
          )
        : await login({
            ...(accounts ? { email } : {}),
            password,
          });
      onAuthenticated(session);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SessionFrame>
      <div className="rounded-2xl border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <LockKeyhole className="size-4" />
          </span>
          <div>
            <h1 className="font-semibold">
              {registering
                ? "Create the first Cantrip account"
                : accounts
                  ? "Sign in to Cantrip"
                  : "Unlock this Cantrip server"}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {accounts
                ? bootstrap.auth.registration.licenseRequired && registering
                  ? "Your email must be licensed by this server's administrator before you can create an account."
                  : "Your projects, agents, and workers remain isolated on this server."
                : "Enter the password configured by this server's operator."}
            </p>
          </div>
        </div>

        {notice ? (
          <p className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm">{notice}</p>
        ) : null}

        <form className="space-y-4" onSubmit={submit}>
          {registering ? (
            <label className="grid gap-1.5 text-sm">
              Display name
              <Input
                autoComplete="name"
                autoFocus
                onChange={(event) => setDisplayName(event.target.value)}
                required
                value={displayName}
              />
            </label>
          ) : null}
          {accounts ? (
            <label className="grid gap-1.5 text-sm">
              Email
              <Input
                autoComplete="email"
                autoFocus={!registering}
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
          ) : null}
          <label className="grid gap-1.5 text-sm">
            Password
            <Input
              autoComplete={registering ? "new-password" : "current-password"}
              autoFocus={!accounts}
              minLength={registering ? 12 : undefined}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {registering ? (
            <label className="grid gap-1.5 text-sm">
              Confirm password
              <Input
                autoComplete="new-password"
                minLength={12}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                type="password"
                value={confirmation}
              />
            </label>
          ) : null}
          {registering && bootstrap.auth.registration.bootstrapRequired ? (
            <label className="grid gap-1.5 text-sm">
              First-admin bootstrap token
              <Input
                autoComplete="off"
                onChange={(event) => setBootstrapToken(event.target.value)}
                required
                type="password"
                value={bootstrapToken}
              />
            </label>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button className="w-full" disabled={submitting} type="submit">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {registering ? "Create account" : "Continue"}
          </Button>
        </form>

        {!registering ? <MobileSignInScanner className="mt-3 w-full" /> : null}

        <div className="mt-4 flex items-center justify-between gap-3 text-xs">
          {canRegister && !bootstrap.auth.registration.bootstrapRequired ? (
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setError(null);
                setRegistering((value) => !value);
              }}
              type="button"
            >
              {registering ? "Use an existing account" : "Create an account"}
            </button>
          ) : (
            <span />
          )}
          <div className="min-w-0 max-w-52">
            <ServerSwitcher
              currentUserName="Switch server"
              workerName="Sign-in required"
            />
          </div>
        </div>
      </div>
      <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
        <Server className="size-3.5" /> Passwords and session credentials are
        never saved by the app.
      </p>
    </SessionFrame>
  );
}

function AuthenticatedApplication({
  bootstrap,
  user,
}: {
  bootstrap: ServerBootstrap;
  user: UserSummary;
}) {
  const serverUrl = getActiveServerConnection()?.url ?? "";
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { refetchOnWindowFocus: false } },
    });
    client.setQueryData(["server-bootstrap"], bootstrap);
    return client;
  }, [bootstrap.server.id, user.id]);
  const liveClient = useMemo(() => {
    const queryBridge = new AppLiveQueryBridge(queryClient);
    const clientIdKey = "cantrip.app-live.client-id.v1";
    let clientId = window.localStorage.getItem(clientIdKey);
    if (!clientId) {
      clientId = crypto.randomUUID();
      window.localStorage.setItem(clientIdKey, clientId);
    }
    return new AppLiveClient({
      client: { id: clientId, name: "Cantrip App", version: "0.0.0" },
      onAuthenticationRequired: notifyAuthenticationRequired,
      onEvent: (event) => queryBridge.handleEvent(event),
      onProtocolError: (error) => {
        console.error("Cantrip live protocol error", error);
      },
      onResync: (scopes, reason) => queryBridge.recoverScopes(scopes, reason),
      storage: window.localStorage,
      storageKey: `cantrip.app-live.resume.v1.${bootstrap.server.id}.${user.id}`,
      url: appLiveWebSocketUrl(serverUrl, window.location.origin),
    });
  }, [bootstrap.server.id, queryClient, serverUrl, user.id]);

  useEffect(() => {
    const releaseScope = liveClient.retainScope({ kind: "current-user" });
    liveClient.start();
    const reconnect = () => liveClient.reconnectNow();
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      releaseScope();
      liveClient.stop();
      queryClient.clear();
    };
  }, [liveClient, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppLiveProvider client={liveClient}>
        <RouterProvider router={router} />
      </AppLiveProvider>
    </QueryClientProvider>
  );
}

export function ApplicationSession() {
  const [state, setState] = useState<ApplicationSessionState>({
    kind: "loading",
  });

  const refresh = useCallback(() => {
    setState({ kind: "loading" });
    void loadApplicationSession().then(
      (next) => {
        if (next.kind === "authenticated") {
          setClientSession({
            authMode: next.bootstrap.auth.mode,
            csrfToken: next.csrfToken,
            expiresAt: next.expiresAt,
            serverId: next.bootstrap.server.id,
            user: next.user,
          });
        }
        setState(next);
      },
      (error) => setState(connectionFailure(error)),
    );
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (state.kind !== "connection-error") return;
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [refresh, state.kind]);
  useEffect(
    () =>
      onAuthenticationRequired((reason) => {
        clearClientSession();
        setState((current) =>
          current.kind === "authenticated" &&
          current.bootstrap.auth.mode !== "none"
            ? {
                kind: "signed-out",
                bootstrap: current.bootstrap,
                notice: reason,
              }
            : current,
        );
      }),
    [],
  );
  if (state.kind === "loading") {
    return (
      <SessionFrame>
        <div className="flex items-center justify-center gap-3 rounded-2xl border bg-card p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Connecting to Cantrip…
        </div>
      </SessionFrame>
    );
  }
  if (state.kind === "connection-error") {
    return <ConnectionErrorScreen {...state} onRetry={refresh} />;
  }
  if (state.kind === "server-required") {
    return <ServerSetupScreen onConnected={refresh} />;
  }
  if (state.kind === "signed-out") {
    return (
      <AuthenticationScreen
        bootstrap={state.bootstrap}
        notice={state.notice}
        onAuthenticated={(session) => {
          const next = sessionState(state.bootstrap, session);
          if (next.kind === "authenticated") {
            setClientSession({
              authMode: next.bootstrap.auth.mode,
              csrfToken: next.csrfToken,
              expiresAt: next.expiresAt,
              serverId: next.bootstrap.server.id,
              user: next.user,
            });
          }
          setState(next);
        }}
      />
    );
  }
  return (
    <AuthenticatedApplication bootstrap={state.bootstrap} user={state.user} />
  );
}
